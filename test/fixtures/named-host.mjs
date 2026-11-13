import assert from 'node:assert/strict';

export function namedHost({ enabled = true } = {}) {
    const agents = new Map(), sessions = new Map(), rows = [];
    const specs = [], sent = [], interrupted = [], tasks = [], idleWaits = [];
    const signals = { listDescendants: [], createTask: [], updateTask: [], sendMessage: [] };
    const hooks = {};
    const idleResolvers = new Map();
    const checkSignal = signal => signal?.throwIfAborted();
    const checkContent = content => {
        assert.ok(Array.isArray(content));
        for (const block of content)
            if (block.type === 'text') assert.equal(typeof block.text, 'string', 'message text must be a string');
    };
    const message = (type, text) => ({ type, data: { message: { content: [{ type: 'text', text }] } } });
    function setStatus(id, status) {
        const agent = agents.get(id);
        assert.ok(agent);
        agent.status = status;
        if (status === 'idle') {
            for (const resolve of idleResolvers.get(id) ?? []) resolve();
            idleResolvers.delete(id);
        }
    }
    function liveAgent(id, options, session) {
        const agent = { id, options, session, status: 'idle', inbox: { nextTurn: [], nextStep: [] },
            whenIdle() {
                idleWaits.push(id);
                if (agent.status === 'idle') return Promise.resolve();
                return new Promise(resolve => {
                    let waiters = idleResolvers.get(id);
                    if (waiters === undefined) idleResolvers.set(id, waiters = []);
                    waiters.push(resolve);
                });
            },
        };
        return agent;
    }
    const parentOptions = { provider: 'parent-provider', model: 'parent-model' };
    const parent = liveAgent('lead', parentOptions, { header: { config: parentOptions }, snapshotEvents: () => [] });
    agents.set(parent.id, parent);
    const provider = { name: 'spawn', prepareContinuable: request => request };
    let toggles = 0;
    const teams = {
        isEnabled: () => enabled,
        setEnabled() { toggles++; throw new Error('The adapter must not change the user selection'); },
        async createTask(caller, request, signal) {
            checkSignal(signal); signals.createTask.push(signal);
            assert.strictEqual(caller, parent); assert.ok(enabled);
            assert.equal(typeof request.subject, 'string', 'task subject must be a string');
            assert.ok(request.subject.trim());
            assert.equal(typeof request.description, 'string', 'task description must be a string');
            const task = { id: 'T-' + (tasks.length + 1), revision: 1, status: 'pending', ...request };
            tasks.push(task);
            return { ...task };
        },
        async updateTask(caller, request, signal) {
            checkSignal(signal); signals.updateTask.push(signal);
            assert.strictEqual(caller, parent); assert.ok(enabled);
            const task = tasks.find(task => task.id === request.taskId);
            assert.ok(task);
            assert.equal(request.expectedRevision, task.revision);
            if (request.action === 'reassign') {
                if (request.owner === undefined) {
                    delete task.ownerId; delete task.ownerName; task.status = 'pending';
                } else {
                    const child = rows.find(row => row.id === request.owner && row.parentId === parent.id && row.kind === 'child');
                    assert.ok(child && sessions.has(child.id), 'task owner must be a created child Session id');
                    task.ownerId = child.id; task.ownerName = child.path; task.status = 'in_progress';
                }
            } else if (request.action === 'complete') task.status = 'completed';
            else if (request.action === 'delete') task.status = 'deleted';
            else assert.fail('unsupported fixture task action: ' + request.action);
            task.revision += 1;
            return { ...task };
        },
    };
    async function materialize(spec) {
        checkSignal(spec.signal);
        assert.equal('request' in spec, false, 'rc.2 rejects the legacy nested request');
        assert.strictEqual(spec.parent, parent);
        assert.equal(spec.provider, 'spawn');
        assert.equal(spec.delivery, 'parent');
        assert.equal(typeof spec.name, 'string'); assert.ok(spec.name);
        checkContent(spec.prompt);
        specs.push(spec);
        const id = 'child-' + specs.length;
        const config = { ...parent.options, ...spec.agentOptions };
        const events = [message('user/message', '待命'), message('assistant/message', '待命')];
        const session = { id, header: { config }, snapshotEvents: () => events };
        sessions.set(id, session);
        agents.set(id, liveAgent(id, config, session));
        rows.push({ id, parentId: parent.id, depth: 1, kind: 'child', mode: 'continuable', name: spec.name, path: spec.name, activity: 'inactive' });
        return { kind: 'continuable', childId: id, result: Promise.resolve({}) };
    }
    const manager = { startLocal: (spec, prepare) => { assert.equal(typeof prepare, 'function'); return materialize(spec); } };
    const subagents = {
        list: () => ['spawn'], rootOf: () => parent, namesOf: () => ({ self: 'lead' }),
        async resolveName(_caller, name, signal) { checkSignal(signal); return rows.find(row => row.path === name)?.id ?? name; },
        async listDescendants(id, signal) {
            checkSignal(signal); signals.listDescendants.push(signal);
            assert.equal(id, parent.id);
            await hooks.listDescendants?.({ id, signal });
            checkSignal(signal);
            return [...rows];
        },
        startActivation: materialize,
        expectProvider(name) { assert.equal(name, 'spawn'); return provider; },
        assertCapabilities() {}, requireManager: () => manager,
        assertProviderCurrent(current) { assert.strictEqual(current, provider); },
        async sendMessage(caller, target, content, { signal }) {
            checkSignal(signal); signals.sendMessage.push(signal);
            assert.strictEqual(caller, parent); checkContent(content);
            const session = sessions.get(target);
            assert.ok(session, 'only a recorded direct child may receive the work');
            sent.push({ target, content });
            setStatus(target, 'running');
            session.snapshotEvents().push(message('user/message', '工单'));
            if (hooks.delivery !== undefined) {
                await hooks.delivery({ target, content, session, signal });
            } else {
                session.snapshotEvents().push(message('assistant/message', '交付-' + sent.length));
                setStatus(target, 'idle');
            }
            return 'message-' + sent.length;
        },
        interrupt(target, authority) {
            assert.strictEqual(authority.agent, parent); assert.equal(authority.kind, 'ancestor');
            interrupted.push(target);
            // Like rc.2, interrupt returns before the Agent has necessarily stopped.
        },
    };
    const services = { agentTeams: teams, subagents, agents: { get: id => agents.get(id) }, sessions: { get: id => sessions.get(id) } };
    const ctx = { get: name => services[name] };
    subagents.ctx = ctx;
    return { ctx, teams, subagents, parent, agents, sessions, rows, specs, sent, interrupted, tasks,
        services, signals, hooks, idleWaits, setStatus, toggles: () => toggles };
}
