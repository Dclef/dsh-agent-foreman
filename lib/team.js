import { createHash } from 'node:crypto';
import { readSubagentProviders } from './catalog.js';
import { spawnNativeTeammate } from './native-team.js';
import { observeTeamSession, routeFromSession } from './team-session.js';

/**
 * Team mode always creates a real native roster member. Model routes are
 * applied to the native reserved-child request before materialization, never
 * by switching a busy session or spawning an unrelated standalone child.
 */
const HANDSHAKE = '只回复“待命”。不要调用工具、领取任务或发送消息。工单随后由主控发送。';

const WAIT_STEP_MS = 400;
const IDLE_WAIT_BUDGET_MS = 20000;
const NEW_MEMBER_IDLE_MS = 15000;
/**
 * 等成员 phase 变 active 的上限。
 *
 * 宿主 `spawnTeammate` 只是把成员建出来，它还要走 provisioning（接受初始
 * prompt）才会变 active；`sendMessage` 在 provisioning 期间会抛
 * `active teammate "worker" not found`。所以派单前必须等到这一步真的过去。
 */
export const ACTIVE_TIMEOUT_MS = 120000;
/** `waitActive` 轮询名册的间隔（比整体步长小：provisioning 通常只持续一两秒）。 */
const ACTIVE_STEP_MS = 200;

/**
 * 从成员行里取它实际在跑的模型（宿主由 `live.options.model` 提供）。
 * @returns 模型 id，读不到时为空串。
 */
function actualModelOf(row) {
    if (row === null || row === undefined)
        return '';
    const candidates = [row.model, row.live?.options?.model, row.live?.model, row.options?.model];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate !== '')
            return candidate;
    }
    return '';
}

/** 把失败成员行的 diagnostics[0] 压成一句话。 */
function failedReasonOf(row) {
    const first = Array.isArray(row?.diagnostics) ? row.diagnostics[0] : undefined;
    const detail = typeof first === 'string'
        ? first
        : first?.message ?? first?.reason ?? first?.detail ?? (first === undefined ? '' : String(first));
    const name = typeof row?.name === 'string' && row.name !== '' ? row.name : '成员';
    return `${name} 上线失败${detail === '' ? '' : `：${String(detail).slice(0, 200)}`}`;
}

/**
 * note 里那句「实际模型」。
 *
 * 名册为空表示跟随父会话，此时没有可比对的目标，不报不一致；名册配了却又
 * 和宿主回显的不一样（切模型失败 / provider 目录不认），才点明不一致。
 */
function modelNoteOf(member, actualModel) {
    if (actualModel === '')
        return '';
    const configured = typeof member?.model === 'string' ? member.model : '';
    if (configured !== '' && configured !== actualModel)
        return `实际模型 ${actualModel}（名册配 ${configured}，不一致）`;
    return `实际模型 ${actualModel}`;
}

/** 从 ContentBlock 数组里取纯文本（不依赖 engine，避免循环引用）。 */
function contentText(blocks) {
    if (!Array.isArray(blocks))
        return '';
    return blocks
        .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
        .trim();
}
const START_TIMEOUT_MS = 90_000;

/**
 * 取宿主的 remote 命名空间。
 *
 * cordis 里没 inject 的作用域直接读 `ctx.remote` 会抛
 * `cannot get property "remote" without inject`，所以拿不到就当没有。
 */
function remoteSessionOf(ctx) {
    for (const scope of [ctx, ctx?.root]) {
        try {
            const session = scope?.remote?.session;
            if (session !== undefined && session !== null)
                return session;
        }
        catch {
            // 没 inject，换下一个作用域。
        }
    }
    return undefined;
}


/**
 * 把名册里的名字转成宿主接受的团队成员名。
 *
 * 宿主要求 `lower-kebab-case`（≤64 字符、不能叫 lead），中文名直接用不了，
 * 所以默认统一叫 `worker`，第二个起 `worker-2`、`worker-3`…；纯 ASCII 的名字
 * 仍按自己的名字来，中文名照旧留在成员的 description 里给人看。
 *
 * @param member - 名册成员。
 * @param taken - 已经被占用的成员名集合（同一进程里复用）。
 * @returns 成员名。
 */
function teammateName(member, taken) {
    // 用 `member.id`（稳定唯一）而非 `name` 生成团队名：
    // 所有中文名走 `name` 都会落成 'worker'，导致不同承包商被映射到**同一个**
    // 团队成员——新工人复用了力工的旧成员，模型拦截注入也就永远不触发。
    // 用 id 生成后，每个承包商有自己独立的团队成员（各记各的跨轮记忆、各锁各的模型）。
    const raw = String(member?.id ?? member?.name ?? '');
    const ascii = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
    let candidate = ascii !== '' && ascii !== 'lead' && /^[a-z]/.test(ascii) ? ascii : '';
    if (candidate === '') {
        // 中文 id：取一个稳定短哈希，保证不同 id 得到不同团队名、且跨轮可复用。
        let h = 0;
        for (const ch of raw)
            h = ((h * 31 + ch.codePointAt(0)) >>> 0);
        candidate = `worker-${h.toString(36)}`;
    }
    if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
    }
    for (let index = 2; index < 100; index += 1) {
        const next = `${candidate}-${index}`;
        if (!taken.has(next)) {
            taken.add(next);
            return next;
        }
    }
    return `${candidate}-${taken.size + 1}`;
}

/**
 * @param args.ctx - 插件上下文（用来 `ctx.get(...)` 取宿主服务）。
 * @param args.logger - 可选的宿主 logger。
 */
export function createTeamRunner({ ctx, logger, activeTimeoutMs = ACTIVE_TIMEOUT_MS }) {
    /** Parent + contractor + route → genuine native teammate. */
    const members = new Map();
    const queues = new Map();
    const quarantined = new Set();

    /**
     * 找宿主的团队服务。
     *
     * 插件自己的 ctx 是个旁支作用域，团队服务注册在别的作用域里时这里取不到，
     * 所以要顺着 `ctx.root` 再找一遍（两处都试，拿到哪个用哪个）。
     *
     * @returns 团队服务，找不到时为 undefined。
     */
    const findService = () => {
        for (const scope of [ctx, ctx?.root]) {
            try {
                const teams = scope?.get?.('agentTeams');
                if (teams !== undefined && teams !== null)
                    return teams;
            }
            catch {
                // 作用域不支持 get 时继续找下一个。
            }
        }
        return undefined;
    };
    const service = () => {
        const teams = findService();
        if (teams === undefined)
            throw new TeamUnavailable('宿主没有 agentTeams 服务（未装智能体团队插件）');
        return teams;
    };

    /**
     * 确保承包商已经是团队里的成员。
     *
     * @returns 成员条目 `{ sessionId, name, switchStatus, switchDetail, actualModel }`。
     * @throws MemberNotReady 成员没有就绪或路由不符；拒绝投递，不自动换模型。
     */
    function cacheKey(parent, member) {
        return JSON.stringify([parent.id, member.id, member.provider, member.model, member.reasoningEffort]);
    }

    async function verifyRoute({ teams, parent, name, sessionId, member }) {
        if (member.provider === '' && member.model === '')
            return actualModelOf(readMemberRow({ teams, parent, name }));
        const session = await resolveSession(sessionId);
        const route = routeFromSession(session);
        const model = route?.model ?? '';
        const provider = route?.provider ?? '';
        const effort = route?.reasoningEffort ?? '';
        if (model !== member.model || provider !== member.provider
            || (member.reasoningEffort !== '' && effort !== member.reasoningEffort))
            throw new MemberNotReady(`成员 ${name} 模型路由未匹配：名册 ${member.provider}/${member.model}${member.reasoningEffort ? '@' + member.reasoningEffort : ''}，实际 ${provider || '?'}/${model || '?'}${effort ? '@' + effort : ''}；未投递工单`);
        return model;
    }

    async function ensureMember({ member, signal, parent, maxDepth }) {
        const key = cacheKey(parent, member);
        const teams = service();
        const cached = members.get(key);
        if (cached !== undefined && readMemberRow({ teams, parent, name: cached.name })?.status === 'failed')
            members.delete(key);
        else if (cached !== undefined) {
            await waitActive({ teams, parent, name: cached.name, signal });
            if (cached.handshakeNote === '握手待确认'
                && !await waitHandshakeDone(cached.sessionId, signal))
                throw new MemberNotReady('成员握手尚未完成，未投递工单');
            cached.actualModel = await verifyRoute({ teams, parent, name: cached.name, sessionId: cached.sessionId, member });
            return cached;
        }
        // Names are team-local, not process-global. Include the route in the
        // identity so editing a roster never silently reuses an old-model member.
        const identity = JSON.stringify([member.id, member.provider, member.model, member.reasoningEffort]);
        const fingerprint = createHash('sha256').update(identity).digest('hex').slice(0, 16);
        const base = teammateName(member, new Set()).slice(0, 40);
        let displayName = `${base}-${fingerprint}`;
        let existing = await findExistingMember({ teams, parent, name: displayName });
        // Failed native names are never reusable. Reserve a new generation,
        // rather than treating an existing failed record as a nonexistent name.
        for (let generation = 2; existing?.status === 'failed'; generation++) {
            displayName = `${base}-${fingerprint}-${generation}`;
            existing = await findExistingMember({ teams, parent, name: displayName });
        }
        let sessionId = existing?.sessionId;
        let name = existing?.name ?? displayName;
        if (existing === undefined) {
            const agentOptions = member.provider !== '' && member.model !== '' ? {
                provider: member.provider, model: member.model,
                ...(member.reasoningEffort === '' ? {} : { reasoningEffort: member.reasoningEffort }),
            } : undefined;
            const created = await spawnNativeTeammate({
                teams, parent, agentOptions, maxDepth,
                request: {
                    name: displayName,
                    description: `${member.name} · ${member.provider || '跟随当前会话'}/${member.model || '默认模型'}`.slice(0, 200),
                    provider: teamProvider(ctx), context: 'fresh',
                    prompt: [{ type: 'text', text: HANDSHAKE }],
                    signal: signal ?? new AbortController().signal,
                },
            });
            sessionId = created?.member?.id;
            if (typeof sessionId !== 'string' || sessionId === '')
                throw new TeamUnavailable('spawnTeammate 没返回成员会话');
            name = created?.member?.name ?? displayName;
        }
        // Record the reservation before waiting/verification so cancellation
        // can interrupt and drain the exact native child even during handshake.
        members.set(key, { contractorId: member.id, parentId: parent.id, sessionId, name,
            switchStatus: member.provider === '' ? 'follow-lead' : 'at-creation',
            switchDetail: '', actualModel: '', handshakeNote: '握手待确认' });
        await waitActive({ teams, parent, name, signal });
        const ready = await waitHandshakeDone(sessionId, signal);
        // Readable handshake still running: never mistake its late reply for
        // this order's delivery. Blind sessions use only the report channel.
        if (!ready && await sessionEventSummary(sessionId) !== undefined)
            throw new MemberNotReady('成员握手尚未完成，未投递工单');
        const actualModel = await verifyRoute({ teams, parent, name, sessionId, member });
        const entry = { contractorId: member.id, parentId: parent.id, sessionId, name,
            switchStatus: member.provider === '' ? 'follow-lead' : 'at-creation',
            switchDetail: '', actualModel, handshakeNote: ready ? '握手已就绪' : '盲会话，仅等待自报' };
        members.set(key, entry);
        return entry;
    }

    /**
     * 从名册里取这个成员那一行。
     * @returns 成员行，宿主要么没有 listMembers、要么查不到时为 undefined。
     */
    function readMemberRow({ teams, parent, name }) {
        if (typeof teams?.listMembers !== 'function')
            return undefined;
        try {
            const rows = teams.listMembers(parent);
            const list = Array.isArray(rows) ? rows : [];
            return list.find(candidate => candidate?.name === name && candidate?.role === 'teammate');
        }
        catch {
            return undefined;
        }
    }

    /**
     * 等成员的 phase 变成 active（名册上 `status !== 'provisioning'`）。
     *
     * 宿主的 `sendMessage` 只认 active 成员：`spawnTeammate` 返回时成员还在
     * provisioning，直接发消息会撞进间隙并抛 `active teammate "x" not found`。
     *
     * @returns 成员行；宿主没有 `listMembers` 时返回 undefined（降级成原有时序）。
     * @throws MemberNotReady 成员失败或超时还在 provisioning。
     */
    async function waitActive({ teams, parent, name, signal, timeoutMs = activeTimeoutMs }) {
        if (typeof teams?.listMembers !== 'function') {
            // 降级：宿主没有名册接口，没法轮询 status，睡一小段再按原来的路走。
            await new Promise(resolve => setTimeout(resolve, Math.min(ACTIVE_STEP_MS, Math.max(20, timeoutMs))));
            return undefined;
        }
        const step = Math.min(ACTIVE_STEP_MS, Math.max(20, timeoutMs));
        const startedAt = Date.now();
        for (;;) {
            const row = readMemberRow({ teams, parent, name });
            if (row !== undefined) {
                if (row.status === 'failed')
                    throw new MemberNotReady(failedReasonOf(row));
                if (row.status !== 'provisioning')
                    return row;
            }
            if (signal?.aborted === true)
                throw new MemberNotReady('派单被取消');
            if (Date.now() - startedAt > timeoutMs)
                throw new MemberNotReady('成员一直停在 provisioning');
            await new Promise(resolve => setTimeout(resolve, step));
        }
    }

    /**
     * 团队里是否已经有这个成员（上一个会话建的也算）。
     * @returns `{ sessionId, name }`，没有时 undefined。
     */
    async function findExistingMember({ teams, parent, name }) {
        if (typeof teams.listMembers !== 'function')
            return undefined;
        try {
            const rows = teams.listMembers(parent);
            const list = Array.isArray(rows) ? rows : [];
            const row = list.find(candidate => candidate?.name === name && candidate?.role === 'teammate');
            if (row === undefined || typeof row.id !== 'string' || row.id === '')
                return undefined;
            return { sessionId: row.id, name: row.name, status: row.status };
        }
        catch (error) {
            logger?.warn?.(`dsh-agent-foreman: 读团队名册失败：${errorMessageOf(error)}`);
            return undefined;
        }
    }

    /**
     * 等新建成员的**握手轮**跑完，避免把迟到的握手回复当成工单结果。
     *
     * 判定刻意用事件而不是宿主状态：状态可能长期停在 running（刷新滞后、
     * 或该 agent 被路由占着），只看状态会一直等满窗口。而握手轮结束时，
     * 会话里必然多出一条 assistant/message——那是不可逆的事实。
     *
     * @returns 握手足矣判断为"跑完了"就 true；窗口内没看到就 false。
     */
    async function waitHandshakeDone(sessionId, signal, timeoutMs = NEW_MEMBER_IDLE_MS) {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const startedAt = Date.now();
        // 先探一次"可观测性"：会话事件与宿主状态两条通道都读不到时，再等也只是
        // 干耗窗口（15 秒起步），而且拿不到任何证据。这种情况下直接认输，让本单
        // 用父会话模型跑——慢一点没关系，但绝不能无谓地烧掉整单预算。
        if ((await sessionEventSummary(sessionId)) === undefined && agentStatusOf(sessionId) === undefined)
            return false;
        for (;;) {
            if (signal?.aborted === true)
                return false;
            // 必须等**握手回复落地**（出现 assistant 正文），不能拿状态短路：
            // 成员在被投递工单前就是 idle，若拿"状态非 running"当完成信号，
            // 会在握手回复到达前就继续往下走，导致 baseline 早于握手回复，
            // 那条握手回复（例如"共享任务板上还没有工单"）会被误当成本单产物
            // 交回去——线上实测正是这样交回一份答非所问的正文。
            const now = await sessionEventSummary(sessionId);
            if (now !== undefined && now.assistant > 0)
                return true;
            if (now === undefined) {
                // 事件读不到时才退化成看状态：这种情况下拿不到握手证据，
                // 只能假设它跑完了，让上层按超时兜底。
                const status = agentStatusOf(sessionId);
                if (status !== undefined && status !== 'running')
                    return true;
            }
            if (Date.now() - startedAt > Math.min(timeoutMs, IDLE_WAIT_BUDGET_MS))
                return false;
            await sleep(WAIT_STEP_MS);
        }
    }

    /**
     * 会话里各类事件的数量快照。
     * @returns `{ total, assistant }`；会话读不到时 undefined。
     */
    async function sessionEventSummary(sessionId) {
        // "读不到会话"与"会话存在但事件为空"必须分开：
        // 新建成员刚 spawn 出来时事件就是空的，那是合法状态；只有连会话对象
        // 本身都拿不到，才叫读不到。把空事件冒充 undefined，会让 baseline 变 -1，
        // 整条收活路径被判报废——这是之前白等两分钟的最后一环。
        const readable = await resolveSession(sessionId);
        if (readable === undefined)
            return undefined;
        let events = [];
        try {
            events = readable.snapshotEvents?.() ?? [];
        }
        catch {
            events = [];
        }
        return {
            total: Array.isArray(events) ? events.length : 0,
            assistant: Array.isArray(events)
                ? events.filter(event => event?.type === 'assistant/message').length
                : 0,
        };
    }

    /**
     * 拿到成员会话对象，两条通道都试：`sessions` 服务，或 `agents` 注册表里
     * 那个活 agent 的 `session`。
     *
     * 团队成员是**子智能体会话**，`sessions.get(id)` 只返回活的普通会话、查不到
     * 它；`agents` 这条通道才是能稳定读到的那条。
     *
     * @returns 会话对象；两条都拿不到时 undefined。
     */
    async function resolveSession(sessionId) {
        return observeTeamSession(ctx, sessionId);
    }

    /** 宿主报告的成员状态；读不到时 undefined。 */
    function agentStatusOf(sessionId) {
        try {
            const agents = ctx.get('agents') ?? ctx.root?.get?.('agents');
            const agent = agents?.get?.(sessionId);
            const status = agent?.status ?? agent?.state;
            return typeof status === 'string' && status !== '' ? status : undefined;
        }
        catch {
            return undefined;
        }
    }

    function errorMessageOf(error) {
        return String(error?.message ?? error).slice(0, 200);
    }

    async function dispatchNative({ order, parent, prompt, signal, policy }) {
        const teams = service();
        let entry;
        try {
            entry = await ensureMember({ member: order.member, signal, parent, maxDepth: policy.maxDepth });
        }
        catch (error) {
            if (error instanceof MemberNotReady) {
                // 成员没起来不该抛给用户：交回引擎退回普通模式。
                logger?.warn?.(`dsh-agent-foreman: 团队成员未就绪：${error.message}`);
                return { ok: false, reason: error.message };
            }
            throw error;
        }
        const { sessionId, name, switchStatus, switchDetail, actualModel } = entry;
        order.childId = sessionId;
        // 先立一块「共享任务」再发消息：宿主的团队面板只认任务板，
        // 光发消息的话那边永远显示「暂无共享任务」。
        const task = await openTask({ teams, parent, order, prompt, name });
        // baseline 必须在发消息**之前**取：消息一投进去，成员会话里就会多出
        // user/message，取晚了会把工单本身当成「还没投递」（判成 no-start）。
        //
        // "取不到"和"真的是 0"必须区分：会话服务这次拿不到时，若冒充 0，后面
        // 读回复会从会话开头扫，命中上一单的旧正文——把旧结果当本单交付，比超时
        // 危险得多。所以先重试几次争取拿到真值，实在拿不到才退 -1 哨兵。
        let baseline = await eventCount(sessionId);
        for (let attempt = 0; attempt < 5 && baseline < 0; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, WAIT_STEP_MS));
            baseline = await eventCount(sessionId);
        }
        order.baselineNote = `baseline=${baseline}`;
        // baseline 读不到（成员会话不在插件可见范围内）**不再是致命问题**：
        // 产物回收已有第二条通道——承包商按提示词调用 `foreman_report` 自报，
        // 插件把摘要写进 order.reportOutput。所以照样投递、照样等，只是等的
        // 目标从"读会话正文"换成"等自报"。这正是 dsh-agent-teams 的做法：
        // 它从不读成员会话，产物全靠成员自报到插件自己的状态层。
        if (baseline < 0)
            order.baselineNote += '（会话读不到，走自报通道）';
        // 发消息前再确认一次：从 ensureMember 到这里之间成员理论上不会退回
        // provisioning，但宿主驳回时把原因带回去，比抛原始错误好读。
        try {
            await waitActive({ teams, parent, name, signal });
            await teams.sendMessage(parent, {
                target: name,
                content: [{ type: 'text', text: prompt }],
                signal,
            });
        }
        catch (error) {
            await closeTask({ teams, parent, task, done: false });
            if (error instanceof MemberNotReady)
                return { ok: false, reason: error.message };
            throw error;
        }
        // 收活：自报优先，会话正文兜底。
        //
        // 为什么自报优先：成员的子会话宿主可能读不到（sessions.get 查不到子智能体
        // 会话），但 `foreman_report` 是我们自己注册的工具、走自己的存储，不受那个
        // 限制。而且自报是成员**主动**提交的最终结论，比回收会话里最后一条 assistant
        // 正文更可靠（后者可能是中间过程的话）。
        const delivery = await waitForDelivery({
            order, sessionId, baseline, signal, timeoutMs: policy.timeoutSeconds * 1000,
        });
        if (delivery.kind !== 'report' && delivery.kind !== 'session') {
            await closeTask({ teams, parent, task, done: false });
            // 诊断信息一并带回：超时时最需要知道的是「到底投递没有、基线是多少」，
            // 而不是只有一句「成员超时没回」——那没法区分是没派出去还是没收到。
            const diag = `${order.baselineNote ?? ''}${entry?.handshakeNote === undefined ? '' : ` · ${entry.handshakeNote}`}`;
            return { ok: false, reason: `${WAIT_REASON[delivery.kind] ?? delivery.kind}${diag === '' ? '' : `（${diag}）`}` };
        }
        if (delivery.kind === 'report' && agentStatusOf(sessionId) === 'running') {
            try { teams.interrupt?.(parent, name); } catch {}
            const subagents = ctx.get('subagents') ?? ctx.root?.get?.('subagents');
            await subagents?.drainChildren?.(parent, [sessionId]);
        }
        const text = delivery.text;
        const viaPart = delivery.kind === 'report' ? '自报' : '会话正文';
        await closeTask({ teams, parent, task, done: true });
        const taskPart = task === undefined ? '' : ` · 共享任务 ${task.id}`;
        const modelPart = modelNoteOf(order.member, actualModel);
        const switchPart = switchStatus === 'switched' && switchDetail === ''
            ? ''
            : `（模型切换：${switchStatus}${switchDetail === '' ? '' : ` · ${switchDetail}`}）`;
        const routePart = `${order.member.provider}/${order.member.model}${order.member.reasoningEffort === '' ? '' : `@${order.member.reasoningEffort}`}`;
        return {
            ok: true,
            sessionId,
            text,
            actualModel,
            actualRoute: routeFromSession(await resolveSession(sessionId)),
            // 末尾固定追加宿主回显的实际模型：名册说一套、成员跑另一套时用户才看得见。
            note: `原生团队成员 ${name} · ${routePart}${switchPart}${taskPart} · 回收：${viaPart}${modelPart === '' ? '' : ` · ${modelPart}`}`,
        };
    }

    /**
     * 在团队的共享任务板上立一块任务并派给它的人。
     *
     * 宿主语义：`createTask` 建出来的任务要 `reassign` 给成员才会变成
     * `in_progress`（只有 Lead 能 reassign，正好是这里）。任何一步失败都不
     * 影响派单本身，只是团队面板里看不到这块任务。
     *
     * @returns 任务视图（`{ id, revision }`），没建成时 undefined。
     */
    async function openTask({ teams, parent, order, prompt, name }) {
        if (typeof teams.createTask !== 'function')
            return undefined;
        try {
            const created = await teams.createTask(parent, {
                subject: `${order.id} ${order.title}`.slice(0, 200),
                description: prompt.slice(0, 16000),
            });
            const assigned = await teams.updateTask(parent, {
                taskId: created.id,
                expectedRevision: created.revision,
                action: 'reassign',
                owner: name,
            });
            return { id: assigned?.id ?? created.id, revision: assigned?.revision ?? created.revision };
        }
        catch (error) {
            logger?.warn?.(`dsh-agent-foreman: 建共享任务失败：${errorMessageOf(error)}`);
            return undefined;
        }
    }

    /** 把共享任务收尾：成功→completed，失败→删掉（别在面板上挂一块假进行中）。 */
    async function closeTask({ teams, parent, task, done }) {
        if (task === undefined || typeof teams.updateTask !== 'function')
            return;
        try {
            await teams.updateTask(parent, {
                taskId: task.id,
                expectedRevision: task.revision,
                action: done ? 'complete' : 'delete',
            });
        }
        catch (error) {
            logger?.warn?.(`dsh-agent-foreman: 收尾共享任务 ${task.id} 失败：${errorMessageOf(error)}`);
        }
    }

    /** 取会话对象：`sessions.get` 可能是同步也可能是异步，两种都认。 */
    async function liveSessionOf(sessionId) {
        const sessions = ctx.get('sessions') ?? ctx.root?.get?.('sessions');
        const maybe = sessions?.get?.(sessionId);
        const session = maybe !== null && typeof maybe === 'object' && typeof maybe.then === 'function' ? await maybe : maybe;
        return session ?? undefined;
    }

    /**
     * 成员现在处在哪一步。
     *
     * - `waiting`：我们的工单还没进到成员会话里（它可能还在跑握手那一轮）；
     * - `running`：成员正在干活；
     * - `idle`：工单已经收到、人也停了，可以收产物。
     */
    async function turnPhase(sessionId, baseline) {
        const session = await resolveSession(sessionId);
        const events = session?.snapshotEvents?.() ?? [];
        // baseline < 0 是"取不到基线"的哨兵：此时没法从事件判断这一轮，
        // 只能完全依赖宿主状态，绝不能退成 slice(0) 去看会话开头的旧事件。
        const blind = !Number.isInteger(baseline) || baseline < 0;
        const fresh = blind ? [] : events.slice(baseline);
        const hasAssistant = fresh.some(event => event?.type === 'assistant/message');
        const hasUser = fresh.some(event => event?.type === 'user/message');
        const agents = ctx.get('agents') ?? ctx.root?.get?.('agents');
        const agent = agents?.get?.(sessionId);
        const status = agent?.status ?? agent?.state ?? session?.status ?? session?.agent?.status;
        const running = typeof status === 'string' && status !== '' ? status === 'running' : undefined;

        // 投递判定走两条通道，任一为真即视为已投递：
        //   1. 会话事件里出现 user/message（最直接）；
        //   2. 宿主报告这个成员正 running，或已经产出过 assistant 正文。
        // 只信通道 1 太脆：会话对象取不到、或宿主把投递记在别的事件面上时，
        // 会一直判 waiting 然后空等 START_TIMEOUT_MS 才放弃——那正是之前
        // 「团队模式失败（成员没起来）」的真正来源，而成员其实早就干完了。
        const delivered = hasUser || hasAssistant || running === true;

        if (!delivered)
            return running === false ? 'stalled' : 'waiting';
        if (running === undefined) {
            // 没有状态可看时按事件推断：最后一条是 assistant 就算停了。
            // blind 情况下没有可信事件，无法判断结束——按"还在跑"处理，
            // 由上层超时兜底，而不是凭旧事件误判成 idle 交回旧正文。
            if (blind)
                return 'running';
            for (let index = fresh.length - 1; index >= 0; index -= 1) {
                if (fresh[index]?.type === 'assistant/message')
                    return 'idle';
                if (fresh[index]?.type === 'user/message')
                    return 'running';
            }
            return 'running';
        }
        // 已产出 assistant 正文、且宿主报告不在 running：这一轮确实结束了，
        // 不必等状态自己翻成 inactive（有些宿主会保留 running 到下一次轮询）。
        return running ? 'running' : 'idle';
    }

    /**
     * 等这一轮的产物回来：**自报优先，会话正文兜底**。
     *
     * - 自报：承包商按提示词调用 `foreman_report`，插件把摘要写进
     *   `order.reportOutput`（同一个 order 对象，所以这里能直接看到）。这条路
     *   **不依赖读成员会话**，正是 dsh-agent-teams 的做法——它从不读成员会话，
     *   产物全靠成员自报到插件自己的状态层。
     * - 会话正文：baseline 有效时，读成员会话里这一轮的 assistant 正文。
     *
     * 自报优先的理由：自报是成员**主动**提交的最终结论，比回收会话里最后一条
     * assistant 正文更可靠（后者可能是中间过程的话）。
     *
     * @returns `{ kind: 'report'|'session'|'aborted'|'timeout'|'unobservable', text? }`
     */
    async function waitForDelivery({ order, sessionId, baseline, signal, timeoutMs }) {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const startedAt = Date.now();
        const canReadSession = Number.isInteger(baseline) && baseline >= 0;
        // 两条通道都不可用时没必要等：既读不到会话，也没人会上报。
        if (!canReadSession && order === undefined)
            return { kind: 'unobservable' };
        for (;;) {
            // 1. 自报通道：成员主动提交了交付摘要。
            const reported = typeof order?.reportOutput === 'string' ? order.reportOutput.trim() : '';
            if (reported !== '')
                return { kind: 'report', text: reported };
            // 2. 会话通道：baseline 有效且已产出正文。
            if (canReadSession && agentStatusOf(sessionId) !== 'running'
                && await hasAssistantText(sessionId, baseline) === true) {
                const text = await readReply(sessionId, baseline);
                if (text !== '')
                    return { kind: 'session', text };
            }
            if (signal?.aborted === true)
                return { kind: 'aborted' };
            if (Date.now() - startedAt > timeoutMs)
                return { kind: 'timeout' };
            await sleep(WAIT_STEP_MS);
        }
    }

    async function hasAssistantText(sessionId, baseline) {
        try {
            const text = await readReply(sessionId, baseline);
            return text !== '';
        }
        catch {
            return false;
        }
    }

    /**
     * 成员会话里自 baseline 之后最后一条 assistant 正文。
     *
     * `baseline = -1` 是"取不到基线"的哨兵：此时无法判断哪条正文属于本轮，
     * 直接返回空串。宁可报"读不到回复"，也绝不把上一单的旧正文当成本单交付。
     */
    async function readReply(sessionId, baseline) {
        if (!Number.isInteger(baseline) || baseline < 0)
            return '';
        // 会话对象有两个来源：sessions 服务，或 agents 注册表里的活 agent。
        // 前者取不到时用后者兜底——成员干完活后 agent 可能还在注册表里，
        // 而 sessions.get 已经拿不到了。两条都取不到才放弃（返回空串）。
        const candidates = [];
        const session = await resolveSession(sessionId);
        if (session !== undefined && session !== null)
            candidates.push(session);
        try {
            const agents = ctx.get('agents') ?? ctx.root?.get?.('agents');
            const live = agents?.get?.(sessionId);
            const viaAgent = live?.session;
            if (viaAgent !== undefined && viaAgent !== null && viaAgent !== session)
                candidates.push(viaAgent);
        }
        catch {
            // agents 服务不可用：只用 sessions 那一条。
        }
        for (const candidate of candidates) {
            const events = candidate.snapshotEvents?.() ?? [];
            const fresh = events.slice(Math.max(0, baseline));
            for (let index = fresh.length - 1; index >= 0; index -= 1) {
                const event = fresh[index];
                if (event?.type !== 'assistant/message')
                    continue;
                const text = contentText(event?.data?.message?.content);
                if (text !== '')
                    return text;
            }
        }
        return '';
    }

    /**
     * 成员会话当前的事件条数，用作「这一轮从哪里开始」的基线。
     *
     * 返回 **-1** 表示"这个会话这一次读不到"：调用方必须据此放弃读取正文，
     * 而不是把它当成 0。`0` 的含义是"从会话开头算起"，若因为服务暂时不可用
     * 误退成 0，读回复就会命中最早那一轮的正文，把上一单的旧结果当本单交付。
     * 那是比超时更危险的错误：父智能体会验收一份根本不属于本单的产出。
     */
    /**
     * 成员会话当前的事件条数，用作「这一轮从哪里开始」的基线。
     *
     * 刻意复用 `sessionEventSummary` 的读取通道，而不是自己再读一次
     * `ctx.get('sessions')`：成员是**子智能体会话**，`sessions.get(id)` 只返回活
     * 的普通会话，查不到它；真正能读到的是 `agents` 注册表里那个活 agent 的
     * session。之前这里少了 agents 兜底，于是明明能读到会话，`baseline` 却仍是
     * -1，整条收活路径被判成"不可观测"而报废——线上表现为白等两分钟。
     *
     * 返回 **-1** 表示确实读不到：调用方必须据此放弃，不能冒充 0（`0` 的含义是
     * "从会话开头算起"，会命中上一单的旧正文，把旧结果当本单交付）。
     */
    async function eventCount(sessionId) {
        const summary = await sessionEventSummary(sessionId);
        return summary === undefined ? -1 : summary.total;
    }

    /** One native member has one inbox, not independent parallel writers. */
    async function dispatch(args) {
        delete args.order.reportOutput;
        delete args.order.reportAt;
        const key = cacheKey(args.parent, args.order.member);
        const previous = queues.get(key) ?? Promise.resolve();
        const job = previous.catch(() => {}).then(async () => {
            if (quarantined.has(key)) return { ok: false, reason: '成员前次任务尚未确认停止，已隔离；请等待清理或新建成员' };
            if (args.signal?.aborted) return { ok: false, reason: '派单被取消' };
            const controller = new AbortController();
            const forward = () => controller.abort(args.signal?.reason);
            args.signal?.addEventListener('abort', forward, { once: true });
            const timer = setTimeout(() => controller.abort(new Error('原生团队工单超时')), args.policy.timeoutSeconds * 1000);
            const signal = controller.signal;
            const work = dispatchNative({ ...args, signal });
            let onAbort;
            const aborted = new Promise((_, reject) => {
                onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('派单被取消'));
                signal.addEventListener('abort', onAbort, { once: true });
                if (signal.aborted) onAbort();
            });
            try {
                const result = await Promise.race([work, aborted]);
                if (!result.ok) controller.abort(new Error(result.reason));
                return result;
            } catch (error) {
                if (signal.aborted) return { ok: false, reason: `${errorMessageOf(error)} · ${args.order.baselineNote ?? '建队或握手阶段'}` };
                throw error;
            } finally {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                args.signal?.removeEventListener('abort', forward);
                if (signal.aborted) {
                    // Settle the timeout immediately. Cleanup is observed in
                    // the background; the lane stays quarantined until BOTH
                    // dispatch and native activation teardown confirm closure.
                    quarantined.add(key);
                    const entry = members.get(key);
                    const cleanup = async () => {
                        if (entry) {
                            try { service().interrupt?.(args.parent, entry.name); } catch {}
                            const subagents = ctx.get('subagents') ?? ctx.root?.get?.('subagents');
                            await subagents?.drainChildren?.(args.parent, [entry.sessionId]);
                        }
                        await work.catch(() => {});
                        quarantined.delete(key);
                    };
                    cleanup().catch(error => logger?.warn?.(errorMessageOf(error)));
                }

            }
        });
        queues.set(key, job);
        try { return await job; } finally { if (queues.get(key) === job) queues.delete(key); }
    }

    /** 已建的团队成员（只读快照，给路由里的诊断接口用）。 */
    function snapshot() {
        return [...members.values()].map(entry => ({ ...entry }));
    }

    return { ensureMember, dispatch, snapshot, available: () => findService() !== undefined };
}

const WAIT_REASON = {
    'no-start': '成员没起来（消息可能没投递）',
    timeout: '成员超时没回',
    aborted: '派单被取消',
    // 成员会话与宿主状态都读不到：这一轮的进展无从判断，再等也只是白烧预算。
    // 明确区分开，避免和"成员超时没回"混为一谈——后者是等到了超时，前者是根本看不见。
    unobservable: '读不到成员会话，无法判断这一轮的进展',
};

function teamProvider(ctx) {
    const wanted = 'spawn';
    const names = readSubagentProviders(ctx);
    if (names.length === 0)
        return wanted;
    return names.includes(wanted) ? wanted : names[0];
}

export class TeamUnavailable extends Error {
    constructor(message) {
        super(message);
        this.name = 'TeamUnavailable';
        this.code = 'TEAM_UNAVAILABLE';
    }
}

/**
 * 成员没能变成 active（还停在 provisioning、或直接 failed、或被取消）。
 *
 * 这不是「宿主坏了」，是这类成员这一单派不出去；`dispatch` 把它转成
 * `{ ok:false, reason }`，交给引擎明确报告团队派单失败，不退回替代会话。
 */
export class MemberNotReady extends Error {
    constructor(message) {
        super(message);
        this.name = 'MemberNotReady';
        this.code = 'MEMBER_NOT_READY';
    }
}
