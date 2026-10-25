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
import { ForemanError } from './store.js';
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
 * 规范化一组工单。
 *
 * `dependsOn` 只支持同批次内的工单 id：跨批次的依赖在共享看板里没有意义，
 * 而且会让"一轮派单"这个原子单位变得含糊。
 *
 * @param raw - 原始工单数组。
 * @param members - 可选承包商（用来预校验 contractor 名字）。
 * @returns 规范化后的工单数组。
 */
export function normalizeOrders(raw, members = []) {
    if (!Array.isArray(raw) || raw.length === 0)
        throw new ForemanError('至少需要一张工单', 'NO_ORDERS');
    if (raw.length > 12)
        throw new ForemanError('一轮最多派 12 张工单；更多请拆成几轮，便于验收', 'TOO_MANY_ORDERS');
    const known = new Set(members.map(member => member.id.toLowerCase()));
    const names = new Map(members.map(member => [member.name.toLowerCase(), member.id]));
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
            const key = contractor.toLowerCase();
            if (!known.has(key) && !names.has(key))
                throw new ForemanError(`工单「${title}」指定的承包商「${contractor}」不在名册里。`
                    + `可填的名字：${members.map(member => member.name).join('、') || '（名册为空，请先在设置页添加承包商）'}`, 'UNKNOWN_MEMBER');
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
export function buildPrompt({ goal, order, feedback = '', prompt = '' }) {
    const lines = [
        '你是承包商，领一张工单独立完成。不要向上级提问，不要请求确认。',
    ];
    // 承包商自己的提示词放在最前面：它是"这个人怎么干活"的常驻说明，
    // 后面的工单是"这一单要干什么"。两者冲突时以工单为准。
    if (prompt !== '')
        lines.push('', '【你的提示词】', prompt.trim(), '（以上是你一贯的工作方式；与本单要求冲突时，以工单为准）');
    lines.push('', `【工单】${order.id} · ${order.title}`);
    if (goal !== '')
        lines.push(`【总目标】${goal}`);
    lines.push('', '【任务】', order.task.trim(), '', '【验收标准】',
        order.accept !== '' ? order.accept : '按任务描述完成，并在交付摘要里说明如何验证。');
    if (feedback !== '') {
        lines.push('', '【上一轮被打回，这次必须改掉】', feedback.trim());
    }
    lines.push(
        '',
        '【交付要求】',
        '1. 直接动手完成，不要提问、不要等授权；缺信息就取最合理的假设，并在摘要里写明假设。',
        '2. 结束时只输出「交付摘要」，四段：做了什么 / 改了哪些文件（写全路径）/ 如何自查验证 / 遗留问题。',
        '3. 摘要控制在 2000 字以内。不要贴代码、不要贴日志原文、不要复述文件内容；要我看细节就写「详见 <路径>」。',
        '4. 只改与工单相关的文件，不要顺手重构。',
        '5. 不要再把工作派给别的智能体，这一单由你亲手完成。',
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
     * 把工单分配到承包商。
     *
     * 指定方式优先级：**名字**（或 id）→ 没指定就全名册轮流。轮转的目的只是别让
     * 所有活压在第一个承包商身上；真正的并发控制由 `#runLayer` 按 `maxParallel` 卡。
     *
     * @param orders - 工单。
     * @param members - 已启用的承包商。
     * @returns 已解析分配结果的工单。
     */
    static assignContractors(orders, members) {
        if (members.length === 0)
            throw new ForemanError('名册里没有已启用的承包商。请在「设置 → 包工头」里添加，或先调用 foreman_roster 查看名册', 'EMPTY_ROSTER');
        const cursors = new Map();
        const rotate = (pool, key) => {
            const index = cursors.get(key) ?? 0;
            cursors.set(key, index + 1);
            return pool[index % pool.length];
        };
        return orders.map((order) => {
            const wanted = typeof order.contractor === 'string' ? order.contractor.trim().toLowerCase() : '';
            let member;
            if (wanted !== '') {
                member = members.find(candidate => candidate.id.toLowerCase() === wanted || candidate.name.toLowerCase() === wanted);
            }
            return { ...order, member: member ?? rotate(members, 'all') };
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
                    }) }],
                    parent,
                    ...(agentOptions === undefined ? {} : { agentOptions }),
                    maxDepth: policy.maxDepth,
                },
                signal: controller.signal,
                delivery: 'caller',
            });
            order.childId = String(activation.childId);
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
    async dispatch({ parent, sessionId, goal, orders, policy, signal }) {
        const members = this.store.members().filter(member => member.enabled);
        // attempts 从 1 起算：返工额度是 `1 + maxRework` 次总尝试，没有这个初值
        // `order.attempts < 1 + maxRework` 会拿 undefined 去比，永远不返工。
        const assigned = ForemanEngine.assignContractors(orders, members)
            .map(order => ({ ...order, goal, attempts: 1 }));
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
        const layers = layerOrders(assigned);
        for (const layer of layers) {
            if (signal?.aborted)
                break;
            await this.#runLayer(layer, { parent, policy, signal });
        }
        run.status = 'waiting-review';
        run.finishedAt = new Date().toISOString();
        run.totalMs = run.orders.reduce((sum, order) => sum + (order.durationMs ?? 0), 0);
        this.store.recordRun(this.#toLedger(run));
        return run;
    }

    /**
     * 跑一层工单：同时受两个闸门约束。
     *
     * - 全局 `policy.concurrency`：同一时刻在场几个承包商（撞宿主的
     *   `maxActiveSubagents` 就会 ACTIVATION_LIMIT_REACHED）；
     * - 单个承包商 `member.maxParallel`：默认 1，也就是同一个实例串行干，
     *   否则两个子智能体会同时改同一批文件、互相踩。
     *
     * 满了就排队，不拒绝：位子一放出来，排在最前的工单立刻上。
     *
     * @param layer - 同一拓扑层的工单（彼此无依赖）。
     * @param args.parent - 发起方 Agent。
     * @param args.policy - 派单策略。
     * @param args.signal - 取消信号。
     */
    async #runLayer(layer, { parent, policy, signal }) {
        const globalLimit = Math.max(1, Math.min(policy.concurrency, 8));
        const queue = [...layer];
        const busy = new Map();
        const waiters = [];
        let active = 0;
        const capacityOf = member => Math.max(1, Math.min(8, member.maxParallel ?? 1));
        const release = () => {
            active -= 1;
            waiters.shift()?.();
        };
        while (queue.length > 0 || active > 0) {
            if (signal?.aborted)
                break;
            for (let index = 0; index < queue.length && active < globalLimit; index += 1) {
                const order = queue[index];
                const memberId = order.member.id;
                const inFlight = busy.get(memberId) ?? 0;
                if (inFlight >= capacityOf(order.member))
                    continue;
                queue.splice(index, 1);
                index -= 1;
                busy.set(memberId, inFlight + 1);
                active += 1;
                void this.#runOrder({ order, parent, policy, signal }).finally(() => {
                    busy.set(memberId, Math.max(0, (busy.get(memberId) ?? 1) - 1));
                    release();
                });
            }
            if (active === 0) {
                if (queue.length > 0)
                    throw new ForemanError('排期卡住：没有承包商还有空位（检查名册里的并发上限）', 'SCHEDULER_STUCK');
                break;
            }
            // 等到有一张单落定，再回来看看有没有位子放下一张。
            await new Promise((resolve) => {
                waiters.push(resolve);
            });
        }
        // 取消时已经起跑的单仍要收尾，否则看板会留下半截 running。
        while (active > 0)
            await new Promise((resolve) => {
                waiters.push(resolve);
            });
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
     * @param runId - 运行 id，可空。
     * @param sessionId - 会话 id，用于缺省查找。
     * @returns 运行记录。
     */
    requireRun(runId, sessionId) {
        if (typeof runId === 'string' && runId.trim() !== '') {
            const found = this.runs.get(runId.trim());
            if (found === undefined)
                throw new ForemanError(`找不到派单记录「${runId}」（可能已随会话结束清理）`, 'UNKNOWN_RUN');
            return found;
        }
        let latest;
        for (const run of this.runs.values()) {
            if (sessionId !== undefined && run.sessionId !== sessionId)
                continue;
            if (latest === undefined || run.createdAt > latest.createdAt)
                latest = run;
        }
        if (latest === undefined)
            throw new ForemanError('这个会话还没有派过单', 'NO_RUN');
        return latest;
    }

    /**
     * 取一轮运行，找不到就返回 undefined。
     *
     * 和 `requireRun` 的区别：这个是给 HTTP 面板用的，会话里还没派过单是正常状态，
     * 不该变成 400。
     *
     * @param sessionId - 会话 id；空则取全局最近一轮。
     * @returns 运行记录或 undefined。
     */
    latestRun(sessionId) {
        let latest;
        for (const run of this.runs.values()) {
            if (typeof sessionId === 'string' && sessionId !== '' && run.sessionId !== sessionId)
                continue;
            if (latest === undefined || run.createdAt > latest.createdAt)
                latest = run;
        }
        return latest;
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
            run.status = 'rework';
            for (const order of redo) {
                order.attempts += 1;
                order.status = 'queued';
                order.verdict = undefined;
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
        const failed = run.orders.filter(order => order.status === 'failed' || order.status === 'timeout').length;
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
