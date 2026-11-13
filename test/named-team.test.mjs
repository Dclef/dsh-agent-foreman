import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { namedHost } from './fixtures/named-host.mjs';
import { resolveTeamService } from '../lib/team-service.js';
import { spawnNativeTeammate, nativeRoutingAvailable } from '../lib/native-team.js';
import { createTeamRunner } from '../lib/team.js';

const member = { id: 'worker', name: '力工', provider: 'provider-a', model: 'model-a', reasoningEffort: 'high', prompt: '' };
const policy = { teamProvider: 'spawn', maxDepth: 2, timeoutSeconds: 10 };
const request = name => ({ name, description: name, provider: 'spawn', context: 'fresh', prompt: [{ type: 'text', text: '待命' }], signal: new AbortController().signal });

test('rc.2 named members preserve distinct creation routes without the removed native roster', async () => {
    const host = namedHost();
    const teams = resolveTeamService(host.ctx);
    assert.equal(teams.api, 'named-subagents');
    assert.equal(nativeRoutingAvailable(teams), true);
    assert.strictEqual(teams, resolveTeamService(host.ctx));
    const original = host.subagents.startActivation;
    const parentOptions = { ...host.parent.options };
    const children = await Promise.all(['alpha', 'beta'].map(name => spawnNativeTeammate({ teams, parent: host.parent, request: request(name), agentOptions: { provider: 'provider-' + name, model: 'model-' + name, reasoningEffort: 'high' }, maxDepth: 2 })));
    assert.equal(new Set(children.map(child => child.member.id)).size, 2);
    assert.deepEqual(host.specs.map(spec => [spec.name, spec.agentOptions.model, spec.agentOptions.reasoningEffort, spec.maxDepth]), [['alpha', 'model-alpha', 'high', 2], ['beta', 'model-beta', 'high', 2]]);
    assert.strictEqual(host.subagents.startActivation, original);
    assert.deepEqual(host.parent.options, parentOptions);
});

test('rc.2 team dispatch delivers, claims and completes the task, then reuses the durable named member', async () => {
    const host = namedHost();
    let runner = createTeamRunner({ ctx: host.ctx, logger: {} });
    const dispatch = async id => runner.dispatch({ parent: host.parent, order: { id, title: id, task: id, member }, prompt: id, policy, signal: new AbortController().signal });
    const first = await dispatch('one');
    assert.equal(first.ok, true, first.reason);
    assert.equal(first.text, '交付-1');
    assert.deepEqual(first.actualRoute, { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' });
    // A new runner simulates plugin state reconstruction; membership comes from the persisted catalog.
    runner = createTeamRunner({ ctx: host.ctx, logger: {} });
    const second = await dispatch('two');
    assert.equal(second.ok, true, second.reason);
    assert.equal(second.text, '交付-2');
    assert.equal(host.specs.length, 1);
    assert.equal(host.sent.length, 2);
    assert.equal(host.tasks.length, 2);
    assert.ok(host.tasks.every(task => task.status === 'completed' && task.ownerId === host.rows[0].id));
    assert.equal(host.specs[0].agentOptions.model, member.model);
});

test('rc.2 disabled teamwork is respected before any member, task or message is created', async () => {
    const host = namedHost({ enabled: false });
    const runner = createTeamRunner({ ctx: host.ctx, logger: {} });
    const result = await runner.dispatch({ parent: host.parent, order: { id: 'disabled', member }, prompt: '', policy, signal: new AbortController().signal });
    assert.equal(result.ok, false);
    assert.match(result.reason, /团队开关/);
    assert.equal(host.specs.length + host.tasks.length + host.sent.length, 0);
    assert.equal(host.toggles(), 0);
});

test('rc.2 listing filters descendants and diagnostics; interruption uses the exact admitted child id', async () => {
    const host = namedHost();
    const teams = resolveTeamService(host.ctx);
    const child = await spawnNativeTeammate({ teams, parent: host.parent, request: request('worker') });
    host.rows.push({ id: 'unrelated', parentId: 'elsewhere', depth: 1, kind: 'child', mode: 'continuable', name: 'worker' });
    host.rows.push({ id: 'nested', parentId: child.member.id, depth: 2, kind: 'child', mode: 'continuable', name: 'nested', path: 'worker/nested' });
    host.rows.push({ id: 'broken', parentId: host.parent.id, depth: 1, kind: 'diagnostic', path: 'broken', reason: 'corrupt' });
    const rows = await teams.listMembers(host.parent);
    assert.deepEqual(rows.map(row => row.name), ['worker', 'broken']);
    assert.equal(rows[1].status, 'failed');
    await teams.sendMessage(host.parent, { target: 'worker', content: [{ type: 'text', text: 'work' }] });
    teams.interrupt(host.parent, 'worker');
    assert.deepEqual(host.interrupted, [child.member.id]);
    assert.deepEqual(host.sent.map(message => message.target), [child.member.id]);
    await assert.rejects(teams.sendMessage(host.parent, { target: 'broken', content: [] }), /可用的原生团队成员/);
});

async function facadeChild(host, name = 'worker') {
    const teams = resolveTeamService(host.ctx);
    const child = await spawnNativeTeammate({ teams, parent: host.parent, request: request(name) });
    return { teams, id: child.member.id };
}

test('facade task owner mapping selects exact direct-child names and ids without root-relative resolution', async () => {
    const host = namedHost();
    const { teams, id: alpha } = await facadeChild(host, 'alpha');
    const { id: beta } = await facadeChild(host, 'beta');
    host.rows.unshift({ id: 'wrong-tree', parentId: 'elsewhere', depth: 1, kind: 'child', mode: 'continuable', name: 'alpha', path: 'alpha' });
    host.rows.push({ id: 'nested', parentId: alpha, depth: 2, kind: 'child', mode: 'continuable', name: 'nested', path: 'alpha/nested' });
    host.subagents.resolveName = () => assert.fail('local names must not use root-relative resolution');
    const signal = new AbortController().signal;
    const task = await teams.createTask(host.parent, { subject: 'work', description: 'do the work' }, signal);
    const original = Object.freeze({ taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: 'alpha' });
    const assigned = await teams.updateTask(host.parent, original, signal);
    assert.equal(assigned.ownerId, alpha);
    assert.equal(original.owner, 'alpha');
    const reassigned = await teams.updateTask(host.parent, { ...original, expectedRevision: assigned.revision, owner: beta }, signal);
    assert.equal(reassigned.ownerId, beta);
    for (const owner of ['wrong-tree', 'nested', 'alpha/nested', 'missing'])
        await assert.rejects(teams.updateTask(host.parent, { ...original, expectedRevision: reassigned.revision, owner }, signal), { code: 'TEAM_MEMBER_NOT_FOUND' });
    assert.strictEqual(host.signals.createTask[0], signal);
    assert.ok(host.signals.updateTask.every(received => received === signal));
    assert.strictEqual(host.signals.listDescendants.at(-1), signal);
});

test('facade aborts task creation and assignment before any native mutation', async () => {
    const host = namedHost();
    const { teams } = await facadeChild(host);
    const task = await teams.createTask(host.parent, { subject: 'work', description: '' });
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    controller.abort(reason);
    await assert.rejects(async () => teams.createTask(host.parent, { subject: 'cancelled', description: '' }, controller.signal), error => error === reason);
    await assert.rejects(teams.updateTask(host.parent, { taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: 'worker' }, controller.signal), error => error === reason);
    assert.equal(host.tasks.length, 1);
    assert.equal(host.signals.updateTask.length, 0);
    assert.equal(host.signals.listDescendants.length, 0);
});

test('facade cancellation during direct-child lookup prevents a later task assignment', async () => {
    const host = namedHost();
    const { teams } = await facadeChild(host);
    const task = await teams.createTask(host.parent, { subject: 'work', description: '' });
    const controller = new AbortController();
    const reason = new Error('cancel catalog query');
    host.hooks.listDescendants = () => controller.abort(reason);
    await assert.rejects(teams.updateTask(host.parent, { taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: 'worker' }, controller.signal), error => error === reason);
    assert.strictEqual(host.signals.listDescendants[0], controller.signal);
    assert.equal(host.signals.updateTask.length, 0);
    assert.equal(host.tasks[0].revision, 1);
});

test('fixture rejects legacy owner names and non-string task/message text', async () => {
    const host = namedHost();
    const { id } = await facadeChild(host);
    await assert.rejects(host.teams.createTask(host.parent, { subject: [], description: '' }), /subject must be a string/);
    await assert.rejects(host.teams.createTask(host.parent, { subject: 'work', description: [] }), /description must be a string/);
    const task = await host.teams.createTask(host.parent, { subject: 'work', description: '' });
    await assert.rejects(host.teams.updateTask(host.parent, { taskId: task.id, expectedRevision: 1, action: 'reassign', owner: 'worker' }), /child Session id/);
    await assert.rejects(host.subagents.sendMessage(host.parent, id, [{ type: 'text', text: [] }], { signal: new AbortController().signal }), /text must be a string/);
    assert.equal(host.sent.length, 0);
    assert.equal('drainChildren' in host.subagents, false);
});

test('facade drain waits for the interrupted Agent and does not stop or wait on other members', async t => {
    const host = namedHost();
    const { teams, id } = await facadeChild(host, 'alpha');
    const { id: other } = await facadeChild(host, 'beta');
    host.setStatus(id, 'running'); host.setStatus(other, 'running');
    host.agents.get(other).inbox.nextTurn.push({ text: 'parked work' });
    t.after(() => host.setStatus(id, 'idle'));
    teams.interrupt(host.parent, 'alpha');
    let confirmed = false;
    const drained = teams.drainMember(host.parent, id).then(value => { confirmed = true; return value; });
    await nextTurn();
    assert.equal(confirmed, false, 'fire-and-return interruption does not prove the Agent stopped');
    assert.deepEqual(host.idleWaits, [id]);
    assert.deepEqual(host.interrupted, [id]);
    host.setStatus(id, 'idle');
    assert.equal(await drained, true);
    assert.equal(host.agents.get(other).status, 'running');
    assert.equal(host.agents.get(other).inbox.nextTurn.length, 1);
    assert.deepEqual(host.interrupted, [id]);
});

test('facade drain confirms idle only with empty nextTurn and nextStep queues', async () => {
    const host = namedHost();
    const { teams, id } = await facadeChild(host);
    const agent = host.agents.get(id);
    assert.equal(await teams.drainMember(host.parent, id), true);
    for (const queue of ['nextTurn', 'nextStep']) {
        agent.inbox[queue].push({ text: 'pending' });
        assert.equal(await teams.drainMember(host.parent, id), false, queue);
        assert.equal(agent.inbox[queue].length, 1, 'drain must not discard pending messages');
        agent.inbox[queue].length = 0;
    }
    assert.equal(await teams.drainMember(host.parent, id), true);
    assert.equal(host.interrupted.length, 0);
});

test('facade drain refuses unknown status, inbox or idle API and a still-running Agent', async () => {
    for (const change of [
        agent => { delete agent.status; },
        agent => { delete agent.inbox; },
        agent => { delete agent.inbox.nextStep; },
        agent => { agent.inbox.nextTurn = { length: 0 }; },
        agent => { delete agent.whenIdle; },
        agent => { agent.status = 'running'; agent.whenIdle = () => Promise.resolve(); },
    ]) {
        const host = namedHost();
        const { teams, id } = await facadeChild(host);
        change(host.agents.get(id));
        assert.equal(await teams.drainMember(host.parent, id), false);
    }
});

test('facade drain distinguishes absent Agents from missing services and changed instances', async () => {
    const host = namedHost();
    const { teams, id } = await facadeChild(host);
    const original = host.agents.get(id);
    original.whenIdle = () => { host.agents.set(id, { ...original }); };
    assert.equal(await teams.drainMember(host.parent, id), false);
    host.agents.delete(id);
    assert.equal(await teams.drainMember(host.parent, id), true);
    host.services.agents = undefined;
    assert.equal(await teams.drainMember(host.parent, id), false);
    host.services.agents = { get: () => null };
    assert.equal(await teams.drainMember(host.parent, id), false);
    assert.equal(await teams.drainMember(host.parent, host.parent.id), false);
});

test('facade drain rechecks the current registry after awaiting member idle', async () => {
    for (const replacement of ['missing', 'unknown', 'new-instance', 'same-instance', 'absent']) {
        const host = namedHost();
        const { teams, id } = await facadeChild(host);
        const agent = host.agents.get(id);
        agent.whenIdle = () => {
            host.services.agents = replacement === 'missing' ? undefined : { get: () =>
                replacement === 'unknown' ? null : replacement === 'absent' ? undefined
                    : replacement === 'same-instance' ? agent : { ...agent } };
        };
        assert.equal(await teams.drainMember(host.parent, id), ['same-instance', 'absent'].includes(replacement), replacement);
    }
});

test('facade drain stops waiting after twenty seconds without declaring a running Agent safe', async t => {
    const host = namedHost();
    const { teams, id } = await facadeChild(host);
    host.setStatus(id, 'running');
    const timers = [], cleared = [];
    t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
        const timer = { callback, delay }; timers.push(timer); return timer;
    });
    t.mock.method(globalThis, 'clearTimeout', timer => cleared.push(timer));
    const draining = teams.drainMember(host.parent, id);
    await nextTurn();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 20_000);
    timers[0].callback();
    assert.equal(await draining, false);
    assert.deepEqual(cleared, timers);
    assert.equal(host.agents.get(id).status, 'running');
    assert.equal(host.interrupted.length, 0);
    host.setStatus(id, 'idle');
});

test('facade drain propagates whenIdle failures for the caller to retain isolation', async () => {
    const host = namedHost();
    const { teams, id } = await facadeChild(host);
    const error = new Error('idle state cannot be confirmed');
    host.agents.get(id).whenIdle = () => { throw error; };
    await assert.rejects(teams.drainMember(host.parent, id), value => value === error);
});

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve: value => resolve(value) };
}

function deletionOf(host) {
    const deleted = deferred();
    const original = host.teams.updateTask;
    host.teams.updateTask = async (...args) => {
        const task = await original.apply(host.teams, args);
        if (args[1].action === 'delete') deleted.resolve();
        return task;
    };
    return deleted.promise;
}

const runnerOrder = (id, worker = member) => ({ id, title: id, task: id, member: worker });

test('rc.2 runner keeps a cancelled member isolated until both idle and dispatch cleanup settle', async t => {
    const host = namedHost();
    const runner = createTeamRunner({ ctx: host.ctx, logger: {} });
    const accepted = deferred();
    const deleted = deletionOf(host);
    host.hooks.delivery = () => accepted.resolve();
    const controller = new AbortController();
    const first = runner.dispatch({ parent: host.parent, order: runnerOrder('cancelled'), prompt: 'old work', policy, signal: controller.signal });
    await accepted.promise;
    const id = host.sent[0].target;
    t.after(() => host.setStatus(id, 'idle'));
    controller.abort(new Error('stop old work'));
    const cancelled = await first;
    assert.equal(cancelled.ok, false);
    assert.match(cancelled.reason, /stop old work/);
    assert.equal(host.agents.get(id).status, 'running');
    const blocked = await runner.dispatch({ parent: host.parent, order: runnerOrder('blocked'), prompt: 'must not send', policy });
    assert.equal(blocked.ok, false); assert.match(blocked.reason, /隔离/);
    assert.equal(host.sent.length, 1);
    host.setStatus(id, 'idle');
    await deleted;
    await nextTurn();
    host.sessions.get(id).snapshotEvents().push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'late cancelled output' }] } } });
    delete host.hooks.delivery;
    const next = await runner.dispatch({ parent: host.parent, order: runnerOrder('next'), prompt: 'fresh work', policy });
    assert.equal(next.ok, true, next.reason);
    assert.equal(next.text, '交付-2');
    assert.equal(host.specs.length, 1, 'confirmed idle member is reused');
    assert.equal(host.tasks[0].status, 'deleted');
    assert.equal(host.tasks[1].status, 'completed');
    assert.ok(host.signals.createTask.every(signal => signal instanceof AbortSignal));
    assert.ok(host.signals.updateTask.filter(Boolean).every(signal => signal instanceof AbortSignal));
});

test('rc.2 runner retains cancellation isolation when Agent status or inbox is unknown', async t => {
    for (const unknown of ['status', 'inbox']) {
        const host = namedHost();
        const runner = createTeamRunner({ ctx: host.ctx, logger: {} });
        const accepted = deferred();
        const deleted = deletionOf(host);
        host.hooks.delivery = ({ target }) => { delete host.agents.get(target)[unknown]; accepted.resolve(); };
        const controller = new AbortController();
        const first = runner.dispatch({ parent: host.parent, order: runnerOrder('cancel-' + unknown), prompt: 'cancelled work', policy, signal: controller.signal });
        await accepted.promise;
        const id = host.sent[0].target;
        t.after(() => host.setStatus(id, 'idle'));
        controller.abort(new Error('cancel unknown member'));
        assert.equal((await first).ok, false);
        await deleted;
        await nextTurn();
        const next = await runner.dispatch({ parent: host.parent, order: runnerOrder('blocked-' + unknown), prompt: 'must remain blocked', policy });
        assert.equal(next.ok, false); assert.match(next.reason, /隔离/);
        assert.equal(host.sent.length, 1);
        assert.equal(host.specs.length, 1);
        assert.deepEqual(host.idleWaits, [], 'unknown state cannot prove quiescence');
    }
});

test('rc.2 runner rejects self-report when native member quiescence cannot be confirmed', async () => {
    const host = namedHost();
    const runner = createTeamRunner({ ctx: host.ctx, logger: {} });
    const order = runnerOrder('report');
    host.hooks.delivery = ({ target }) => {
        delete host.agents.get(target).status;
        order.reportOutput = 'early summary';
    };
    const result = await runner.dispatch({ parent: host.parent, order, prompt: 'report work', policy });
    assert.equal(result.ok, false); assert.match(result.reason, /尚未确认停止/);
    const next = await runner.dispatch({ parent: host.parent, order: runnerOrder('after-report'), prompt: 'must stay isolated', policy });
    assert.equal(next.ok, false); assert.match(next.reason, /隔离/);
    assert.equal(host.sent.length, 1);
    assert.ok(host.tasks.every(task => task.status === 'deleted'));
});
