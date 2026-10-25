import { readSubagentProviders } from './catalog.js';
/**
 * 团队模式：把承包商做成宿主的**智能体团队**成员来派单。
 *
 * 为什么要有这条路：普通模式走 `subagents.startActivation`，子智能体只在
 * 父会话的「子智能体」计数里出现，模型靠 `agentOptions` 在会话创建时就定死。
 * 用户要的是成员出现在「智能体团队」区、并且能自己换模型——那就得走团队服务：
 *
 * 1. `agentTeams.spawnTeammate(lead, member)` 建一个真成员（它自己的会话）；
 * 2. `sessions.selectModel(...)` 把成员会话的模型换成承包商配的那套；
 * 3. `agentTeams.sendMessage(lead, { target, content })` 把工单当团队消息发过去；
 * 4. 等它那一轮跑完，从它的会话事件里把交付正文捞回来。
 *
 * 这套依赖宿主三个服务，任何一步不可用都**不抛给用户**：`dispatch()` 返回
 * `{ ok: false, reason }`，由引擎退回普通模式（见 `lib/engine.js` 的 `#runOrder`）。
 */

/** 成员首次进场只回一句话，真正的工单随后用消息发，避免开局就跑一个大任务。 */
const HANDSHAKE = '待命。收到工单后用你的工具干活，干完把结论写在回复里；不要反问，不要等确认。';

const WAIT_STEP_MS = 400;
/** 等成员空闲（好切模型）的上限。 */
const IDLE_TIMEOUT_MS = 120000;

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
    const ascii = String(member.name ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    const candidate = ascii !== '' && ascii !== 'lead' && /^[a-z]/.test(ascii) ? ascii : 'worker';
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
export function createTeamRunner({ ctx, logger }) {
    /** 合同商 id → 团队成员（同一轮里复用，避免每张单都新开成员）。 */
    const members = new Map();
    /** 已经用掉的成员名，保证 `worker` / `worker-2` 不撞车。 */
    const usedNames = new Set();

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
     * @returns 成员的会话 id。
     */
    async function ensureMember({ member, signal, parent }) {
        const cached = members.get(member.id);
        if (cached !== undefined)
            return cached;
        const teams = service();
        const displayName = teammateName(member, usedNames);
        // 团队名册是持久化的：上次会话里建过的成员还在，再 spawn 同名会被拒
        // （teammate name "worker" was already used in this Team）。所以先认领旧的。
        const existing = await findExistingMember({ teams, parent, name: displayName });
        if (existing !== undefined) {
            await waitIdle(existing.sessionId);
            const switched = await switchModel(existing.sessionId, member);
            const entry = {
                sessionId: existing.sessionId,
                name: existing.name,
                switchStatus: switched.status,
                switchDetail: switched.detail,
            };
            members.set(member.id, entry);
            return entry;
        }
        const created = await teams.spawnTeammate(parent, {
            name: displayName,
            description: `${member.name} · ${member.provider || '跟随当前会话'}/${member.model || '默认模型'}：${member.prompt === '' ? '按工单干活' : member.prompt.slice(0, 80)}`,
            provider: teamProvider(ctx),
            context: 'fresh',
            prompt: [{ type: 'text', text: HANDSHAKE }],
            signal,
        });
        // memberView 的 `id` 就是成员会话的 id（`sessionId` 字段并不存在）。
        const sessionId = created?.member?.id;
        if (typeof sessionId !== 'string' || sessionId === '')
            throw new TeamUnavailable('spawnTeammate 没返回成员会话');
        // 投递只认“成员名”，所以名字也要记住。
        const name = typeof created?.member?.name === 'string' ? created.member.name : displayName;
        // 刚建出来的成员正在跑握手那一轮，此时会话被 subagent routing 占着，
        // selectModel 会以 session/agent-busy 拒绝；等它停了再切。
        await waitIdle(sessionId);
        const switched = await switchModel(sessionId, member);
        const entry = { sessionId, name, switchStatus: switched.status, switchDetail: switched.detail };
        members.set(member.id, entry);
        return entry;
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
            if (row.status === 'failed' || row.status === 'provisioning')
                return undefined;
            return { sessionId: row.id, name: row.name };
        }
        catch (error) {
            logger?.warn?.(`dsh-agent-foreman: 读团队名册失败：${errorMessageOf(error)}`);
            return undefined;
        }
    }

    /**
     * 等成员这一轮跑完（停止在等下一句）。
     *
     * 宿主的 `sessions.selectModel` 在 agent 忙时会拒绝（`session/agent-busy`），
     * 所以切模型前必须先把它等到空闲。等不到也不算错——切模型本来就可能失败，
     * 只是会退化成「跟着当前会话的模型」。
     */
    async function waitIdle(sessionId, timeoutMs = IDLE_TIMEOUT_MS) {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const agents = ctx.get('agents') ?? ctx.root?.get?.('agents');
        const startedAt = Date.now();
        for (;;) {
            let status;
            try {
                const agent = agents?.get?.(sessionId);
                status = agent?.status ?? agent?.state;
            }
            catch {
                status = undefined;
            }
            if (status !== 'running')
                return true;
            if (Date.now() - startedAt > timeoutMs)
                return false;
            await sleep(WAIT_STEP_MS);
        }
    }

    /**
     * 把成员会话的模型切成承包商配的那套。
     *
     * 宿主 `selectModel` 会校验 provider/model/思考等级，任何一项不被接受都会抛
     * `session/model-unavailable`；思考等级最容易不匹配（同一个模型在不同
     * provider 上支持的档位不一样），所以它失败时去掉档次再试一次。
     *
     * @returns `{ status, detail }`：`switched` / `follow-lead` / `unsupported` / `failed`。
     */
    async function switchModel(sessionId, member) {
        if (member.provider === '' || member.model === '')
            return { status: 'follow-lead', detail: '' };
        const controller = ctx.get('sessionController');
        const select = controller?.selectModel;
        if (typeof select !== 'function')
            return { status: 'unsupported', detail: '宿主没有 sessionController.selectModel' };
        const attempt = async (withEffort) => await select.call(controller, {
            sessionId,
            provider: member.provider,
            model: member.model,
            ...(withEffort && member.reasoningEffort !== '' ? { reasoningEffort: member.reasoningEffort } : {}),
        });
        try {
            const result = await attempt(true);
            const applied = result?.selected ?? undefined;
            return { status: 'switched', detail: applied === undefined ? '' : `${applied.provider}/${applied.model}` };
        }
        catch (error) {
            const first = errorMessageOf(error);
            if (member.reasoningEffort !== '') {
                try {
                    const retry = await attempt(false);
                    const applied = retry?.selected ?? undefined;
                    return { status: 'switched', detail: `${applied === undefined ? '' : `${applied.provider}/${applied.model}`}（${first}，已去掉思考等级重试）` };
                }
                catch (second) {
                    const detail = errorMessageOf(second);
                    logger?.warn?.(`dsh-agent-foreman: 切换成员模型失败：${detail}`);
                    return { status: 'failed', detail };
                }
            }
            logger?.warn?.(`dsh-agent-foreman: 切换成员模型失败：${first}`);
            return { status: 'failed', detail: first };
        }
    }

    /** 把宿主的 RemoteError 之类的错误压成一行文字。 */
    function errorMessageOf(error) {
        if (error === null || error === undefined)
            return 'unknown';
        const code = error.code === undefined ? '' : `${String(error.code)}: `;
        return `${code}${String(error.message ?? error)}`.slice(0, 200);
    }

    /**
     * 派一张工单给指定成员并等它交付。
     *
     * @returns `{ ok: true, text, sessionId, note }` 或 `{ ok: false, reason }`。
     */
    async function dispatch({ order, parent, prompt, signal, policy }) {
        const teams = service();
        const { sessionId, name, switchStatus, switchDetail } = await ensureMember({ member: order.member, signal, parent });
        // 先立一块「共享任务」再发消息：宿主的团队面板只认任务板，
        // 光发消息的话那边永远显示「暂无共享任务」。
        const task = await openTask({ teams, parent, order, prompt, name });
        const baseline = eventCount(sessionId);
        await teams.sendMessage(parent, {
            target: name,
            content: [{ type: 'text', text: prompt }],
            signal,
        });
        const wait = await waitForTurn({ sessionId, baseline, signal, timeoutMs: policy.timeoutSeconds * 1000 });
        if (wait !== 'done') {
            await closeTask({ teams, parent, task, done: false });
            return { ok: false, reason: WAIT_REASON[wait] };
        }
        const text = await readReply(sessionId, baseline);
        await closeTask({ teams, parent, task, done: true });
        const taskPart = task === undefined ? '' : ` · 共享任务 ${task.id}`;
        return {
            ok: true,
            sessionId,
            text,
            note: `${order.member.provider}/${order.member.model}${order.member.reasoningEffort === '' ? '' : `@${order.member.reasoningEffort}`}${switchStatus === 'switched' && switchDetail === '' ? '' : `（模型切换：${switchStatus}${switchDetail === '' ? '' : ` · ${switchDetail}`}）`}${taskPart}`,
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
    async function sessionOf(sessionId) {
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
        const session = await sessionOf(sessionId);
        const events = session?.snapshotEvents?.() ?? [];
        const fresh = events.slice(Math.max(0, baseline));
        const delivered = fresh.some(event => event?.type === 'user/message');
        const agents = ctx.get('agents') ?? ctx.root?.get?.('agents');
        const agent = agents?.get?.(sessionId);
        const status = agent?.status ?? agent?.state ?? session?.status ?? session?.agent?.status;
        const running = typeof status === 'string' && status !== '' ? status === 'running' : undefined;
        if (!delivered)
            return running === false ? 'stalled' : 'waiting';
        if (running === undefined) {
            // 没有状态可看时按事件推断：最后一条是 assistant 就算停了。
            for (let index = fresh.length - 1; index >= 0; index -= 1) {
                if (fresh[index]?.type === 'assistant/message')
                    return 'idle';
                if (fresh[index]?.type === 'user/message')
                    return 'running';
            }
            return 'running';
        }
        return running ? 'running' : 'idle';
    }

    /** 等成员收到工单并跑完。 */
    async function waitForTurn({ sessionId, baseline, signal, timeoutMs }) {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const startedAt = Date.now();
        for (;;) {
            const phase = await turnPhase(sessionId, baseline);
            if (phase === 'running' || phase === 'idle' || phase === 'stalled')
                break;
            if (signal?.aborted === true)
                return 'aborted';
            if (Date.now() - startedAt > START_TIMEOUT_MS)
                return 'no-start';
            await sleep(WAIT_STEP_MS);
        }
        for (;;) {
            const phase = await turnPhase(sessionId, baseline);
            if (phase === 'idle')
                return 'done';
            if (phase === 'stalled')
                return 'no-start';
            if (signal?.aborted === true)
                return 'aborted';
            if (Date.now() - startedAt > timeoutMs)
                return 'timeout';
            await sleep(WAIT_STEP_MS);
        }
    }

    /** 成员会话里自 baseline 之后最后一条 assistant 正文。 */
    async function readReply(sessionId, baseline) {
        const session = await sessionOf(sessionId);
        if (session === undefined || session === null)
            return '';
        const events = session.snapshotEvents?.() ?? [];
        const fresh = events.slice(Math.max(0, baseline));
        for (let index = fresh.length - 1; index >= 0; index -= 1) {
            const event = fresh[index];
            if (event?.type !== 'assistant/message')
                continue;
            const text = contentText(event?.data?.message?.content);
            if (text !== '')
                return text;
        }
        return '';
    }

    function eventCount(sessionId) {
        const session = ctx.get('sessions')?.get?.(sessionId);
        try {
            return session === undefined || session === null ? 0 : session.snapshotEvents().length;
        }
        catch {
            return 0;
        }
    }

    /** 已建的团队成员（只读快照，给路由里的诊断接口用）。 */
    function snapshot() {
        return [...members.entries()].map(([contractorId, entry]) => ({ contractorId, ...entry }));
    }

    return { ensureMember, dispatch, snapshot, available: () => findService() !== undefined };
}

const WAIT_REASON = {
    'no-start': '成员没起来（消息可能没投递）',
    timeout: '成员超时没回',
    aborted: '派单被取消',
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
