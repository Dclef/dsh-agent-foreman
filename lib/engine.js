/**
 * 包工头 · 派单引擎。
 *
 * 职责单一：把一组工单变成一组真实跑完的子智能体，再把产物收回来。它不知道
 * 工单从哪来（父模型写的），也不判断好坏（父模型验收），只保证四件事：
 *
 * 1. **承包商按名册路由**——每张工单落到一个承包商，模型/推理等级由名册决定，
 *    而不是父会话的模型。
 * 2. **有并发上限**——同一时刻在场的承包商不超过策略值，否则会撞宿主
 *    `maxActiveSubagents` 的 `ACTIVATION_LIMIT_REACHED`。
 * 3. **有硬超时**——墙钟到点就 abort + dispose，子智能体不会吊着一轮对话不放。
 * 4. **可打回**——验收不过的工单原样回到同一个承包商，附上反馈再干一次。
 *
 * 只用宿主公开的 `subagents.startActivation()`：它返回 `{ childId, result, dispose }`，
 * 其中 `result` 在子会话落定后 resolve 成 `{ output, stopReason, structured? }`。
 * 不碰 `agent/created` 钩子、不注入 persona——承包商是"会干活的模型"，不是角色扮演。
 *
 * @module dsh-agent-foreman/engine
 */
import { ForemanError, sanitizeRunId } from './store.js';
import { readSubagentProviders } from './catalog.js';
import { createTeamRunner } from './team.js';

/**
 * 把宿主抛出的激活错误翻译成"父模型看了知道下一步做什么"的一句话。
 *
 * 最常见的是深度上限：父智能体自己就是某个子会话时，再派一次就超过
 * `maxDepth`。原始错误（`subagent depth 2 exceeds maxDepth 1`）足够排查，
 * 但父模型往往不知道能改哪个旋钮，所以附上可执行的提示。
 *
 * @param error - 捕获到的异常。
 * @returns 供看板展示的错误文本。
 */
function explainActivationError(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/maxDepth/i.test(message)) {
        return `${message}（提示：调用方自己就是子智能体，或策略里的最大嵌套层数太小。`
            + '从主会话直接派单，或在设置页把最大嵌套层数调到 2）';
    }
    if (/ACTIVATION_LIMIT_REACHED|maxActiveSubagents/i.test(message)) {
        return `${message}（提示：并行子智能体已达宿主上限，`
            + '调低 concurrency 或分两轮派单）';
    }
    return message;
}

const STOP_LABEL = {
    completed: '交付',
    aborted: '被中断',
    error: '出错',
    'max-tokens': '超长截断',
    refusal: '拒绝执行',
};

/** 工单 id 缺省时的前缀。 */
let orderSeq = 0;

/**
 * 看板里单份产物的字数上限。
 *
 * 这不是给用户调的旋钮：提示词要求承包商把摘要写在 2000 字以内，这个上限只是
 * "提示词没管住"时的兜底。真撞上时，完整正文已经落盘（store.writeArtifact），
 * 看板里只留前一段并标出总字数。
 */
const ARTIFACT_LIMIT = 20000;

/**
 * 从磁盘快照恢复时，未落定工单的说明。
 *
 * 这句话会出现在看板里、也会回到父模型手里：它必须说清"没跑"和"为什么"，
 * 否则父模型可能把一条中断记录当成失败结论去改代码。
 */
const INTERRUPTED_NOTE = '插件重启导致中断，未自动重跑';

/** 按会话找最近一轮时扫描的快照条数：够覆盖一轮对话里的正常量。 */
const SNAPSHOT_LIMIT = 50;
/** 按显式 runId 找时扫描得更深：用户可能回头调一个更早的派单。 */
const SNAPSHOT_SCAN = 200;

/** 一小段随机 id，够在一轮对话里区分运行即可。 */
function shortId(prefix) {
    return `${prefix}-${Math.random().toString(16).slice(2, 6)}`;
}

/**
 * 从 ContentBlock 数组里取纯文本。
 * @param output - 子智能体的最终输出。
 * @returns 拼好的文本，可能是空串。
 */
export function extractText(output) {
    if (!Array.isArray(output))
        return '';
    return output
        .filter(part => part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n')
        .trim();
}

/**
 * 子会话模型头读不到时的看板说明。
 *
 * 它只解释"为什么 actualRoute 是空的"：真实路由属于诊断信息，读不到不该让派单失败。
 */
const ROUTE_UNREADABLE_NOTE = '读不到子会话模型头';

/**
 * 从子会话头里读回**真实**使用的 provider / 模型 / 推理等级。
 *
 * 看板上的 `route` 是名册声明，回答"我让它用哪个模型"；这里读的是宿主给子会话
 * 记下的事实，回答"它到底用了哪个"。两条路都试一遍：
 *
 * 1. `sessions.get(childId).header`——普通激活创建出来的子会话就有；
 * 2. `agents.get(childId).session.header`——已经挂上 Agent 的会话（团队模式等）。
 *
 * 这是纯诊断：任何一步抛错都当作"读不到"，绝不上抛，免得影响派单本身。
 *
 * @param ctx - cordis 上下文。
 * @param childId - 子会话 id（`activation.childId`）。
 * @returns `{ provider, model, reasoningEffort }`；三条来源都读不到时返回 undefined。
 */
export function readChildRoute(ctx, childId) {
    const id = typeof childId === 'string' ? childId.trim() : '';
    if (id === '' || ctx === undefined || ctx === null || typeof ctx.get !== 'function')
        return undefined;
    const sources = [
        () => ctx.get('sessions')?.get?.(id)?.header,
        () => ctx.get('agents')?.get?.(id)?.session?.header,
    ];
    for (const headerOf of sources) {
        let header;
        try {
            header = headerOf();
        }
        catch {
            // 服务没就绪 / get 本身抛错：换下一条来源。
            continue;
        }
        const provider = typeof header?.provider === 'string' ? header.provider.trim() : '';
        const model = typeof header?.model === 'string' ? header.model.trim() : '';
        const reasoningEffort = typeof header?.reasoningEffort === 'string' ? header.reasoningEffort.trim() : '';
        if (provider !== '' || model !== '' || reasoningEffort !== '')
            return { provider, model, reasoningEffort };
    }
    return undefined;
}

/**
 * 把一次路由回显写进工单，并和名册声明比一比。
 *
 * 名册里 provider / model 都为空表示"跟随父会话"：这种单没有可比对的声明，
 * `routeMismatch` 恒为 false——否则等于把"我允许它继承"报成不一致。
 *
 * @param order - 工单（就地更新）。
 * @param route - {@link readChildRoute} 的结果。
 * @returns 是否读到了真实路由。
 */
function applyChildRoute(order, route) {
    if (route === undefined) {
        order.actualRoute = '';
        order.actualReasoningEffort = '';
        order.routeMismatch = false;
        order.routeNote = ROUTE_UNREADABLE_NOTE;
        return false;
    }
    const provider = typeof route.provider === 'string' ? route.provider.trim() : '';
    const model = typeof route.model === 'string' ? route.model.trim() : '';
    const member = order.member ?? {};
    const declaredProvider = typeof member.provider === 'string' ? member.provider.trim() : '';
    const declaredModel = typeof member.model === 'string' ? member.model.trim() : '';
    order.actualRoute = provider === '' && model === '' ? '' : `${provider}/${model}`;
    order.actualReasoningEffort = typeof route.reasoningEffort === 'string' ? route.reasoningEffort.trim() : '';
    // 读到了路由才谈得上"不一致"：actualRoute 为空表示没能确认子会话用了哪个模型，
    // 这时报不一致只会制造噪音。
    order.routeMismatch = declaredProvider !== '' && declaredModel !== ''
        && order.actualRoute !== ''
        && order.actualRoute !== `${declaredProvider}/${declaredModel}`;
    order.routeNote = '';
    return true;
}

/** 名字/岗位查找用的归一化：去空白、压小写。 */
function keyOf(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** 一个承包商声明了什么岗位（缺省时用名字兜底，和 store 的规范化一致）。 */
function roleOf(member) {
    const role = typeof member?.role === 'string' ? member.role.trim() : '';
    if (role !== '')
        return role;
    return typeof member?.name === 'string' ? member.name.trim() : '';
}

/**
 * 从名册里挑出可用于派单的承包商。
 *
 * 岗位匹配只认**启用的**实例：给一个岗位点名，落到停用的承包商上等于派给一个
 * 不存在的模型，所以过滤放在解析之前，而不是交给调度器。
 *
 * @param members - 名册。
 * @returns 启用成员。
 */
function enabledMembers(members) {
    return (Array.isArray(members) ? members : []).filter(member => member !== null && typeof member === 'object' && member.enabled !== false);
}

/**
 * 规范化一组工单。
 *
 * `dependsOn` 只支持同批次内的工单 id：跨批次的依赖在共享看板里没有意义，
 * 而且会让"一轮派单"这个原子单位变得含糊。
 *
 * @param raw - 原始工单数组。
 * @param members - 可选承包商（用来预校验 contractor 名字或岗位）。
 * @returns 规范化后的工单数组。
 */
export function normalizeOrders(raw, members = []) {
    if (!Array.isArray(raw) || raw.length === 0)
        throw new ForemanError('至少需要一张工单', 'NO_ORDERS');
    if (raw.length > 12)
        throw new ForemanError('一轮最多派 12 张工单；更多请拆成几轮，便于验收', 'TOO_MANY_ORDERS');
    const usable = enabledMembers(members);
    const known = new Set(usable.map(member => keyOf(member.id)).filter(key => key !== ''));
    const names = new Map(usable.map(member => [keyOf(member.name), member.id]).filter(([key]) => key !== ''));
    // 岗位也属于"能填的值"：派单时可以写岗位名，由 assignContractors 在实例间轮转。
    const roles = new Set(usable.map(roleOf).map(keyOf).filter(key => key !== ''));
    const choices = [...new Set(usable.flatMap(member => [
        typeof member.name === 'string' ? member.name.trim() : '',
        roleOf(member),
    ]).filter(value => value !== ''))];
    const seen = new Set();
    const orders = raw.map((entry, index) => {
        const item = typeof entry === 'object' && entry !== null ? entry : { task: String(entry) };
        const title = typeof item.title === 'string' && item.title.trim() !== ''
            ? item.title.trim()
            : `工单 ${index + 1}`;
        const task = typeof item.task === 'string' ? item.task.trim() : '';
        if (task === '')
            throw new ForemanError(`工单「${title}」缺少 task`, 'INVALID_ORDER');
        const id = typeof item.id === 'string' && item.id.trim() !== ''
            ? item.id.trim()
            : `W${++orderSeq}`;
        if (seen.has(id))
            throw new ForemanError(`工单 id 重复：「${id}」`, 'DUPLICATE_ORDER');
        seen.add(id);
        const contractor = typeof item.contractor === 'string' ? item.contractor.trim() : '';
        if (contractor !== '') {
            const key = keyOf(contractor);
            if (!known.has(key) && !names.has(key) && !roles.has(key))
                throw new ForemanError(`工单「${title}」指定的承包商「${contractor}」不在名册里。`
                    + `可填的名字或岗位：${choices.join('、') || '（名册为空，请先在设置页添加承包商）'}`, 'UNKNOWN_MEMBER');
        }
        const dependsOn = Array.isArray(item.dependsOn)
            ? item.dependsOn.map(dep => String(dep)).filter(dep => dep !== '')
            : [];
        return {
            id,
            title,
            task,
            accept: typeof item.accept === 'string' ? item.accept.trim() : '',
            // 原样留着：可能填的是名字、id 或岗位，真正的解析在 assignContractors 里做。
            contractor,
            dependsOn,
        };
    });
    for (const order of orders) {
        for (const dep of order.dependsOn) {
            if (!orders.some(other => other.id === dep))
                throw new ForemanError(`工单「${order.title}」依赖的「${dep}」不在本轮里`, 'UNKNOWN_DEPENDENCY');
        }
    }
    return orders;
}

/**
 * 把工单切成拓扑层。同层可并行，层间串行。
 * @param orders - 规范化后的工单。
 * @returns 层数组。
 */
export function layerOrders(orders) {
    const remaining = [...orders];
    const done = new Set();
    const layers = [];
    while (remaining.length > 0) {
        const ready = remaining.filter(order => order.dependsOn.every(dep => done.has(dep)));
        if (ready.length === 0)
            throw new ForemanError('工单依赖成环，无法排期', 'CYCLIC_DEPENDENCY');
        layers.push(ready);
        for (const order of ready) {
            done.add(order.id);
            remaining.splice(remaining.indexOf(order), 1);
        }
    }
    return layers;
}

/**
 * 生成给承包商的完整提示词。
 *
 * 承包商是从零开始的子会话：它看不到父会话的上下文，所以这张工单必须自足。
 * 三件事缺一不可——干什么、怎么算干完、交付什么。最后一条尤其重要：父智能体
 * 验收时手里只有这段文字。
 *
 * @param args.goal - 本轮总目标。
 * @param args.order - 工单。
 * @param args.feedback - 上一轮打回的意见（返工时才有）。
 * @returns 提示词文本。
 */
export function buildPrompt({ goal, order, feedback = '', prompt = '', history = [] }) {
    const lines = [
        '你是承包商，领一张工单独立完成。不要向上级提问，不要请求确认。',
    ];
    // 承包商自己的提示词放在最前面：它是"这个人怎么干活"的常驻说明，
    // 后面的工单是"这一单要干什么"。两者冲突时以工单为准。
    if (prompt !== '')
        lines.push('', '【你的提示词】', prompt.trim(), '（以上是你一贯的工作方式；与本单要求冲突时，以工单为准）');
    // 跨轮记忆：把同一承包商的近期产出拼进 prompt（同 agent-teams 的 previousResult）。
    // 子智能体是新建的（delivery:'caller'），不带会话记忆；但把上几单的结果写进来，
    // 它就能"记得"自己之前干了什么。
    if (Array.isArray(history) && history.length > 0) {
        lines.push('', '【你之前的产出（跨轮记忆）】');
        for (const entry of history) {
            lines.push(`- ${entry.id}：${entry.text.slice(0, 300)}${entry.text.length > 300 ? '…' : ''}`);
        }
        lines.push('（以上是你此前几单的结果，供本单参考；不要重复已完成的工作）');
    }
    lines.push('', `【工单】${order.id} · ${order.title}`);
    if (goal !== '')
        lines.push(`【总目标】${goal}`);
    lines.push('', '【任务】', order.task.trim(), '', '【验收标准】',
        order.accept !== '' ? order.accept : '按任务描述完成，并在交付摘要里说明如何验证。');
    if (feedback !== '') {
        // 返工要在提示词里带上"这是第几轮提交"：子智能体（尤其是复用会话续写时）
        // 需要知道这不是第一次，好按反馈改而不是从头再来。attempts 从 1 起算，
        // 返工时 review() 已把它 +1，所以 ≥2 才是被回炉过。
        const roundPart = Number.isInteger(order?.attempts) && order.attempts > 1
            ? `（本单第 ${order.attempts} 轮提交）`
            : '';
        lines.push('', `【上一轮被打回，这次必须改掉】${roundPart}`, feedback.trim());
    }
    lines.push(
        '',
        '【交付要求】',
        '1. 直接动手完成，不要提问、不要等授权；缺信息就取最合理的假设，并在摘要里写明假设。',
        '2. 结束时只输出「交付摘要」，四段：做了什么 / 改了哪些文件（写全路径）/ 如何自查验证 / 遗留问题。',
        '3. 摘要控制在 2000 字以内。不要贴代码、不要贴日志原文、不要复述文件内容；要我看细节就写「详见 <路径>」。',
        '4. 只改与工单相关的文件，不要顺手重构。',
        '5. 不要再把工作派给别的智能体，这一单由你亲手完成。',
        `6. 干完之后，额外调用一次 \`foreman_report\` 工具：orderId 填「${order.id}」，output 填上面那份交付摘要。这是产物回收的保险通道——宿主可能读不到你的会话正文，只有这条上报路径能保证你的成果被收走。`,
    );
    return lines.join('\n');
}

/** 状态标记，供看板文本使用。 */
const STATUS_MARK = {
    queued: '·',
    running: '…',
    done: '✔',
    failed: '✖',
    timeout: '✖',
    skipped: '⊘',
};

/**
 * 派单引擎。一个插件实例持有一个，存内存里的当前看板。
 */
export class ForemanEngine {
    /**
     * @param deps - 插件服务与存储。
     */
    constructor({ ctx, store, logger }) {
        this.ctx = ctx;
        this.store = store;
        this.logger = logger;
        /** 内存看板：runId → run。一轮对话里保留最近 20 轮。 */
        this.runs = new Map();
        /**
         * 派单轮转游标（跨轮持续）：key 是 'all' 或 'role:xxx'，值是下一个该用的下标。
         *
         * 必须是实例字段而不是 assignContractors 里的局部变量——否则每次派单都从 0
         * 重新开始，不指定 contractor 的工单会永远命中名册第一个承包商，导致各会话
         * 都抢同一个人、其余承包商闲着（浪费额度且串行排队）。
         */
        this.rotateCursors = new Map();
        // 从磁盘恢复上次的位置：不指定 contractor 的工单继续轮转，而不是每次重启
        // 都从名册第一个人开始（各会话抢同一个人会浪费额度、串行排队）。
        try {
            const saved = this.store?.readRotateCursors?.();
            if (saved instanceof Map)
                for (const [key, value] of saved)
                    this.rotateCursors.set(key, value);
        }
        catch {
            // 读不到就从头开始，不影响派单。
        }
    }

    /** 当前的 subagents 服务（可能尚未就绪）。 */
    #service() {
        const service = this.ctx.get('subagents');
        if (service === undefined || typeof service.startActivation !== 'function')
            throw new ForemanError('宿主的 subagents 服务不可用，无法派单', 'NO_SUBAGENTS');
        return service;
    }

    /**
     * 团队模式的执行层（懒加载一次）。
     *
     * 宿主没装智能体团队、或服务没就绪时返回 `undefined`，调用方安静地走普通
     * 激活路径——团队模式是**可选增强**，不是派单的前置条件。
     * @returns runner 或 undefined。
     */
    /** 已建的团队成员快照（诊断用；没有团队实例时给空数组）。 */
    teamSnapshot() {
        try {
            return this.team?.snapshot?.() ?? [];
        }
        catch {
            return [];
        }
    }

    async #teamLayer() {
        if (this.team === undefined) {
            try {
                this.team = createTeamRunner({ ctx: this.ctx, logger: this.logger });
            }
            catch (error) {
                this.logger?.warn?.(`dsh-agent-foreman: 团队模式不可用：${String(error?.message ?? error)}`);
                this.team = null;
            }
        }
        if (this.team === null || this.team === undefined)
            return undefined;
        return this.team.available() ? this.team : undefined;
    }

    /**
     * 决定用哪个 subagents provider 启动子智能体。
     *
     * 配置名优先；宿主没注册它时退回实际注册的第一个（并记一条日志），因为
     * "名字写错"比"整个插件不能用"更常见，也更不该让用户卡死。
     * @param policy - 当前策略。
     * @returns provider 名。
     */
    #providerName(policy) {
        const wanted = policy.provider;
        const names = readSubagentProviders(this.ctx);
        if (names.length === 0)
            return wanted;
        if (names.includes(wanted))
            return wanted;
        this.logger?.warn?.(`dsh-agent-foreman: subagents provider "${wanted}" 未注册，改用 "${names[0]}"（可选：${names.join('、')}）`);
        return names[0];
    }

    /**
     * 统计每个承包商当前**正在跑**的工单数（`member.id → 张数`）。
     *
     * 只看 `running`：`queued` 是本轮排期中的临时态，把它算成负载会让"还没起跑"
     * 的单也占住名额；`done`/`failed` 已经离场，不该再挡人。
     *
     * 这是「几个会话同时派单，别一起压在名册第一个人身上」的数据来源：引擎实例
     * 是进程级的，`this.runs` 里躺着**所有会话**的看板，所以 A 会话派给力工的那
     * 张单还在跑时，B 会话再派单就能看见"力工满了"，自动换人。
     *
     * @param runs - 运行记录数组（可含其它会话的）。
     * @returns `Map`（承包商 id → 在跑张数）。
     */
    static countLoad(runs) {
        const load = new Map();
        for (const run of Array.isArray(runs) ? runs : []) {
            const orders = Array.isArray(run?.orders) ? run.orders : [];
            for (const order of orders) {
                if (order?.status !== 'running')
                    continue;
                const id = typeof order?.member?.id === 'string' ? order.member.id : '';
                if (id === '')
                    continue;
                load.set(id, (load.get(id) ?? 0) + 1);
            }
        }
        return load;
    }

    /**
     * 把工单分配到承包商。
     *
     * 指定方式优先级：**id → 名字 → 岗位**。
     *
     * 三者都没写时**按负载挑人**，而不是简单地"从第一个人开始轮"：
     *
     * 1. 先只考虑还有空位的（在跑张数 < `maxParallel`）；
     * 2. 其中取在跑张数最少的；
     * 3. 负载打平时才用轮转游标打破平局（保证长期公平，不会总偏向前几个）。
     *
     * 为什么必须这样：轮转游标本身只是"第 N 次轮到谁"，它不知道谁正忙。用户
     * 多个会话同时派单时，光靠轮转仍可能把活压给正在跑的人，其余承包商闲着
     * ——额度浪费 + 串行排队。负载信息来自 {@link countLoad}，跨会话生效。
     *
     * 岗位是"同一类人"的池子：写「力工」时只在这个岗位**启用的**实例之间挑，
     * 池子里没有就报 `UNKNOWN_MEMBER`——悄悄退回全名册会把一张复核单派给便宜
     * 的小工，验收就变成自说自话。
     *
     * @param orders - 工单。
     * @param members - 已启用的承包商。
     * @param cursors - 轮转游标（跨轮持续；只用于负载打平时打破平局）。
     * @param load - 各承包商当前在跑张数（见 {@link countLoad}）；缺省视为全空。
     * @returns 已解析分配结果的工单。
     */
    static assignContractors(orders, members, cursors = new Map(), load = new Map()) {
        const pool = enabledMembers(members);
        if (pool.length === 0)
            throw new ForemanError('名册里没有已启用的承包商。请在「设置 → 包工头」里添加，或先调用 foreman_roster 查看名册', 'EMPTY_ROSTER');
        /** 本轮已经派出去的张数：同一批里也不该把三张单压给同一个人。 */
        const picked = new Map();
        const capacityOf = member => Math.max(1, member.maxParallel ?? 1);
        const loadOf = member => (load.get(member.id) ?? 0) + (picked.get(member.id) ?? 0);
        const take = (member) => {
            picked.set(member.id, (picked.get(member.id) ?? 0) + 1);
            return member;
        };
        /**
         * 从候选人里挑一个：有空位的优先，空位里负载最小的优先，
         * 负载相同时按游标轮转。
         */
        const rotate = (candidates, key) => {
            const spare = candidates.filter(member => loadOf(member) < capacityOf(member));
            const eligible = spare.length > 0 ? spare : candidates;
            const minLoad = Math.min(...eligible.map(member => loadOf(member)));
            const tied = eligible.filter(member => loadOf(member) === minLoad);
            const index = cursors.get(key) ?? 0;
            cursors.set(key, index + 1);
            return take(tied[index % tied.length]);
        };
        return orders.map((order) => {
            const wanted = keyOf(order.contractor);
            if (wanted === '')
                return { ...order, member: rotate(pool, 'all') };
            // 先按 id、再按名字：两者都是精确身份，同名不同 id 时不该串人。
            let member = pool.find(candidate => keyOf(candidate.id) === wanted);
            if (member === undefined)
                member = pool.find(candidate => keyOf(candidate.name) === wanted);
            if (member !== undefined)
                return { ...order, member: take(member) };
            const byRole = pool.filter(candidate => keyOf(roleOf(candidate)) === wanted);
            if (byRole.length > 0)
                return { ...order, member: rotate(byRole, `role:${wanted}`) };
            const choices = [...new Set(pool.flatMap(candidate => [
                typeof candidate.name === 'string' ? candidate.name.trim() : '',
                roleOf(candidate),
            ]).filter(value => value !== ''))];
            throw new ForemanError(`工单「${order.title ?? order.id ?? '未命名'}」指定的承包商「${order.contractor}」不在名册里。`
                + `可填的名字或岗位：${choices.join('、')}`, 'UNKNOWN_MEMBER');
        });
    }

    /**
     * 执行一张工单。
     * @param args.order - 已分配承包商的工单。
     * @param args.parent - 发起派单的父 Agent。
     * @param args.policy - 派单策略。
     * @param args.signal - 父调用方的取消信号。
     * @returns 工单的执行结果（就地更新同一个对象）。
     */
    async #runOrder({ order, parent, policy, signal }) {
        const member = order.member;
        order.contractorName = member.name;
        order.route = member.provider !== '' ? `${member.provider}/${member.model}` : 'inherit';
        // 三个路由字段先给默认值：没走到激活（团队模式提前返回、起跑前就失败）的
        // 工单在 orderRow / schema 里也必须是稳定的形状，而不是 undefined。
        order.actualRoute = '';
        order.actualReasoningEffort = '';
        order.routeMismatch = false;
        order.routeNote = '';
        order.status = 'running';
        order.updatedAt = new Date().toISOString();
        const startedAt = Date.now();
        const service = this.#service();
        const providerName = this.#providerName(policy);
        const agentOptions = member.provider !== '' && member.model !== ''
            ? { provider: member.provider, model: member.model, ...(member.reasoningEffort !== '' ? { reasoningEffort: member.reasoningEffort } : {}) }
            : undefined;

        const controller = new AbortController();
        const forwardAbort = () => controller.abort(signal?.reason);
        if (signal !== undefined) {
            if (signal.aborted)
                controller.abort(signal.reason);
            else
                signal.addEventListener('abort', forwardAbort, { once: true });
        }

        let timer;
        let timedOut = false;
        let cancelled = false;
        let removeAbort;
        let activation;

        /**
         * 读一次子会话真实路由并写进工单。
         *
         * 包一层是为了守住"诊断绝不影响派单"：`readChildRoute` 自己已经吞了异常，
         * 这里再兜一次，连 `applyChildRoute` 之外的意外也不会冒到派单主流程。
         */
        const echoChildRoute = () => {
            try {
                applyChildRoute(order, readChildRoute(this.ctx, order.childId));
            }
            catch {
                applyChildRoute(order, undefined);
            }
        };

        // 团队模式：同一个承包商作为宿主的团队成员挂在自己会话里干活。走不通就
        // 记一笔 note，继续用下面的普通激活路径——两条路的产物格式一致。
        if (policy.teamMode === true) {
            const team = await this.#teamLayer();
            if (team === undefined)
                order.teamNote = '团队模式不可用（取不到宿主的 agentTeams 服务），已退回普通模式';
            else {
                try {
                    const teamResult = await team.dispatch({
                        order,
                        parent,
                        prompt: buildPrompt({
                            goal: order.goal,
                            order,
                            feedback: order.feedback ?? '',
                            prompt: order.member?.prompt ?? '',
                            history: this.collectHistory(order.member?.id),
                        }),
                        signal: controller.signal,
                        policy,
                    });
                    if (teamResult.ok) {
                        order.teamNote = `团队模式 · ${teamResult.note}`;
                        order.text = teamResult.text;
                        order.chars = teamResult.text.length;
                        order.artifactPath = teamResult.text === '' ? '' : this.store.writeArtifact(order.runId ?? 'run', order.id, teamResult.text);
                        order.stopReason = 'completed';
                        order.status = 'done';
                        order.updatedAt = new Date().toISOString();
                        order.durationMs = Date.now() - startedAt;
                        return order;
                    }
                    order.teamNote = `团队模式失败（${teamResult.reason}），已退回普通模式`;
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    order.teamNote = `团队模式失败（${message}），已退回普通模式`;
                    this.logger?.warn?.(`dsh-agent-foreman: ${order.teamNote}`);
                }
            }
        }

        try {
            activation = await service.startActivation({
                provider: providerName,
                label: `${order.id} ${order.title}`.slice(0, 80),
                request: {
                    prompt: [{ type: 'text', text: buildPrompt({
                        goal: order.goal,
                        order,
                        feedback: order.feedback ?? '',
                        prompt: order.member?.prompt ?? '',
                        history: this.collectHistory(order.member?.id),
                    }) }],
                    parent,
                    ...(agentOptions === undefined ? {} : { agentOptions }),
                    maxDepth: policy.maxDepth,
                },
                signal: controller.signal,
                delivery: 'caller',
            });
            order.childId = String(activation.childId);
            // 起跑就先读一次：这一单万一没落定（超时/取消），看板上也有一份
            // "它到底跑在哪个模型上"的证据；落定时还会再读一次并覆盖。
            echoChildRoute();
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    timedOut = true;
                    controller.abort(new Error('foreman timeout'));
                    reject(new ForemanError(`工单「${order.title}」超时（${policy.timeoutSeconds}s）`, 'TIMEOUT'));
                }, policy.timeoutSeconds * 1000);
            });
            // 取消/预算到点也必须让这一单立刻落定：否则不配合的 provider 会让
            // `Promise.race` 一直挂到单工单超时，把整轮派单拖死。
            const aborted = new Promise((_, reject) => {
                const onAbort = () => {
                    cancelled = true;
                    reject(new ForemanError(`工单「${order.title}」被中止（派单预算用尽或父会话取消）`, 'ABORTED'));
                };
                if (controller.signal.aborted) {
                    onAbort();
                    return;
                }
                controller.signal.addEventListener('abort', onAbort, { once: true });
                removeAbort = () => controller.signal.removeEventListener('abort', onAbort);
            });
            const result = await Promise.race([activation.result, timeout, aborted]);
            const text = extractText(result?.output);
            const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'completed';
            order.stopReason = stopReason;
            order.artifactPath = text === '' ? '' : this.store.writeArtifact(order.runId ?? 'run', order.id, text);
            order.text = text.length > ARTIFACT_LIMIT
                ? `${text.slice(0, ARTIFACT_LIMIT)}\n\n…（已截断，原文 ${text.length} 字${order.artifactPath !== '' ? `，完整正文：${order.artifactPath}` : ''}）`
                : text;
            order.chars = text.length;
            order.status = stopReason === 'completed' ? 'done' : 'failed';
            if (stopReason !== 'completed')
                order.error = `${STOP_LABEL[stopReason] ?? stopReason}${result?.diagnostic !== undefined ? `：${String(result.diagnostic)}` : ''}`;
        }
        catch (error) {
            const code = error instanceof ForemanError ? error.code : undefined;
            order.status = code === 'TIMEOUT' || timedOut ? 'timeout' : 'failed';
            order.error = explainActivationError(error);
            order.stopReason = order.stopReason ?? (timedOut || cancelled ? 'aborted' : 'error');
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
            removeAbort?.();
            if (signal !== undefined)
                signal.removeEventListener?.('abort', forwardAbort);
            // 落定后再读一次真实路由，覆盖起跑时那一次：子会话跑到中途才切模型
            // 时，这里读到的才是它实际干完活用的那套。必须在 dispose 之前读。
            if (activation !== undefined)
                echoChildRoute();
            // 超时/取消后必须显式释放，否则子会话会占着并发槽位。
            if (activation !== undefined) {
                try {
                    await activation.dispose();
                }
                catch {
                    // 已经落定的激活再 dispose 会失败，可以忽略。
                }
            }
            order.durationMs = Date.now() - startedAt;
            order.updatedAt = new Date().toISOString();
        }
        return order;
    }

    /**
     * 派一轮工单。
     *
     * 这是唯一会真正等待子智能体的入口：全部工单落定后才返回，看板随结果一起
     * 回到父智能体手里。若父调用方自身有等待上限（`waitSeconds`），到点就中止
     * 未完成的工单——不留在后台偷偷跑，否则父模型会拿到一份假的"全部完成"。
     *
     * @param args.parent - 发起方 Agent。
     * @param args.sessionId - 会话 id（看板归属）。
     * @param args.goal - 总目标。
     * @param args.orders - 已规范化的工单。
     * @param args.policy - 策略。
     * @param args.signal - 父调用方取消信号。
     * @returns 本轮 run。
     */
    /**
     * 收集同一承包商的近期产出（跨轮记忆）。
     *
     * 子智能体是新建的（delivery:'caller'），不带会话记忆。但把上几单的结果
     * 拼进 prompt，它就能"记得"自己之前干了什么——这正是 agent-teams 用
     * `previousResult` 实现跨轮记忆的方式。
     *
     * @param memberId - 承包商 id。
     * @param limit - 最多取几条（默认 3）。
     * @returns `[{ id,​ text }]`，从旧到新。
     */
    collectHistory(memberId, limit = 3) {
        const out = [];
        for (const run of this.runs.values()) {
            for (const order of run.orders) {
                if (order.member?.id !== memberId)
                    continue;
                const text = order.reportOutput || order.text || '';
                if (text === '')
                    continue;
                out.push({ id: order.id, text, at: order.updatedAt ?? run.createdAt });
            }
        }
        // 按时间排序取最近 limit 条（从旧到新）。
        out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        return out.slice(-limit);
    }

    async dispatch({ parent, sessionId, goal, orders, policy, signal }) {
        const members = this.store.members().filter(member => member.enabled);
        // 负载取自 `this.runs`：引擎是进程级单例，这里面躺着**所有会话**的看板，
        // 所以别的会话正在让力工干活时，这里看得见——不指定 contractor 的工单
        // 会自动落到空闲的人身上，而不是又压回名册第一个人。
        const load = ForemanEngine.countLoad([...this.runs.values()]);
        // attempts 从 1 起算：返工额度是 `1 + maxRework` 次总尝试，没有这个初值
        // `order.attempts < 1 + maxRework` 会拿 undefined 去比，永远不返工。
        const assigned = ForemanEngine.assignContractors(orders, members, this.rotateCursors, load)
            .map(order => ({ ...order, goal, attempts: 1, status: 'queued' }));
        // 分配完就落盘：游标是本轮"谁被选中了"的唯一凭据，中途崩溃也不该丢（否则重启后
        // 会重复选中同一批承包商）。
        try {
            this.store?.writeRotateCursors?.(this.rotateCursors);
        }
        catch {
            // 持久化失败不影响本轮派单。
        }
        const run = {
            id: shortId('R'),
            goal,
            sessionId,
            createdAt: new Date().toISOString(),
            status: 'running',
            policy,
            orders: assigned,
        };
        this.#remember(run);
        for (const order of run.orders)
            order.runId = run.id;
        // 环检测仍然留在 layerOrders 里：它只用来拒绝成环的排期，不再是执行单位。
        layerOrders(assigned);
        await this.#scheduleReady({ run, parent, policy, signal });
        run.status = 'waiting-review';
        run.finishedAt = new Date().toISOString();
        run.totalMs = run.orders.reduce((sum, order) => sum + (order.durationMs ?? 0), 0);
        // 整轮落定后再存一次：工单级别的快照只保证"跑到哪儿了"，这一份才是
        // "这一轮结束了"的终态凭据。store 没有快照能力时 persistRun 自己跳过。
        this.persistRun(run);
        this.store.recordRun(this.#toLedger(run));
        return run;
    }

    /**
     * 按依赖就绪增量调度：某张单的所有 `dependsOn` 都 done 后才起跑。
     *
     * 和"整层 barrier"的区别只在**何时放下一张**：这里没有层，只有一张不断被
     * 重新求值的就绪集合——A 交活后立刻启动依赖 A 的 C，不会白等同层慢的 B。
     *
     * 两个闸门照旧生效：全局 `policy.concurrency` 与单实例 `member.maxParallel`。
     * 满了就排队，不拒绝。
     *
     * 失败链的处理是**被动递归**：一张单落定（failed/timeout/skipped）后才把它
     * 的直接下游标 skipped 并写死原因，下游再轮到它自己时同样只影响它的下游。
     * 这样"谁挡住了我"永远是最近的那一张，父模型看板就知道该重派哪一单。
     *
     * @param args.run - 本轮运行记录（工单的就地状态）。
     * @param args.parent - 发起方 Agent。
     * @param args.policy - 派单策略。
     * @param args.signal - 取消信号。
     */
    async #scheduleReady({ run, parent, policy, signal }) {
        const globalLimit = Math.max(1, Math.min(policy.concurrency, 8));
        const byId = new Map(run.orders.map(order => [order.id, order]));
        const busy = new Map();
        const capacityOf = member => Math.max(1, Math.min(8, member.maxParallel ?? 1));
        let active = 0;
        let wake;
        const notify = () => {
            const pending = wake;
            wake = undefined;
            pending?.();
        };
        const idle = () => new Promise((resolve) => {
            wake = resolve;
        });

        /** 依赖是否全部 done：只有 done 才算满足，skipped/failed 一律挡。 */
        const depsSettled = order => order.dependsOn.every((depId) => {
            const dep = byId.get(depId);
            return dep === undefined || dep.status === 'done';
        });

        /** 取一个能解释"为什么被挡住"的未完成依赖 id。 */
        const blockingDep = order => order.dependsOn.find((depId) => byId.get(depId)?.status !== 'done') ?? order.id;

        /** 每张单落定后存一次快照；取不到 run 或 store 不支持时安静跳过。 */
        const saveSnapshot = (runId) => {
            const current = this.runs.get(runId);
            if (current === undefined)
                return;
            try {
                this.store?.saveRunSnapshot?.(current);
            }
            catch (error) {
                this.logger?.warn?.(`dsh-agent-foreman: 运行快照写入失败：${String(error?.message ?? error)}`);
            }
        };

        /** 把一张单标跳过，并把它的直接下游递归标跳过。 */
        const skipOrder = (order, error) => {
            order.status = 'skipped';
            order.error = error;
            order.stopReason = order.stopReason ?? 'skipped';
            order.updatedAt = new Date().toISOString();
            saveSnapshot(order.runId);
            const downstream = [...byId.values()].filter(candidate => candidate.status === 'queued'
                && candidate.dependsOn.includes(order.id));
            for (const child of downstream)
                skipOrder(child, `依赖 ${order.id} 未完成`);
        };

        /** 上游失败/超时后，只阻断直接依赖未满足的工单。 */
        const blockDownstream = (order) => {
            if (order.status === 'done')
                return;
            for (const child of byId.values()) {
                if (child.status === 'queued' && child.dependsOn.includes(order.id))
                    skipOrder(child, `依赖 ${order.id} 未完成`);
            }
        };

        /** 取消时把还没起跑的单标 skipped，说明它们不是失败而是没轮到。 */
        const cancelQueued = () => {
            let touched = false;
            for (const order of byId.values()) {
                if (order.status !== 'queued')
                    continue;
                order.status = 'skipped';
                order.error = '派单已取消';
                order.stopReason = order.stopReason ?? 'aborted';
                order.updatedAt = new Date().toISOString();
                touched = true;
            }
            if (touched)
                saveSnapshot(run.id);
        };

        const launch = (order) => {
            const memberId = order.member.id;
            busy.set(memberId, (busy.get(memberId) ?? 0) + 1);
            active += 1;
            void this.#runOrder({ order, parent, policy, signal })
                .catch((error) => {
                    // #runOrder 自己吞掉激活错误；走到这里说明更底层出了问题，
                    // 也要让它落定，否则下游永远等不到结论。
                    order.status = 'failed';
                    order.error = explainActivationError(error);
                    order.stopReason = order.stopReason ?? 'error';
                    order.updatedAt = new Date().toISOString();
                })
                .then(() => {
                    busy.set(memberId, Math.max(0, (busy.get(memberId) ?? 1) - 1));
                    active -= 1;
                    blockDownstream(order);
                    saveSnapshot(order.runId);
                    notify();
                });
        };

        while (true) {
            if (signal?.aborted) {
                cancelQueued();
                break;
            }
            let launched = false;
            for (const order of byId.values()) {
                if (active >= globalLimit)
                    break;
                if (order.status !== 'queued' || !depsSettled(order))
                    continue;
                const memberId = order.member.id;
                if ((busy.get(memberId) ?? 0) >= capacityOf(order.member))
                    continue;
                launch(order);
                launched = true;
            }
            const queued = [...byId.values()].filter(order => order.status === 'queued');
            if (queued.length === 0 && active === 0)
                break;
            if (active === 0) {
                // 没人在跑却还有单没起跑：它等的是失败/跳过的上游。正常情况下
                // blockDownstream 已经处理过；这里补一次，避免空转。
                const stuck = queued.find(order => !depsSettled(order));
                if (stuck !== undefined) {
                    skipOrder(stuck, `依赖 ${blockingDep(stuck)} 未完成`);
                    continue;
                }
                throw new ForemanError('排期卡住：没有承包商还有空位（检查名册里的并发上限）', 'SCHEDULER_STUCK');
            }
            if (!launched)
                await idle();
        }
        // 取消后已起跑的单仍要收尾，否则看板会留下半截 running。
        while (active > 0)
            await idle();
    }

    /**
     * 把一份快照变成可读的"历史看板"。
     *
     * 恢复是**只读**的：这里绝不调用 `startActivation`，也不排队任何工单。插件
     * 重启后重新跑一遍工单会重复改文件、重复花钱，而父模型以为自己看的是旧看板
     * ——那才是真正的危险。所以未落定的工单就地判为 `failed` 并写明原因，落定的
     * 结果原样保留，界面上看到的是"中断了，需要人决定要不要重派"。
     *
     * @param snapshot - `store.loadRunSnapshots()` 返回的一份快照。
     * @returns 恢复后的运行记录。
     */
    #restoreRun(snapshot) {
        const run = snapshot;
        run.orders = (Array.isArray(run.orders) ? run.orders : []).map((order) => {
            if (order === null || typeof order !== 'object')
                return order;
            const settled = order.status === 'done' || order.status === 'failed' || order.status === 'timeout';
            if (settled)
                return order;
            return {
                ...order,
                status: 'failed',
                error: INTERRUPTED_NOTE,
                stopReason: order.stopReason ?? 'aborted',
            };
        });
        if (run.status === 'running' || run.status === 'rework') {
            // waiting-review 是看板本来就认识的状态：能看到、能验收、不会被当成
            // 还在跑（那会让面板显示"进行中"却永远等不到结果）。
            run.status = 'waiting-review';
            run.interrupted = true;
        }
        run.recovered = true;
        return run;
    }

    /**
     * 从磁盘快照里找一轮运行；找不到返回 undefined。
     *
     * 显式 id 比的是**快照 id**，并且必须与会话对得上：快照是整个数据目录共享的，
     * 不校验会话就等于让 A 会话用 id 读 B 会话的看板。会话为空（拿不到会话键）
     * 时只允许全局查找，那是给面板/诊断用的，工具入口不会走到。
     *
     * @param args.runId - 显式 run id；空表示按会话找最新。
     * @param args.sessionId - 会话 id。
     * @param args.requireSession - 为 true 时必须提供非空会话（工具入口）。
     * @returns 运行记录或 undefined。
     */
    #fromSnapshots({ runId, sessionId, requireSession = true }) {
        const store = this.store;
        if (store === undefined || typeof store.loadRunSnapshots !== 'function')
            return undefined;
        const wanted = typeof runId === 'string' ? runId.trim() : '';
        const session = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (wanted !== '') {
            // 空会话连显式 id 也不给：快照目录没有会话隔离，放行等于开放全局读。
            if (requireSession && session === '')
                return undefined;
            const id = sanitizeRunId(wanted);
            if (id === '')
                return undefined;
            const snapshot = store.loadRunSnapshots(SNAPSHOT_SCAN).find(entry => entry.id === id);
            if (snapshot === undefined)
                return undefined;
            const owner = typeof snapshot.sessionId === 'string' ? snapshot.sessionId : '';
            if (session !== '' && owner !== session) {
                this.logger?.warn?.(`dsh-agent-foreman: 派单快照「${id}」属于另一个会话，已拒绝跨会话读取`);
                return undefined;
            }
            const restored = this.#restoreRun(snapshot);
            this.#remember(restored);
            return restored;
        }
        if (requireSession && session === '')
            return undefined;
        const snapshots = store.loadRunSnapshots(SNAPSHOT_LIMIT);
        let latest;
        for (const snapshot of snapshots) {
            if (session !== '' && snapshot.sessionId !== session)
                continue;
            const createdAt = typeof snapshot.createdAt === 'string' ? snapshot.createdAt : '';
            if (latest === undefined || createdAt > latest.createdAt)
                latest = snapshot;
        }
        if (latest === undefined)
            return undefined;
        const restored = this.#restoreRun(latest);
        this.#remember(restored);
        return restored;
    }

    /**
     * 记录一轮运行；超过 20 轮时丢掉最老的，避免内存看板无限增长。
     * @param run - 运行记录。
     */
    #remember(run) {
        this.runs.set(run.id, run);
        while (this.runs.size > 20) {
            const oldest = this.runs.keys().next().value;
            if (oldest === undefined)
                break;
            this.runs.delete(oldest);
        }
    }

    /**
     * 取一轮运行：显式 runId 优先，否则取该会话最近的一轮。
     *
     * 内存里没有时回落到磁盘快照（`<dataDir>/runs/<runId>.json`）：插件重载过、
     * 或者内存看板已经按 20 轮淘汰了旧记录，都还能把上一轮看板找回来读。
     * 找回来的记录是**只读**的（见 `#restoreRun`），不会重跑任何工单。
     *
     * 显式 runId 必须与 sessionId 对得上：快照目录是整个数据目录共享的，不校验
     * 会话就等于允许 A 会话用 id 读 B 会话的看板。省略 runId 时只会返回本会话的
     * 记录；会话为空不会退化成"随便给一个"。
     *
     * @param runId - 运行 id，可空。
     * @param sessionId - 会话 id，用于缺省查找与归属校验。
     * @returns 运行记录。
     */
    requireRun(runId, sessionId) {
        const wanted = typeof runId === 'string' ? runId.trim() : '';
        const session = typeof sessionId === 'string' ? sessionId.trim() : '';
        if (wanted !== '') {
            // 空会话连显式 id 也不给：快照目录没有会话隔离，放行等于开放全局读。
            if (session === '')
                throw new ForemanError('取派单记录需要会话 id，当前调用没有带上会话', 'UNKNOWN_RUN');
            const cached = this.runs.get(wanted);
            if (cached !== undefined) {
                if (cached.sessionId !== session)
                    throw new ForemanError(`派单记录「${wanted}」不属于当前会话，不能在另一个会话里查看或验收`, 'UNKNOWN_RUN');
                return cached;
            }
            const restored = this.#fromSnapshots({ runId: wanted, sessionId: session });
            if (restored !== undefined)
                return restored;
            throw new ForemanError(`找不到派单记录「${wanted}」（可能已随会话结束清理）`, 'UNKNOWN_RUN');
        }
        let latest;
        for (const run of this.runs.values()) {
            // 精确匹配会话：空会话只认空会话的记录，不会退化成"谁最新给谁"。
            if (run.sessionId !== session)
                continue;
            if (latest === undefined || run.createdAt > latest.createdAt)
                latest = run;
        }
        if (latest !== undefined)
            return latest;
        // 内存 miss：只在本会话的快照里找，且必须有会话——空会话串读会把别的
        // 会话的看板当成"你这个会话的最新一轮"。
        const restored = this.#fromSnapshots({ runId: '', sessionId: session, requireSession: true });
        if (restored !== undefined)
            return restored;
        throw new ForemanError('这个会话还没有派过单', 'NO_RUN');
    }

    /**
     * 取一轮运行，找不到就返回 undefined。
     *
     * 和 `requireRun` 的区别：这个是给 HTTP 面板用的，会话里还没派过单是正常状态，
     * 不该变成 400。内存 miss 时同样读磁盘快照，`sessionId` 为空则取全局最近一轮
     * ——这一条只服务于设置页与诊断，工具入口（`requireRun`）不允许这么读。
     *
     * @param sessionId - 会话 id；空则取全局最近一轮。
     * @returns 运行记录或 undefined。
     */
    latestRun(sessionId) {
        const session = typeof sessionId === 'string' ? sessionId.trim() : '';
        let latest;
        for (const run of this.runs.values()) {
            // 空会话 = 不过滤：面板拿不到会话键时要能看到全局最近一轮（诊断用途）。
            if (session !== '' && run.sessionId !== session)
                continue;
            if (latest === undefined || run.createdAt > latest.createdAt)
                latest = run;
        }
        if (latest !== undefined)
            return latest;
        return this.#fromSnapshots({ runId: '', sessionId: session, requireSession: false });
    }

    /**
     * 把一轮运行存成可恢复的快照；写失败只记日志，不影响派单。
     *
     * 这是 `dispatch` / `review` 之外唯一被要求调用的持久化钩子：工单状态变化时
     * 存一次，插件重启后才有一份"跑到哪儿了"的凭据。
     *
     * @param run - 运行记录。
     * @returns 是否写入成功。
     */
    persistRun(run) {
        const store = this.store;
        if (store === undefined || typeof store.saveRunSnapshot !== 'function')
            return false;
        const ok = store.saveRunSnapshot(run);
        if (!ok)
            this.logger?.warn?.('dsh-agent-foreman: 运行快照写入失败（不影响本轮派单）');
        return ok;
    }

    /**
     * 承包商主动上报本单的交付摘要。
     *
     * 子会话的正文宿主不一定读得到（取决于执行层），所以给它一条显式
     * 的回收通道：工单 id + 一段摘要写回看板。只认还在干的单（queued /
     * running / rework），已结案的单不收——那是验收的地盘。
     *
     * 同名工单出现在多轮里时取最新的一轮，不和历史上的同名工单串味。
     *
     * @param orderId - 工单 id。
     * @param text - 交付摘要；空白内容被忽略，不覆盖已有摘要。
     * @returns `{ ok, runId, orderId }` 或 `{ ok: false, reason }`。
     */
    reportOrderOutput(orderId, text) {
        try {
            const key = typeof orderId === 'string' ? orderId.trim() : '';
            const body = typeof text === 'string' ? text.trim() : '';
            if (key === '')
                return { ok: false, reason: '未找到进行中的工单 ' };
            const live = new Set(['queued', 'running', 'rework']);
            let hitRun;
            let hitOrder;
            for (const run of this.runs.values()) {
                if (!Array.isArray(run?.orders))
                    continue;
                const order = run.orders.find(candidate => candidate?.id === key
                    && live.has(candidate.status ?? 'queued'));
                if (order === undefined)
                    continue;
                if (hitRun === undefined || (run.createdAt ?? '') > (hitRun.createdAt ?? '')) {
                    hitRun = run;
                    hitOrder = order;
                }
            }
            if (hitRun === undefined || hitOrder === undefined)
                return { ok: false, reason: `未找到进行中的工单 ${key}` };
            if (body === '')
                return { ok: true, runId: hitRun.id, orderId: key };
            hitOrder.reportOutput = body;
            hitOrder.reportAt = new Date().toISOString();
            if (typeof this.store?.saveRunSnapshot === 'function') {
                try {
                    this.store.saveRunSnapshot(hitRun);
                }
                catch (error) {
                    this.logger?.warn?.(`dsh-agent-foreman: 上报快照写入失败：${String(error?.message ?? error)}`);
                }
            }
            return { ok: true, runId: hitRun.id, orderId: key };
        }
        catch (error) {
            return { ok: false, reason: String(error?.message ?? error) };
        }
    }

    /**
     * 验收：逐单记录通过/打回，打回的按剩余返工额度重派。
     *
     * @param args.run - 运行记录。
     * @param args.verdicts - `[{ order, verdict, feedback? }]`。
     * @param args.rework - 是否允许返工（默认 true，受 `maxRework` 约束）。
     * @param args.parent - 发起方 Agent（返工时要用）。
     * @param args.signal - 取消信号。
     * @returns 更新后的运行记录。
     */
    async review({ run, verdicts, rework = true, parent, signal }) {
        if (!Array.isArray(verdicts) || verdicts.length === 0)
            throw new ForemanError('至少给一条验收结论', 'NO_VERDICTS');
        const now = new Date().toISOString();
        const redo = [];
        for (const entry of verdicts) {
            const key = typeof entry?.order === 'string' ? entry.order.trim() : '';
            const order = run.orders.find(candidate => candidate.id === key
                || candidate.title === key
                || candidate.contractorName === key && run.orders.filter(o => o.contractorName === key).length === 1);
            if (order === undefined)
                throw new ForemanError(`本轮没有工单「${key}」（工单：${run.orders.map(o => o.id).join('、')}）`, 'UNKNOWN_ORDER');
            const verdict = entry.verdict === 'pass' ? 'pass' : 'fail';
            order.verdict = verdict;
            order.verdictAt = now;
            order.feedback = typeof entry.feedback === 'string' ? entry.feedback.trim() : '';
            if (verdict === 'fail' && rework && order.attempts < 1 + run.policy.maxRework)
                redo.push(order);
        }
        if (redo.length > 0) {
            // 返工只重跑明确打回的那几张，但它们仍然受依赖约束：上游没 done
            // 就重跑等于用一份不成立的输入去验收，所以直接拒绝，而不是绕过。
            const done = new Set(run.orders.filter(order => order.status === 'done').map(order => order.id));
            for (const order of redo) {
                const missing = order.dependsOn.filter(depId => !done.has(depId));
                if (missing.length > 0)
                    throw new ForemanError(`工单「${order.title}」不能返工：依赖的`
                        + `${missing.map(depId => `「${depId}」`).join('、')}还没有完成`
                        + `（当前状态：${missing.map((depId) => {
                            const dep = run.orders.find(candidate => candidate.id === depId);
                            return `${depId}=${dep?.status ?? '不存在'}`;
                        }).join('、')}）`, 'DEPENDENCY_NOT_DONE');
            }
            run.status = 'rework';
            for (const order of redo) {
                order.attempts += 1;
                order.status = 'queued';
                order.verdict = undefined;
                order.error = undefined;
            }
            for (const order of redo)
                await this.#runOrder({ order, parent, policy: run.policy, signal });
            run.status = 'waiting-review';
        }
        else if (run.orders.every(order => order.verdict !== undefined)) {
            // 每条都签过了：全通过才叫验收完成，否则是带着打回结论结案。
            run.status = run.orders.every(order => order.verdict === 'pass') ? 'accepted' : 'closed';
        }
        run.updatedAt = now;
        // 验收结论也要落到快照里：重启后这份看板仍然能看出"谁被打回了"。
        this.persistRun(run);
        this.store.recordRun(this.#toLedger(run));
        return run;
    }

    /** 台账行（不存正文，避免台账随产物膨胀）。 */
    #toLedger(run) {
        return {
            id: run.id,
            at: run.createdAt,
            sessionId: run.sessionId,
            goal: run.goal,
            status: run.status,
            orders: run.orders.map(order => ({
                id: order.id,
                title: order.title,
                contractor: order.contractorName ?? '',
                route: order.route ?? '',
                // 真实路由与一致性结论也进台账：事后排查"它到底跑在哪个模型上"
                // 只能靠这一行，看板正文会随会话结束消失。
                actualRoute: order.actualRoute ?? '',
                routeMismatch: order.routeMismatch === true,
                status: order.status,
                stopReason: order.stopReason ?? '',
                durationMs: order.durationMs ?? 0,
                attempts: order.attempts,
                chars: order.chars ?? 0,
                verdict: order.verdict ?? '',
                error: order.error ?? '',
                teamMode: order.teamNote ?? '',
            })),
        };
    }

    /**
     * 看板的文本渲染。既要给父模型读（它据此决定验收），也要在聊天卡片里立得住。
     *
     * @param run - 运行记录。
     * @param args.withOutput - 是否附上每单的产物正文。
     * @returns 多行文本。
     */
    renderBoard(run, { withOutput = false } = {}) {
        const done = run.orders.filter(order => order.status === 'done').length;
        // 跳过也是"没交活"：父模型要能一眼看出下游是被挡住的，不是自己失败的。
        const failed = run.orders.filter(order => order.status === 'failed' || order.status === 'timeout' || order.status === 'skipped').length;
        const passed = run.orders.filter(order => order.verdict === 'pass').length;
        const failedReview = run.orders.filter(order => order.verdict === 'fail').length;
        const lines = [
            `包工头 · ${run.id} · ${run.orders.length} 张工单 · 交付 ${done} / 未成 ${failed}`,
            run.goal !== '' ? `目标：${run.goal}` : '',
            '─'.repeat(48),
        ].filter(line => line !== '');
        for (const order of run.orders) {
            const mark = order.verdict === 'pass' ? '✔' : order.verdict === 'fail' ? '↺' : STATUS_MARK[order.status] ?? '?';
            const seconds = order.durationMs === undefined ? '' : `${(order.durationMs / 1000).toFixed(1)}s`;
            const verdict = order.verdict === 'pass' ? ' 已验收' : order.verdict === 'fail' ? ' 打回' : '';
            const attempt = order.attempts > 1 ? ` 第${order.attempts}轮` : '';
            lines.push(`${mark} ${order.id} ${order.title} · ${order.contractorName ?? '未分配'} · ${order.route ?? ''} · ${seconds}${attempt}${verdict}`);
            if (order.teamNote !== undefined && order.teamNote !== '')
                lines.push(`   ⇢ ${order.teamNote}`);
            if (order.error !== undefined && order.error !== '')
                lines.push(`   ✖ ${order.error}`);
            if (order.status === 'done' && order.text !== undefined && order.text !== '') {
                if (withOutput) {
                    lines.push('   ┌ 交付');
                    for (const line of order.text.split('\n'))
                        lines.push(`   │ ${line}`);
                    lines.push('   └');
                }
                else {
                    const first = order.text.split('\n').find(line => line.trim() !== '') ?? '';
                    lines.push(`   ${first.slice(0, 100)}${first.length > 100 ? '…' : ''}`);
                }
            }
        }
        lines.push('─'.repeat(48));
        lines.push(`验收：共 ${run.orders.length} 单，通过 ${passed}，打回 ${failedReview}；未验收的还会留在看板上。`);
        if (run.status !== 'accepted')
            lines.push(`调用 foreman_review({ runId: "${run.id}", verdicts: [{ order: "<工单id>", verdict: "pass" | "fail", feedback: "打回理由" }] }) 逐个签收。`);
        return lines.join('\n');
    }
}
