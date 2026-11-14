/**
 * 逐项验收 / 提示级预算 / 用量快照的回归测试。
 *
 * 三组能力都是「薄层可吸收」的增强：逐项验收借文渊阁的 qaChecklist + 硬门禁，
 * 预算借内阁模式的提示级工具调用上限（明确不是运行时计数器），用量快照借成员
 * usage 投影（缺值显示 dash，不编造）。全部向后兼容：不写新字段时行为与 0.5.0
 * 完全一致。测试只依赖 lib/engine.js 与本文件，不启动宿主、不联网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeOrders, normalizeBudget, normalizeChecks, readUsage,
    buildPrompt, ForemanEngine,
} from '../lib/engine.js';
import { DEFAULT_POLICY } from '../lib/store.js';

const members = [
    { id: 'a', name: '力工', role: '力工', provider: 'p', model: 'm', maxParallel: 1, enabled: true },
];

/** 只带验收所需的假 store：真宿主的东西一概不碰。 */
function engineOf() {
    return new ForemanEngine({
        ctx: { get: () => undefined },
        store: { saveRunSnapshot: () => true, recordRun: () => true },
        logger: {},
    });
}

/** 造一轮只有一张单的看板。 */
function runOf(order) {
    return {
        id: 'R-1',
        status: 'waiting-review',
        updatedAt: '',
        policy: { ...DEFAULT_POLICY, maxRework: 0 },
        // 与 normalizeOrders 给出的稳定默认值对齐：没验收过的单是空数组 / null。
        orders: [{
            title: '甲', status: 'done', dependsOn: [], attempts: 1,
            qaRequired: false, budget: null, checkResults: [], usage: null, ...order,
        }],
    };
}

/** 取一次调用的错误码（不抛就返回空串）。 */
function codeOf(fn) {
    try {
        fn();
        return '';
    }
    catch (error) {
        return error?.code ?? '';
    }
}

// ── 一、结构化逐项验收 ─────────────────────────────────────────────────────

test('normalizeOrders：qaRequired / budget / checkResults / usage 都有稳定默认值', () => {
    const [plain] = normalizeOrders([{ id: 'W1', task: '干活' }], members);
    assert.equal(Object.hasOwn(plain, 'qaRequired'), true, '字段必须存在，不能是 undefined');
    assert.equal(plain.qaRequired, false);
    assert.equal(plain.budget, null);
    assert.deepEqual(plain.checkResults, []);
    assert.equal(plain.usage, null);
    const [opened] = normalizeOrders([{ id: 'W2', task: '干活', qaRequired: true }], members);
    assert.equal(opened.qaRequired, true);
    const [noisy] = normalizeOrders([{ id: 'W3', task: '干活', qaRequired: 'yes' }], members);
    assert.equal(noisy.qaRequired, false, '只有严格 true 才算开启');
});

test('review：qaRequired 的单 pass 不给 checks 被 QA_CHECKS_REQUIRED 拒绝', async () => {
    const engine = engineOf();
    const run = runOf({ id: 'W1', qaRequired: true, checklist: ['npm test 通过', '没动后端'] });
    await assert.rejects(
        () => engine.review({ run, verdicts: [{ order: 'W1', verdict: 'pass' }], rework: false }),
        (error) => {
            assert.equal(error.code, 'QA_CHECKS_REQUIRED');
            assert.ok(error.message.includes('npm test 通过'), '错误里要列出缺哪几项');
            assert.ok(error.message.includes('没动后端'));
            return true;
        },
    );
    assert.equal(run.orders[0].verdict, undefined, '被拒时不能把工单改到一半');
});

test('review：部分覆盖时只报缺的那几项', async () => {
    const engine = engineOf();
    const run = runOf({ id: 'W1', qaRequired: true, checklist: ['npm test 通过', '没动后端'] });
    await assert.rejects(
        () => engine.review({
            run,
            verdicts: [{ order: 'W1', verdict: 'pass', checks: [{ item: 'npm test 通过', passed: true }] }],
            rework: false,
        }),
        (error) => {
            assert.equal(error.code, 'QA_CHECKS_REQUIRED');
            assert.ok(error.message.includes('没动后端'));
            assert.equal(error.message.includes('「npm test 通过」'), false, '已核对的项不该被报成缺项');
            return true;
        },
    );
});

test('review：完整覆盖能通过，并写入 checkResults 与 reviewedBy=foreman', async () => {
    const engine = engineOf();
    const run = runOf({ id: 'W1', qaRequired: true, checklist: ['npm test 通过', '没动后端'] });
    const updated = await engine.review({
        run,
        verdicts: [{
            order: 'W1',
            verdict: 'pass',
            checks: [
                { item: ' npm test 通过 ', passed: true, note: '  已跑通  ' },
                { item: '没动后端', passed: true },
            ],
        }],
        rework: false,
    });
    const order = updated.orders[0];
    assert.equal(order.verdict, 'pass');
    assert.equal(order.reviewedBy, 'foreman', '签收方必须是父智能体');
    assert.deepEqual(order.checkResults, [
        { item: 'npm test 通过', passed: true, note: '已跑通' },
        { item: '没动后端', passed: true, note: '' },
    ]);
    assert.equal(updated.status, 'accepted');
});

test('review：qaRequired=false 时旧式单条 pass 照旧通过', async () => {
    const engine = engineOf();
    const run = runOf({ id: 'W1', checklist: ['npm test 通过'] });
    const updated = await engine.review({ run, verdicts: [{ order: 'W1', verdict: 'pass' }], rework: false });
    assert.equal(updated.orders[0].verdict, 'pass');
    assert.deepEqual(updated.orders[0].checkResults, [], '没给 checks 时记空数组，不是 undefined');
});

test('review：fail 不给 feedback 仍按 FEEDBACK_REQUIRED 拒绝', async () => {
    const engine = engineOf();
    const run = runOf({ id: 'W1', qaRequired: true, checklist: ['npm test 通过'] });
    await assert.rejects(
        () => engine.review({ run, verdicts: [{ order: 'W1', verdict: 'fail' }], rework: false }),
        (error) => error.code === 'FEEDBACK_REQUIRED',
    );
});

test('normalizeChecks：passed 非布尔 / item 空 / 非数组都被 INVALID_CHECKS 拒绝', () => {
    assert.equal(codeOf(() => normalizeChecks([{ item: 'a', passed: 'yes' }], 'W1')), 'INVALID_CHECKS');
    assert.equal(codeOf(() => normalizeChecks([{ item: '   ', passed: true }], 'W1')), 'INVALID_CHECKS');
    assert.equal(codeOf(() => normalizeChecks([null], 'W1')), 'INVALID_CHECKS');
    assert.equal(codeOf(() => normalizeChecks({ item: 'a', passed: true }, 'W1')), 'INVALID_CHECKS');
    assert.deepEqual(normalizeChecks(undefined, 'W1'), []);
    assert.deepEqual(normalizeChecks([{ item: 'a', passed: false, note: 3 }], 'W1'), [{ item: 'a', passed: false, note: '3' }]);
    assert.equal(normalizeChecks([{ item: 'a', passed: true, note: 'x'.repeat(900) }], 'W1')[0].note.length, 500);
});

test('review：非法 checks 不落在工单上（先校验再落库）', async () => {
    const engine = engineOf();
    const run = runOf({ id: 'W1' });
    await assert.rejects(
        () => engine.review({
            run,
            verdicts: [{ order: 'W1', verdict: 'pass', checks: [{ item: 'a', passed: 'nope' }] }],
            rework: false,
        }),
        (error) => error.code === 'INVALID_CHECKS',
    );
    assert.deepEqual(run.orders[0].checkResults, []);
});

// ── 二、提示级预算 ────────────────────────────────────────────────────────

test('normalizeBudget：越界钳制、非数字丢弃、全空记 null', () => {
    assert.deepEqual(normalizeBudget({ maxToolCalls: 9999, maxRetries: 99 }),
        { maxToolCalls: 500, maxRetries: 10, stopCondition: '' });
    assert.deepEqual(normalizeBudget({ maxToolCalls: 0, maxRetries: -3 }),
        { maxToolCalls: 1, maxRetries: 0, stopCondition: '' });
    assert.equal(normalizeBudget({ maxToolCalls: 12.7 }).maxToolCalls, 12);
    assert.equal(normalizeBudget({ maxToolCalls: 'abc' }), null);
    assert.equal(normalizeBudget({ maxRetries: 'x' }), null);
    assert.equal(normalizeBudget(null), null);
    assert.equal(normalizeBudget('x'), null);
    assert.equal(normalizeBudget([]), null);
    assert.equal(normalizeBudget({ maxToolCalls: 8, stopCondition: '  够了就停  ' }).stopCondition, '够了就停');
    assert.equal(normalizeBudget({ stopCondition: 'x'.repeat(900) }).stopCondition.length, 500);
});

test('normalizeOrders：budget 走规范化并进入工单', () => {
    const [order] = normalizeOrders([{ id: 'W1', task: '干活', budget: { maxToolCalls: 999, maxRetries: 99 } }], members);
    assert.deepEqual(order.budget, { maxToolCalls: 500, maxRetries: 10, stopCondition: '' });
    const [none] = normalizeOrders([{ id: 'W2', task: '干活', budget: { maxToolCalls: 'x' } }], members);
    assert.equal(none.budget, null);
});

test('buildPrompt：注入明确标注提示级的预算块', () => {
    const prompt = buildPrompt({
        goal: '',
        order: {
            id: 'W1', title: '甲', task: '改', accept: '', checklist: ['x'],
            budget: { maxToolCalls: 12, maxRetries: 2, stopCondition: '单测通过就收尾' },
        },
    });
    assert.ok(prompt.includes('【预算与停止条件（提示级，非运行时强制）】'));
    assert.ok(prompt.includes('最多 12 次工具调用'));
    assert.ok(prompt.includes('同一个失败最多重试 2 次'));
    assert.ok(prompt.includes('单测通过就收尾'));
    assert.ok(prompt.includes('提示级'));
    assert.ok(prompt.includes('不是运行时强制计数器'), '必须显式声明没有强制能力');
    assert.ok(prompt.indexOf('【验收清单') < prompt.indexOf('【预算与停止条件'));
    assert.ok(prompt.indexOf('【预算与停止条件') < prompt.indexOf('【交付要求】'));
});

test('buildPrompt：没有 budget 时整块消失（向后兼容）', () => {
    const plain = buildPrompt({ goal: '', order: { id: 'W2', title: '乙', task: '改', budget: null } });
    assert.equal(plain.includes('【预算与停止条件'), false);
});

// ── 三、用量快照 ──────────────────────────────────────────────────────────

test('readUsage：缺值留 null，total 缺失时由 input+output 相加', () => {
    assert.equal(readUsage(undefined), null);
    assert.equal(readUsage({}), null);
    assert.equal(readUsage({ usage: { inputTokens: 'n/a' } }), null);
    assert.deepEqual(readUsage({ usage: { inputTokens: 1200, outputTokens: 300 } }),
        { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 });
    assert.deepEqual(readUsage({ output: { usage: { totalTokens: 42 } } }),
        { inputTokens: null, outputTokens: null, totalTokens: 42 });
    assert.deepEqual(readUsage({ usage: { totalTokens: 7 }, output: { usage: { totalTokens: 9 } } }),
        { inputTokens: null, outputTokens: null, totalTokens: 7 }, '先读到的来源优先');
});

/** 只够跑一张单的假宿主：子智能体立即落定，回包由调用方给。 */
function hostOf(result) {
    const subagents = {
        providers: new Map([['backend', { name: 'backend', capabilities: { agentOptions: true } }]]),
        startActivation() {
            return { childId: 'child', result: Promise.resolve(result), dispose() {} };
        },
    };
    const member = { id: 'a', name: '力工', role: '力工', provider: 'p', model: 'm', maxParallel: 1, enabled: true };
    // 团队模式默认开着，但这里的假宿主没有团队服务：显式关掉，走普通激活路径。
    const policy = { ...DEFAULT_POLICY, teamMode: false, provider: 'backend', maxRework: 0 };
    const store = {
        members: () => [member],
        policy: () => policy,
        writeArtifact: () => '',
        recordRun: () => true,
        saveRunSnapshot: () => true,
    };
    const engine = new ForemanEngine({
        ctx: { get: name => (name === 'subagents' ? subagents : undefined) },
        store,
        logger: { info() {}, warn() {}, error() {} },
    });
    const parent = { id: 'parent', session: { id: 'sess-1' }, options: {} };
    const orders = [{ id: 'W1', title: '干活', task: '做完它', contractor: '', dependsOn: [] }];
    return { engine, policy, parent, orders };
}

test('dispatch：宿主给了 usage 就采集进 order.usage，看板显示 token', async () => {
    const host = hostOf({
        output: [{ type: 'text', text: '做完了' }],
        stopReason: 'completed',
        usage: { inputTokens: 1200, outputTokens: 300 },
    });
    const run = await host.engine.dispatch({
        parent: host.parent, sessionId: 'sess-1', goal: 'g', policy: host.policy, orders: host.orders,
    });
    assert.deepEqual(run.orders[0].usage, { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 });
    const board = host.engine.renderBoard(run);
    assert.ok(board.includes(' · token 1.5k'));
    assert.ok(board.includes('用量为宿主投影读数，非计费总量；缺失显示 —'));
});

test('dispatch：宿主不给 usage 时保持 null，看板诚实显示 —', async () => {
    const host = hostOf({ output: [{ type: 'text', text: '做完了' }], stopReason: 'completed' });
    const run = await host.engine.dispatch({
        parent: host.parent, sessionId: 'sess-1', goal: 'g', policy: host.policy, orders: host.orders,
    });
    assert.equal(run.orders[0].status, 'done', run.orders[0].error);
    assert.equal(run.orders[0].usage, null);
    const board = host.engine.renderBoard(run);
    assert.ok(board.includes(' · token —'), '缺失必须显示 —，不能编造');
});

// ── 看板渲染 ──────────────────────────────────────────────────────────────

test('renderBoard：逐项验收块、备注、预算与用量说明都在看板上', () => {
    const engine = engineOf();
    const run = {
        id: 'R-1',
        goal: '',
        status: 'waiting-review',
        orders: [{
            id: 'W1', title: '甲', contractorName: '力工', route: 'p/m', status: 'done',
            dependsOn: [], writeScopes: [], checklist: ['npm test 通过', '没动后端'],
            qaRequired: true,
            budget: { maxToolCalls: 12, maxRetries: 2, stopCondition: '' },
            checkResults: [
                { item: 'npm test 通过', passed: true, note: '已跑通' },
                { item: '没动后端', passed: false, note: '改了 server/' },
                { item: '未跑集成', passed: true, note: '' },
            ],
            usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
            verdict: 'pass',
        }],
    };
    const board = engine.renderBoard(run);
    const lines = board.split('\n');
    assert.ok(board.includes('逐项验收（父智能体签收）'));
    assert.ok(lines.includes('   · W1 ✔ npm test 通过 — 已跑通'));
    assert.ok(lines.includes('   · W1 ✖ 没动后端 — 改了 server/'));
    assert.ok(lines.includes('   · W1 ✔ 未跑集成'), 'note 为空时只输出结论');
    assert.ok(board.includes(' · 预算 12 次调用/重试≤2'));
    assert.ok(board.includes(' · token 1.5k'));
    assert.ok(board.includes('用量为宿主投影读数，非计费总量；缺失显示 —'));
    assert.ok(board.indexOf('验收清单（做的人不自己签收') < board.indexOf('逐项验收（父智能体签收）'));
});
