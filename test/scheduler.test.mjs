/**
 * 就绪调度测试：按依赖完成增量放行，而不是整层 barrier。
 *
 * 全部用最小假宿主：`ctx.get('subagents')` 给一个可控的 `startActivation`，
 * `ctx.get('agentTeams')` 返 undefined（团队模式关掉），store 只有
 * members/policy/writeArtifact/recordRun（可选 saveRunSnapshot）。
 * 不引 node_modules，只依赖 node 内建与 `lib/`。
 *
 * 这里测的是"什么时候放下一张单"，以及"一张单没成之后，谁被挡住、原因怎么写"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ForemanEngine } from '../lib/engine.js';
import { ForemanError } from '../lib/store.js';

/** 默认策略：足够大的超时，免得用例被真计时器影响。 */
const POLICY = Object.freeze({
    concurrency: 2,
    timeoutSeconds: 30,
    maxRework: 1,
    maxDepth: 1,
    provider: 'spawn',
    teamMode: false,
});

/** 造一个承包商（字段与 store 规范化后的形状一致）。 */
function member(id, extra = {}) {
    return {
        id,
        name: id,
        role: id,
        prompt: '',
        enabled: true,
        provider: '',
        model: '',
        reasoningEffort: '',
        maxParallel: 1,
        ...extra,
    };
}

/** 造一张工单（`contractor` 留空表示全名册轮转）。 */
function order(id, extra = {}) {
    return {
        id,
        title: `${id} 的活`,
        task: `做 ${id}`,
        accept: '做完',
        contractor: '',
        dependsOn: [],
        ...extra,
    };
}

/**
 * 造一个最小派单宿主：每张单的落定时机由用例显式控制。
 * @param args.members - 名册。
 * @param args.policy - 策略（会原样交给 dispatch）。
 * @param args.snapshot - store 是否提供 `saveRunSnapshot`。
 */
function createHost({ members, policy = POLICY, snapshot = false } = {}) {
    const activations = [];
    const snapshotCalls = [];
    const ledger = [];
    let running = 0;
    let peak = 0;

    const subagents = {
        providers: new Map([['spawn', { name: 'spawn', capabilities: { agentOptions: true } }]]),
        async startActivation(spec) {
            const label = String(spec.label ?? '');
            const id = label.split(' ')[0];
            running += 1;
            peak = Math.max(peak, running);
            const record = { id, label, spec, settled: false, released: false };
            record.result = new Promise((resolve) => {
                record.finish = (value) => {
                    if (record.released)
                        return;
                    record.released = true;
                    record.settled = true;
                    running -= 1;
                    resolve(value);
                };
            });
            activations.push(record);
            return {
                childId: `child-${activations.length}`,
                result: record.result,
                // 超时/取消时引擎会 dispose 一个尚未落定的激活：也算它离场。
                dispose: async () => {
                    if (record.released)
                        return;
                    record.released = true;
                    running -= 1;
                },
            };
        },
    };

    const ctx = {
        get(service) {
            if (service === 'subagents')
                return subagents;
            // 团队模式必须走普通激活路径，这样用例只观察一条执行线路。
            if (service === 'agentTeams')
                return undefined;
            return undefined;
        },
    };

    const store = {
        members: () => members,
        policy: () => policy,
        writeArtifact: (runId, orderId) => `/tmp/${runId}-${orderId}.md`,
        recordRun: (record) => {
            ledger.push(record);
            return true;
        },
    };
    if (snapshot) {
        store.saveRunSnapshot = (run) => {
            snapshotCalls.push(run.id);
            return true;
        };
    }

    const engine = new ForemanEngine({
        ctx,
        store,
        logger: { info() {}, warn() {}, error() {} },
    });

    const find = id => [...activations].reverse().find(record => record.id === id);
    /** 同一张单可能被派多次（返工），取最近一次尚未落定/释放的激活。 */
    const open = (id) => {
        for (let index = activations.length - 1; index >= 0; index -= 1) {
            if (activations[index].id === id && !activations[index].released)
                return activations[index];
        }
        return undefined;
    };

    return {
        engine,
        store,
        activations,
        snapshotCalls,
        ledger,
        find,
        peak: () => peak,
        /** 等某张单被真正派出去（父调用方的 signal 生效前）。 */
        async waitFor(id, tries = 200) {
            for (let attempt = 0; attempt < tries; attempt += 1) {
                const record = open(id);
                if (record !== undefined)
                    return record;
                await new Promise(resolve => setTimeout(resolve, 2));
            }
            throw new Error(`等不到「${id}」的激活；已发出的：${activations.map(record => record.id).join('、')}`);
        },
        /** 让某张单落定：默认正常交付，可指定 stopReason 模拟失败。 */
        settle(id, { stopReason = 'completed', text = `${id} 做完了` } = {}) {
            const record = open(id);
            assert.ok(record !== undefined, `「${id}」还没有被派出，无法落定`);
            record.finish({ output: [{ type: 'text', text }], stopReason });
        },
        /** 发一轮派单，返回 run。 */
        dispatch(orders, { signal, sessionId = 'session-1', goal = '把活干完' } = {}) {
            return engine.dispatch({
                parent: { id: 'parent-1' },
                sessionId,
                goal,
                orders,
                policy,
                signal,
            });
        },
    };
}

/** 按 id 取 run 里的工单，便于断言。 */
function byId(run) {
    return new Map(run.orders.map(entry => [entry.id, entry]));
}

test('无依赖：两张单同时在场，各自落定', async () => {
    const host = createHost({
        members: [member('a'), member('b')],
        policy: { ...POLICY, concurrency: 2 },
    });
    const pending = host.dispatch([order('W1'), order('W2')]);
    await host.waitFor('W1');
    await host.waitFor('W2');
    // 两张单都还没交活，说明没有互相等
    assert.equal(host.find('W1').settled, false);
    assert.equal(host.find('W2').settled, false);
    assert.equal(host.peak(), 2, '并发上限 2 时两张单应同时在跑');

    host.settle('W1');
    host.settle('W2');
    const run = await pending;
    assert.deepEqual(run.orders.map(entry => entry.status), ['done', 'done']);
    assert.equal(run.status, 'waiting-review');
});

test('A 完成就启动依赖 A 的 C，不等同批的 B', async () => {
    const host = createHost({
        members: [member('a'), member('b'), member('c')],
        policy: { ...POLICY, concurrency: 3 },
    });
    const pending = host.dispatch([
        order('A'),
        order('B'),
        order('C', { dependsOn: ['A'] }),
    ]);
    await host.waitFor('A');
    await host.waitFor('B');
    assert.equal(host.find('C'), undefined, 'A 还没完成，C 不能起跑');

    host.settle('A');
    await host.waitFor('C');
    // 关键点：B 还挂在那里，C 已经开跑——按依赖就绪，不是等整层
    assert.equal(host.find('B').settled, false, 'B 仍在跑');
    assert.equal(host.find('A').settled, true);

    host.settle('B');
    host.settle('C');
    const run = await pending;
    assert.deepEqual(host.activations.map(record => record.id), ['A', 'B', 'C']);
    assert.deepEqual(run.orders.map(entry => entry.status), ['done', 'done', 'done']);
});

test('B 失败：直接下游 skipped 并写原因，再往下递归阻断', async () => {
    const host = createHost({
        members: [member('m', { maxParallel: 2 })],
        policy: { ...POLICY, concurrency: 2 },
    });
    const pending = host.dispatch([
        order('W1'),
        order('W2'),
        order('W3', { dependsOn: ['W2'] }),
        order('W4', { dependsOn: ['W3'] }),
    ]);
    await host.waitFor('W1');
    await host.waitFor('W2');

    host.settle('W2', { stopReason: 'error' });
    host.settle('W1');
    const run = await pending;
    const orders = byId(run);

    assert.equal(orders.get('W1').status, 'done');
    assert.equal(orders.get('W2').status, 'failed');
    assert.equal(orders.get('W3').status, 'skipped');
    assert.equal(orders.get('W3').error, '依赖 W2 未完成');
    assert.equal(orders.get('W4').status, 'skipped');
    assert.equal(orders.get('W4').error, '依赖 W3 未完成', '下游的下游按它自己的直接依赖写原因');
    assert.equal(orders.get('W4').stopReason, 'skipped');
    // 被阻断的单不该被派出去
    assert.ok(!host.activations.some(record => record.id === 'W3' || record.id === 'W4'));
});

test('超时：直接下游照样被跳过', async () => {
    const host = createHost({
        members: [member('m', { maxParallel: 2 })],
        // 直接传策略对象，50ms 即超时，不必等默认的十几秒
        policy: { ...POLICY, concurrency: 2, timeoutSeconds: 0.05 },
    });
    const pending = host.dispatch([
        order('W1'),
        order('W2', { dependsOn: ['W1'] }),
    ]);
    await host.waitFor('W1');
    // 故意不落定 W1，让超时分支触发
    const run = await pending;
    const orders = byId(run);
    assert.equal(orders.get('W1').status, 'timeout');
    assert.equal(orders.get('W2').status, 'skipped');
    assert.equal(orders.get('W2').error, '依赖 W1 未完成');
});

test('取消：还没起跑的单标 skipped / 派单已取消', async () => {
    const controller = new AbortController();
    const host = createHost({
        members: [member('a')],
        policy: { ...POLICY, concurrency: 1 },
    });
    const pending = host.dispatch([order('W1'), order('W2')], { signal: controller.signal });
    await host.waitFor('W1');
    assert.equal(host.find('W2'), undefined, '并发上限 1，W2 还在排队');

    controller.abort(new Error('父会话取消'));
    const run = await pending;
    const orders = byId(run);
    assert.equal(orders.get('W1').status, 'failed', '已起跑的单要收尾');
    assert.equal(orders.get('W2').status, 'skipped');
    assert.equal(orders.get('W2').error, '派单已取消');
});

test('每张单落定后回调 store.saveRunSnapshot；store 没有这个钩子也能跑完', async () => {
    const host = createHost({
        members: [member('m')],
        policy: { ...POLICY, concurrency: 1 },
        snapshot: true,
    });
    const pending = host.dispatch([order('W1'), order('W2', { dependsOn: ['W1'] })]);
    await host.waitFor('W1');
    host.settle('W1');
    await host.waitFor('W2');
    host.settle('W2');
    const run = await pending;
    assert.ok(host.snapshotCalls.length >= 2, '两张单落定各存一次');
    assert.ok(host.snapshotCalls.every(id => id === run.id), '存的是本轮的 run');

    const bare = createHost({ members: [member('m')], policy: { ...POLICY, concurrency: 1 } });
    const barePending = bare.dispatch([order('W1')]);
    await bare.waitFor('W1');
    bare.settle('W1');
    const bareRun = await barePending;
    assert.equal(bareRun.orders[0].status, 'done', '没有 saveRunSnapshot 时安静跳过');
});

test('review：返工单的上游不在 done 集合时拒绝，不绕过依赖', async () => {
    const host = createHost({
        members: [member('m')],
        policy: { ...POLICY, concurrency: 1, maxRework: 1 },
    });
    const pending = host.dispatch([order('W1'), order('W2', { dependsOn: ['W1'] })]);
    await host.waitFor('W1');
    host.settle('W1', { stopReason: 'error' });
    const run = await pending;
    assert.equal(byId(run).get('W2').status, 'skipped');

    let error;
    try {
        await host.engine.review({ run, verdicts: [{ order: 'W2', verdict: 'fail', feedback: '重做' }] });
    }
    catch (caught) {
        error = caught;
    }
    assert.ok(error instanceof ForemanError);
    assert.equal(error.code, 'DEPENDENCY_NOT_DONE');
    assert.match(error.message, /W1/);
    assert.match(error.message, /没有完成/);
    // 拒绝发生在重派之前：不该多出一次激活
    assert.equal(host.activations.length, 1);

    // 上游 done 之后，同一个打回结论可以正常返工
    const host2 = createHost({ members: [member('m')], policy: { ...POLICY, concurrency: 1, maxRework: 1 } });
    const pending2 = host2.dispatch([order('W1'), order('W2', { dependsOn: ['W1'] })]);
    await host2.waitFor('W1');
    host2.settle('W1');
    await host2.waitFor('W2');
    host2.settle('W2');
    const run2 = await pending2;
    const reviewed = host2.engine.review({ run: run2, verdicts: [{ order: 'W2', verdict: 'fail', feedback: '再改' }] });
    await host2.waitFor('W2');
    host2.settle('W2');
    const after = await reviewed;
    assert.equal(byId(after).get('W2').attempts, 2, '依赖满足时返工照常发生');
    assert.equal(after.orders.filter(entry => entry.id === 'W2').length, 1, '只有明确 fail 的那张被重跑');
    assert.equal(byId(after).get('W1').attempts, 1);
});

test('成环仍然由 layerOrders 拒绝', async () => {
    const host = createHost({ members: [member('m')] });
    let error;
    try {
        await host.dispatch([
            order('A', { dependsOn: ['B'] }),
            order('B', { dependsOn: ['A'] }),
        ]);
    }
    catch (caught) {
        error = caught;
    }
    assert.ok(error instanceof ForemanError);
    assert.equal(error.code, 'CYCLIC_DEPENDENCY');
    assert.equal(host.activations.length, 0, '成环不该派出任何单');
});
