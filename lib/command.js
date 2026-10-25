/**
 * `/foreman` 的原生命令入口。
 *
 * 先说清楚为什么要走 `commands` 而不是只注册 skill：
 *
 * - skill（`ctx.skills.register`）的正文由宿主注入，省事，但菜单里只有英文 id，
 *   没有「旁问 btw」那种中文标题——插件说了不算。
 * - command（`ctx.commands.register`）有标题、有输入提示，能进 `/` 菜单的前排，
 *   但 handler 只能返回给界面看的文字，**没法把指令送进模型**。
 *
 * 两边各缺一半，所以这里用 commands 的 `agent.steer()` 补上：命令触发时把「四步流程
 * + 用户这句派单内容」当成一条用户消息塞进当前回合。dsh-cursor-dev 的 `/cursor-subagent`
 * 就是这么做的（先跑子智能体，再把结果 steer 回去让父模型审查），走的是同一条宿主 API。
 *
 * 没有 commands 服务的宿主（无头 profile）会静默跳过，调用方退回 skill 入口。
 *
 * @module dsh-agent-foreman/command
 */

import { foremanSkillContent, languageOf } from './skill.js';

/** 命令名：宿主只接受小写字母、数字与连字符。 */
export const COMMAND_NAME = 'foreman';

/** 一句话说明，显示在 `/` 菜单右侧。 */
const COMMAND_DESCRIPTION = '把任务拆成工单交给名册里的承包商各自干，父智能体最后逐单验收';

const USAGE = '用法：/foreman 把 A 抽成共享逻辑；给 B 补回归测试';

/**
 * 拼出要塞进本回合的那条消息：流程正文 + 用户实际派单内容。
 *
 * @param rawInput - 用户敲在 `/foreman` 后面的原话。
 * @param lang - 界面语言。
 * @returns 消息正文。
 */
export function foremanSteerText(rawInput, lang) {
    const body = foremanSkillContent(lang);
    return [
        body,
        '',
        '【本轮用户派单内容】（已由 /foreman 命令提供，不要再问他一遍）',
        rawInput.trim(),
    ].join('\n');
}

/**
 * 构造一条普通用户消息，和宿主自己提交的输入同形。
 *
 * @param text - 正文。
 * @returns 冻结的消息对象。
 */
function userMessage(text) {
    const message = {
        id: globalThis.crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
    };
    Object.freeze(message.content[0]);
    Object.freeze(message.content);
    Object.freeze(message);
    return message;
}

/**
 * 在宿主上注册 `/foreman` 命令。
 *
 * @param ctx - cordis 上下文。
 * @param options - 可选的 logger。
 * @returns 释放函数；宿主没有 commands 服务时返回 `undefined`。
 */
export function registerForemanCommand(ctx, options = {}) {
    const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined;
    if (commands === undefined || typeof commands.register !== 'function')
        return undefined;
    const logger = options.logger;
    return commands.register({
        name: COMMAND_NAME,
        description: COMMAND_DESCRIPTION,
        input: { hint: '把要派的活写在这里，分号或换行分段' },
        handler: (invocation) => {
            const rawInput = typeof invocation?.rawInput === 'string' ? invocation.rawInput : '';
            if (rawInput.trim() === '')
                return { kind: 'error', text: USAGE };
            const agent = invocation?.agent;
            if (agent === undefined || typeof agent.steer !== 'function')
                return { kind: 'error', text: '这个位置没有可用的会话，/foreman 要在对话里用' };
            try {
                agent.steer(userMessage(foremanSteerText(rawInput, languageOf(ctx))));
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger?.warn?.(`dsh-agent-foreman: /foreman 注入失败 — ${message}`);
                return { kind: 'error', text: `派单指令没能送进当前会话：${message}` };
            }
            logger?.info?.(`dsh-agent-foreman: /foreman 已接管本轮（${rawInput.trim().length} 字）`);
            return { kind: 'success', text: '已交给包工头：先看名册，再拆单派下去，最后逐单验收。' };
        },
    });
}
