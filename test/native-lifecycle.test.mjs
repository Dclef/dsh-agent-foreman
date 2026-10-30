import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamRunner } from '../lib/team.js';
import { ForemanEngine } from '../lib/engine.js';

const worker = { id: 'one', name: 'one', provider: '', model: '', reasoningEffort: '' };

test('native spawn that ignores cancellation still returns promptly and quarantines its lane', async () => {
    let created = 0;
    const teams = { listMembers: () => [], spawnTeammate() { created++; return new Promise(() => {}); } };
    const runner = createTeamRunner({ ctx: { get: name => name === 'agentTeams' ? teams : undefined } });
    const parent = { id: 'lead' };
    const begin = Date.now();
    const first = await runner.dispatch({ order: { id: 'a', member: worker }, parent, prompt: 'work', policy: { timeoutSeconds: 0.02 } });
    assert.equal(first.ok, false);
    assert.match(first.reason, /超时/);
    assert.ok(Date.now() - begin < 1000);
    const second = await runner.dispatch({ order: { id: 'b', member: worker }, parent, prompt: 'next', policy: { timeoutSeconds: 0.02 } });
    assert.match(second.reason, /隔离/);
    assert.equal(created, 1, 'never start a replacement while the first writer is unconfirmed');
});

test('native report delivery rejects wrong session and stale attempt tokens', () => {
    const engine = new ForemanEngine({ ctx: { get: () => undefined }, store: {} });
    const order = { id: 'W1', status: 'running', childId: 'child-a', attempts: 2, reportToken: 'current-token' };
    engine.runs.set('run-a', { id: 'run-a', createdAt: '2026-10-30', orders: [order] });
    for (const source of [
        { runId: 'run-a', sessionId: 'child-b', attempt: 2, token: 'current-token' },
        { runId: 'run-a', sessionId: 'child-a', attempt: 1, token: 'old-token' },
        { runId: 'run-b', sessionId: 'child-a', attempt: 2, token: 'current-token' },
    ]) assert.equal(engine.reportOrderOutput('W1', 'stale', source).ok, false);
    assert.equal(order.reportOutput, undefined);
    assert.equal(engine.reportOrderOutput('W1', 'fresh', { runId: 'run-a', sessionId: 'child-a', attempt: 2, token: 'current-token' }).ok, true);
    assert.equal(order.reportOutput, 'fresh');
});
