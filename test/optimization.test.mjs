/**
 * 本轮优化新增行为的回归测试。
 *
 * 参考 DSH 原生「智能体团队」的 writeScopes 约定、以及文渊阁「做的人不验收」的
 * 独立签收语义：包工头补的是「按模型派单 + 逐单独立验收」，不是再造一支编队。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeWriteScopes, scopesOverlap, findScopeConflicts,
    normalizeOrders, buildPrompt, ForemanEngine,
} from '../lib/engine.js';
import { DEFAULT_POLICY, normalizePolicy } from '../lib/store.js';

test('teamFallback：默认严格，显式开启后才允许普通子会话兜底', () => {
    assert.equal(DEFAULT_POLICY.teamFallback, false);
    assert.equal(normalizePolicy({ teamFallback: true }).teamFallback, true);
    assert.equal(normalizePolicy({ teamFallback: 'yes' }).teamFallback, false);
});

const members = [
    { id: 'a', name: '力工', role: '力工', provider: 'p', model: 'm', maxParallel: 1, enabled: true },
    { id: 'b', name: '小工', role: '小工', provider: '', model: '', maxParallel: 1, enabled: true },
];

test('normalizeWriteScopes：正斜杠、去 ./、拒绝绝对路径/盘符/..、去重', () => {
    assert.deepEqual(normalizeWriteScopes([
        'src\\a.js', './lib/', '/etc/passwd', 'C:/x', '../secret', 'a//b', 'src/a.js', '', 'ok.js',
    ]), ['src/a.js', 'lib', 'ok.js']);
    assert.deepEqual(normalizeWriteScopes(undefined), []);
});

test('scopesOverlap：相等或目录前缀才算重叠', () => {
    assert.equal(scopesOverlap('lib', 'lib/x.js'), true);
    assert.equal(scopesOverlap('lib/a', 'lib/b'), false);
});

test('findScopeConflicts：并行且范围重叠才报，依赖串行不算冲突', () => {
    const orders = normalizeOrders([
        { id: 'W1', task: '甲', writeScopes: ['lib/a'], checklist: ['npm test 通过'] },
        { id: 'W2', task: '乙', writeScopes: ['lib/a/x.js'] },
        { id: 'W3', task: '丙', writeScopes: ['lib/a'], dependsOn: ['W1', 'W2'] },
        { id: 'W4', task: '丁', writeScopes: ['docs'] },
    ], members);
    const conflicts = findScopeConflicts(orders);
    assert.equal(conflicts.length, 1);
    assert.deepEqual(conflicts[0], { a: 'W1', b: 'W2', scope: 'lib/a' });
});

test('normalizeOrders：把 writeScopes 与 checklist 规范化进工单', () => {
    const [order] = normalizeOrders([
        { task: '干活', writeScopes: ['./src/'], checklist: [' 通过 ', ''] },
    ], members);
    assert.deepEqual(order.writeScopes, ['src']);
    assert.deepEqual(order.checklist, ['通过']);
});

test('buildPrompt：注入写入范围与验收清单，并声明做的人不自己签收', () => {
    const prompt = buildPrompt({
        goal: '修首页',
        order: { id: 'W1', title: '改取整', task: '改', accept: 'npm test 通过',
            writeScopes: ['src/quota.js'], checklist: ['npm test 通过', '没动后端'] },
    });
    assert.ok(prompt.includes('【写入范围（仅提示，不是文件锁）】src/quota.js'));
    assert.ok(prompt.includes('【验收清单（父智能体逐项核对，做的人不自己签收）】'));
    assert.ok(prompt.includes('npm test 通过'));
    assert.ok(prompt.includes('没动后端'));
});

test('renderBoard：把验收清单与重叠警告摆给父智能体', () => {
    const engine = new ForemanEngine({ ctx: { get: () => undefined }, store: {}, logger: {} });
    const run = {
        id: 'R-1', goal: '', status: 'waiting-review', orders: [
            { id: 'W1', title: '甲', contractorName: '力工', route: 'p/m', status: 'done',
                dependsOn: [], writeScopes: ['lib'], checklist: ['检查 A'] },
            { id: 'W2', title: '乙', contractorName: '小工', route: 'inherit', status: 'done',
                dependsOn: [], writeScopes: ['lib/x.js'], checklist: [] },
        ],
    };
    const board = engine.renderBoard(run);
    assert.ok(board.includes('验收清单（做的人不自己签收'));
    assert.ok(board.includes('W1：检查 A'));
    assert.ok(board.includes('写入范围重叠（仅提示'));
    assert.ok(board.includes('W1 ↔ W2：lib'));
});

test('review：fail 必须给 feedback，pass/fail 都记 reviewedBy=foreman', async () => {
    const engine = new ForemanEngine({ ctx: { get: () => undefined }, store: {
        saveRunSnapshot: () => true, recordRun: () => true,
    }, logger: {} });
    const run = {
        id: 'R-2', status: 'waiting-review', policy: { maxRework: 0 }, updatedAt: '',
        orders: [{ id: 'W1', title: '甲', status: 'done', dependsOn: [], attempts: 1 }],
    };
    await assert.rejects(
        () => engine.review({ run, verdicts: [{ order: 'W1', verdict: 'fail' }], rework: false }),
        /打回时必须写清 feedback/,
    );
    const updated = await engine.review({ run, verdicts: [{ order: 'W1', verdict: 'pass' }], rework: false });
    assert.equal(updated.orders[0].reviewedBy, 'foreman', '签收方必须是父智能体，不是干活的承包商');
    assert.equal(updated.orders[0].verdict, 'pass');
});
