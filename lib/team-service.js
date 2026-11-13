import { usesFlatActivationSpec, startCompatibleActivation } from './activation.js';

const adapters = new WeakMap();

function serviceOf(ctx, name) {
    for (const scope of [ctx, ctx?.root]) {
        try {
            const service = scope?.get?.(name);
            if (service !== undefined && service !== null) return service;
        } catch { /* Try the root service scope. */ }
    }
    return undefined;
}

/** Keep the old roster API; rc.2 uses public named subagents and a separate task board. */
export function resolveTeamService(ctx) {
    const teams = serviceOf(ctx, 'agentTeams');
    if (teams === undefined) return undefined;
    if (typeof teams.spawnTeammate === 'function') return teams;
    const subagents = serviceOf(ctx, 'subagents');
    if (!usesFlatActivationSpec(subagents) || typeof subagents?.startActivation !== 'function'
        || typeof subagents.sendMessage !== 'function' || typeof subagents.interrupt !== 'function'
        || typeof teams.isEnabled !== 'function'
        || typeof teams.createTask !== 'function' || typeof teams.updateTask !== 'function') return undefined;
    let bySubagents = adapters.get(teams);
    if (bySubagents === undefined) adapters.set(teams, bySubagents = new WeakMap());
    let adapter = bySubagents.get(subagents);
    if (adapter === undefined) {
        adapter = namedTeamAdapter(ctx, teams, subagents);
        bySubagents.set(subagents, adapter);
    }
    return adapter;
}

function namedTeamAdapter(ctx, teams, subagents) {
    const members = new Map();
    const failures = new Map();
    const keyOf = (parent, name) => JSON.stringify([parent.id, name]);
    const selected = caller => teams.isEnabled(caller);
    const checkSelected = caller => {
        if (!selected(caller)) {
            const error = new Error('当前会话未启用智能体团队协作，请先打开团队开关');
            error.code = 'TEAM_DISABLED';
            throw error;
        }
    };
    async function listMembers(parent, signal) {
        signal?.throwIfAborted();
        const entries = await subagents.listDescendants(parent.id, signal);
        signal?.throwIfAborted();
        const agents = serviceOf(ctx, 'agents');
        return entries.filter(entry => entry.parentId === parent.id && entry.depth === 1)
            .flatMap(entry => {
                const name = entry.name ?? entry.path;
                if (typeof name !== 'string' || name === '' || name.includes('/')) return [];
                if (entry.kind !== 'diagnostic' && entry.mode !== 'continuable') return [];
                const failure = failures.get(entry.id);
                const live = agents?.get?.(entry.id);
                const row = {
                    id: entry.id, name, role: 'teammate',
                    status: failure !== undefined || entry.kind === 'diagnostic' ? 'failed'
                        : live?.status ?? live?.state ?? entry.activity ?? 'inactive',
                    ...(live?.options?.model === undefined ? {} : { model: live.options.model }),
                    ...(failure === undefined && entry.kind !== 'diagnostic' ? {}
                        : { diagnostics: [failure ?? entry.reason ?? '成员不可用'] }),
                };
                members.set(keyOf(parent, name), row);
                return [row];
            });
    }
    async function spawnRoutedTeammate(parent, request, { agentOptions, maxDepth } = {}) {
        checkSelected(parent);
        const activation = await startCompatibleActivation(subagents, {
            provider: request.provider, label: request.description, name: request.name,
            delivery: 'parent', signal: request.signal ?? new AbortController().signal,
            request: {
                parent, prompt: request.prompt,
                ...(agentOptions === undefined ? {} : { agentOptions: { ...agentOptions } }),
                ...(maxDepth === undefined ? {} : { maxDepth }),
            },
        });
        const id = activation?.childId;
        if (typeof id !== 'string' || id === '') throw new Error('原生具名子智能体未返回成员会话');
        const member = { id, name: request.name, role: 'teammate', status: 'active' };
        members.set(keyOf(parent, request.name), member);
        // The native manager owns the durable member; observe handshake failure without disposing it.
        activation.result?.catch?.(error => { failures.set(id, String(error?.message ?? error)); });
        return { member };
    }
    async function sendMessage(parent, request) {
        checkSelected(parent);
        const rows = await listMembers(parent, request.signal);
        const member = rows.find(row => row.name === request.target);
        if (member === undefined || member.status === 'failed') throw new Error('找不到可用的原生团队成员：' + request.target);
        return subagents.sendMessage(parent, member.id, request.content, {
            signal: request.signal ?? new AbortController().signal,
        });
    }
    async function updateTask(caller, request, signal) {
        signal?.throwIfAborted();
        checkSelected(caller);
        let translated = request;
        if (request.action === 'reassign' && request.owner !== undefined) {
            const rows = await listMembers(caller, signal);
            const member = rows.find(row => row.id === request.owner)
                ?? rows.find(row => row.name === request.owner);
            if (member === undefined || member.status === 'failed') {
                const error = new Error('找不到要分配任务的直属团队成员：' + request.owner);
                error.code = 'TEAM_MEMBER_NOT_FOUND';
                throw error;
            }
            translated = { ...request, owner: member.id };
        }
        signal?.throwIfAborted();
        checkSelected(caller);
        return teams.updateTask(caller, translated, signal);
    }
    /** Confirm only this member is quiescent; uncertainty keeps the runner isolated. */
    async function drainMember(parent, sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '' || sessionId === parent?.id) return false;
        const agents = serviceOf(ctx, 'agents');
        if (typeof agents?.get !== 'function') return false;
        const agent = agents.get(sessionId);
        if (agent === undefined) return true;
        if (agent === null || typeof agent.whenIdle !== 'function' || typeof agent.status !== 'string'
            || !Array.isArray(agent.inbox?.nextTurn) || !Array.isArray(agent.inbox?.nextStep)) return false;
        let timer;
        try {
            const idle = await Promise.race([
                Promise.resolve().then(() => agent.whenIdle()).then(() => true),
                new Promise(resolve => { timer = setTimeout(() => resolve(false), 20_000); }),
            ]);
            if (!idle) return false;
            const registry = serviceOf(ctx, 'agents');
            if (typeof registry?.get !== 'function') return false;
            const current = registry.get(sessionId);
            if (current === undefined) return true;
            return current === agent && agent.status === 'idle'
                && Array.isArray(agent.inbox?.nextTurn) && agent.inbox.nextTurn.length === 0
                && Array.isArray(agent.inbox?.nextStep) && agent.inbox.nextStep.length === 0;
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }
    return {
        api: 'named-subagents', isEnabled: selected,
        spawnRoutedTeammate,
        spawnTeammate: (parent, request) => spawnRoutedTeammate(parent, request),
        listMembers, sendMessage,
        interrupt(parent, name) {
            const member = members.get(keyOf(parent, name));
            if (member === undefined) throw new Error('找不到要停止的原生团队成员：' + name);
            return subagents.interrupt(member.id, { kind: 'ancestor', agent: parent });
        },
        createTask(caller, request, signal) {
            signal?.throwIfAborted();
            checkSelected(caller);
            return teams.createTask(caller, request, signal);
        },
        updateTask, drainMember,
    };
}
