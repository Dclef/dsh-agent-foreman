/**
 * dsh-agent-foreman —「包工头」。
 *
 * 一句话：父智能体派单，承包商子智能体干活（每人可单独指定 provider / 模型 /
 * 思考等级），产物回流成一块共享看板，父智能体逐个验收、不合格打回返工。
 *
 * ## 为什么不是"专家团"
 *
 * 宿主自带的智能体团队（`@deepseek-ai/dsh-experimental-agent-team`）里，队员只有
 * 名字、描述和提示词——真正决定"谁干活"的模型不可选：所有队员都跑父会话的模型，
 * 于是"多招几个人"只是多花 token 买同一颗脑子。Agency 那类"领域专家"更远一层：
 * 专家是 persona 模板，用户其实不知道自己买的是哪个模型。
 *
 * 本插件把身份换成了**路由**：承包商 = 名字 + provider/模型/思考等级。名册是用户
 * 在设置页里填的，派单时逐单套用。这样"派给便宜的、快的、或者更强的那一档"真的
 * 会发生，而不是换一段提示词。
 *
 * ## 为什么只有四个工具
 *
 * 父模型要做的只有两件事：拆单、验收。其余能力（指定 persona、工具白名单、
 * 后台续跑、跨轮次持久派遣）都会让"这一轮到底做完了没有"变得含糊。看板是
 * 一次派单的结果快照，跟着工具返回走，不留在宿主里假装还在跑。
 *
 * ## 组成
 *
 * - `lib/store.js`   名册（roster.json）与台账（runs.jsonl）的持久化；
 * - `lib/catalog.js` 从宿主 `llm` 服务读真实模型目录；
 * - `lib/engine.js`  并发派单、超时、拓扑分层、返工；
 * - `lib/tools.js`   四个工具的定义与描述（这是父模型看的契约）；
 * - `lib/routes.js`  设置页与 JSON 接口（带跨站防护）；
 * - `lib/page.js`    设置页本体（纯 HTML，无构建）；
 * - `lib/client.js`  浏览器侧：把设置页放进「设置 → 包工头」。
 *
 * @module dsh-agent-foreman
 */
import z from '@deepseek-ai/schemastery';
import { ForemanStore, resolveDataDir } from './store.js';
import { SKILL_DESCRIPTION, SKILL_NAME, SKILL_SOURCE, foremanSkillContent, languageOf } from './skill.js';
import { ForemanEngine } from './engine.js';
import { registerForemanCommand } from './command.js';
import { foremanTools } from './tools.js';
import { mountRoutes } from './routes.js';

export const name = 'dsh-agent-foreman';

/**
 * 必需服务：工具注册表。
 *
 * `subagents` / `webServer` / `llm` 都**不**列在这里——它们在调用点按需读取，
 * 这样即使某个宿主没有 webServer（无头 profile），派单工具仍然可用；没有
 * llm 时设置页退化成手填模型 id，而不是整块插件不加载。
 */
export const inject = ['tools'];

export const Config = z.object({
    /**
     * 数据目录覆盖。留空走 `%LOCALAPPDATA%\dsh-agent-foreman`。
     * 名册是跨 profile 共享的：换一个 profile 不该丢掉队伍。
     */
    dataDir: z.string().default(''),
    /**
     * 首次安装时预置的承包商。只在名册文件为空时写入，之后以设置页为准。
     * 例：`[{ name: 'coder', provider: 'deepseek-official', model: 'deepseek-flash' }]`
     */
    members: z.array(z.object({
        name: z.string(),
        provider: z.string().default(''),
        model: z.string().default(''),
        reasoningEffort: z.string().default(''),
        enabled: z.boolean().default(true),
        note: z.string().default(''),
    })).default([]),
});

/**
 * 挂载插件。
 * @param ctx - cordis 上下文。
 * @param config - 已解析的插件配置。
 */
export function apply(ctx, config) {
    const logger = ctx.logger;
    const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : '';
    const dataDir = configured !== '' ? configured : resolveDataDir(ctx.get('baseDir'));
    const store = new ForemanStore(dataDir);

    // 首次安装的种子名册：名册为空才写，避免覆盖用户在设置页里的改动。
    if (Array.isArray(config?.members) && config.members.length > 0 && store.members().length === 0) {
        try {
            store.saveMembers(config.members);
            logger?.info?.(`dsh-agent-foreman: 从插件配置写入了 ${config.members.length} 个承包商`);
        }
        catch (error) {
            logger?.warn?.(`dsh-agent-foreman: 预置名册无效 — ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    const engine = new ForemanEngine({ ctx, store, logger });
    const tools = ctx.get('tools');
    const disposers = [];
    for (const definition of foremanTools({ ctx, store, engine, logger })) {
        try {
            disposers.push(tools.register(definition));
        }
        catch (error) {
            // 单个工具注册失败不该带走其它三个，更不该带走设置页。
            logger?.error?.(`dsh-agent-foreman: 注册工具 ${definition.name} 失败 — ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    ctx.effect(() => () => {
        for (const dispose of disposers) {
            try {
                dispose?.();
            }
            catch {
                // 卸载期重复释放可以忽略。
            }
        }
        disposers.length = 0;
    });

    // `/foreman` 入口：优先注册原生命令（菜单里有标题、能进前排，靠 agent.steer 把
    // 指令送进本回合）；宿主没有 commands 服务时退回 skill（正文由宿主注入，省事但只有 id）。
    const commandRelease = registerForemanCommand(ctx, { logger });
    if (commandRelease !== undefined) {
        ctx.effect(() => commandRelease);
    }
    else {
        ctx.inject(['skills'], (skillCtx) => {
            const service = skillCtx.skills;
            if (typeof service?.register !== 'function')
                return undefined;
            const release = service.register({
                name: SKILL_NAME,
                description: SKILL_DESCRIPTION,
                // source 必须给：宿主在加载 skill 时才校验它，缺了会直接让本轮报错。
                source: SKILL_SOURCE,
                content: foremanSkillContent(languageOf(ctx)),
            });
            if (typeof release === 'function')
                skillCtx.effect(() => release);
            return undefined;
        });
    }

    // HTTP 表面单独一个依赖作用域：没有 webServer 的宿主仍然能派单。
    ctx.inject(['webServer'], (webCtx) => {
        const release = mountRoutes(webCtx, { store, engine, logger });
        webCtx.effect(() => release);
        return undefined;
    });

    const members = store.members();
    logger?.info?.(`dsh-agent-foreman: 名册 ${members.length} 人（启用 ${members.filter(member => member.enabled).length} 人），数据目录 ${dataDir}`);
}
