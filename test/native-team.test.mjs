import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnNativeTeammate } from '../lib/native-team.js';
import { observeTeamSession, routeFromSession } from '../lib/team-session.js';

function host() {
    const calls = [];
    const subagents = { async startActivation(spec) {
        await Promise.resolve();
        calls.push(spec);
        return { childId: spec.childId };
    } };
    const roster = { ctx: { subagents },
        async spawn(parent, request) { return this.spawnAdmitted(parent, request); },
        async spawnAdmitted(parent, request) {
            await Promise.resolve();
            const created = await this.ctx.subagents.startActivation({
                childId: request.name, delivery: 'parent', provider: request.provider,
                request: { parent, prompt: request.prompt }, signal: request.signal,
            });
            return { member: { id: created.childId, name: request.name } };
        },
    };
    const teams = { roster, async spawnTeammate(parent, request) { return this.roster.spawn(parent, request); } };
    return { teams, subagents, calls };
}

test('scoped native calls isolate two simultaneous model routes and unrelated activation', async () => {
    const { teams, subagents, calls } = host();
    const parent = { id: 'lead' };
    const originalStart = subagents.startActivation;
    const originalContext = teams.roster.ctx;
    await Promise.all(['alpha', 'beta'].map(name => spawnNativeTeammate({
        teams, parent,
        request: { name, prompt: [{ type: 'text', text: name }], provider: 'spawn' },
        agentOptions: { provider: 'provider-' + name, model: 'model-' + name, reasoningEffort: 'high' },
        maxDepth: 1,
    })));
    await subagents.startActivation({ childId: 'unrelated', request: { parent, prompt: [] } });
    assert.equal(calls.length, 3);
    for (const name of ['alpha', 'beta']) {
        const spec = calls.find(x => x.childId === name);
        assert.equal(spec.request.agentOptions.model, 'model-' + name);
        assert.equal(spec.request.agentOptions.provider, 'provider-' + name);
        assert.equal(spec.delivery, 'parent');
        assert.strictEqual(spec.request.parent, parent);
    }
    assert.equal(calls.find(x => x.childId === 'unrelated').request.agentOptions, undefined);
    assert.strictEqual(subagents.startActivation, originalStart);
    assert.strictEqual(teams.roster.ctx, originalContext);
});

test('unsupported host and partial routes fail before native creation', async () => {
    let calls = 0;
    const teams = { async spawnTeammate() { calls++; } };
    for (const agentOptions of [{ provider: 'p', model: 'm' }, { provider: '', model: 'm' }]) {
        await assert.rejects(spawnNativeTeammate({ teams, parent: { id: 'lead' }, request: {}, agentOptions }), /模型|路由/);
    }
    assert.equal(calls, 0);
});

test('native adapter preserves original method after activation rejection', async () => {
    const { teams, subagents } = host();
    subagents.startActivation = async () => { throw new Error('route denied'); };
    const original = subagents.startActivation;
    await assert.rejects(spawnNativeTeammate({ teams, parent: { id: 'lead' },
        request: { name: 'x', prompt: [], provider: 'spawn' }, agentOptions: { provider: 'p', model: 'm' },
    }), /route denied/);
    assert.strictEqual(subagents.startActivation, original);
});

test('actual request/header overrides misleading creation or roster model labels', () => {
    const session = { header: { provider: 'wrong', model: 'wrong' },
        snapshotEvents: () => [{ type: 'request/header', data: { header: { config: { provider: 'actual', model: 'm', reasoningEffort: 'high' } } } }],
    };
    assert.deepEqual(routeFromSession(session), { provider: 'actual', model: 'm', reasoningEffort: 'high' });
});

test('cold native child observation opens read-only and always closes its handle', async () => {
    const calls = [];
    const ctx = { get(name) { return name === 'sessionPersistence' ? { async open(id, mode) {
        calls.push([id, mode]);
        return { header: { id }, async read() { return { events: [{ type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } }] }; }, async close() { calls.push('close'); } };
    } } : undefined; } };
    const session = await observeTeamSession(ctx, 'cold-child');
    assert.deepEqual(routeFromSession(session), { provider: 'p', model: 'm', reasoningEffort: '' });
    assert.deepEqual(calls, [['cold-child', 'read'], 'close']);
});
