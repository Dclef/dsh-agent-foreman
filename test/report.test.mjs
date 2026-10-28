/**
 * 承包商主动上报的回收通道。
 *
 * 子会话的正文宿主不一定读得到，所以 reportOrderOutput 是"结果怎么回来"的
 * 兜底：认工单 id、只收还在干的单、多轮同名时取最新一轮。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ForemanEngine } from '../lib/engine.js';
import { foremanTools } from '../lib/tools.js';

/** 一个不依赖宿主服务的引擎实例。 */
function newEngine() {
    return new ForemanEngine({ ctx: { get: () => undefined }, store: {}, logger: undefined });
}

test('reportOrderOutput 写入进行中的工单', () => {
    const engine = newEngine();
    engine.runs.set('R-1', {
        id: 'R-1',
        createdAt: '2026-01-01',
        orders: [{ id: 'W1', status: 'running' }],
    });
    const result = engine.reportOrderOutput('W1', '干完了');
    const order = engine.runs.get('R-1').orders[0];
    assert.equal(order.reportOutput, '干完了');
    assert.ok(typeof order.reportAt === 'string' && order.reportAt.length > 0);
    assert.equal(result.ok, true);
    assert.equal(result.runId, 'R-1');
    assert.equal(result.orderId, 'W1');
});

test('reportOrderOutput 找不到工单时返回 ok:false', () => {
    const engine = newEngine();
    engine.runs.set('R-1', {
        id: 'R-1',
        createdAt: '2026-01-01',
        orders: [{ id: 'W1', status: 'running' }],
    });
    const result = engine.reportOrderOutput('W9', '干完了');
    assert.equal(result.ok, false);
    assert.ok(String(result.reason).includes('W9'));
});

test('reportOrderOutput 多轮同名时取最新的一轮', () => {
    const engine = newEngine();
    engine.runs.set('R-old', {
        id: 'R-old',
        createdAt: '2026-01-01',
        orders: [{ id: 'W1', status: 'running' }],
    });
    engine.runs.set('R-new', {
        id: 'R-new',
        createdAt: '2026-06-01',
        orders: [{ id: 'W1', status: 'running' }],
    });
    const result = engine.reportOrderOutput('W1', '新轮的活干完了');
    assert.equal(result.ok, true);
    assert.equal(result.runId, 'R-new');
    assert.equal(engine.runs.get('R-new').orders[0].reportOutput, '新轮的活干完了');
    assert.equal(engine.runs.get('R-old').orders[0].reportOutput, undefined);
});

test('reportOrderOutput 空文本不覆盖已有摘要', () => {
    const engine = newEngine();
    engine.runs.set('R-1', {
        id: 'R-1',
        createdAt: '2026-01-01',
        orders: [{ id: 'W1', status: 'running', reportOutput: '第一次', reportAt: '2026-01-01T00:00:00.000Z' }],
    });
    const result = engine.reportOrderOutput('W1', '   ');
    const order = engine.runs.get('R-1').orders[0];
    assert.equal(result.ok, true);
    assert.equal(order.reportOutput, '第一次');
    assert.equal(order.reportAt, '2026-01-01T00:00:00.000Z');
});

test('reportOrderOutput 跳过已结案的工单', () => {
    const engine = newEngine();
    engine.runs.set('R-1', {
        id: 'R-1',
        createdAt: '2026-01-01',
        orders: [{ id: 'W1', status: 'done' }],
    });
    const result = engine.reportOrderOutput('W1', '迟到的摘要');
    assert.equal(result.ok, false);
    assert.ok(String(result.reason).includes('W1'));
});

test('foreman_report 工具已注册且参数齐备', () => {
    const tools = foremanTools({ ctx: { get: () => undefined }, store: {}, engine: newEngine(), logger: undefined });
    const names = tools.map(tool => tool.name);
    assert.equal(names.includes('foreman_report'), true);
    const tool = tools.find(candidate => candidate.name === 'foreman_report');
    assert.deepEqual(tool.parameters.required, ['orderId', 'output']);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(tool.isConcurrencySafe(), true);
});

test('foreman_report 找不到工单时抛错', async () => {
    const engine = newEngine();
    engine.runs.set('R-1', {
        id: 'R-1',
        createdAt: '2026-01-01',
        orders: [{ id: 'W1', status: 'running' }],
    });
    const tools = foremanTools({ ctx: { get: () => undefined }, store: {}, engine, logger: undefined });
    const tool = tools.find(candidate => candidate.name === 'foreman_report');
    await assert.rejects(() => tool.execute({ orderId: 'W2', output: 'x' }), /W2/);
    assert.deepEqual(await tool.execute({ orderId: 'W1', output: 'ok' }), { ok: true, runId: 'R-1', orderId: 'W1' });
});
