/**
 * 真实路由回显测试。
 *
 * 看板上的 `route` 是名册声明（"我让它用哪个模型"），`actualRoute` 才是从子会话
 * 头里读回来的事实（"它到底用了哪个"）。这里证明三件事：
 *
 * 1. `readChildRoute` 的两条来源都能读到，读不到时返回 undefined；
 * 2. 派单后工单上真的带上了真实路由，并能和名册声明比出不一致；
 * 3. 读路由这条诊断链路整个坏掉（`ctx.get('sessions')` 抛错）时，派单照常跑完。
 *
 * 全部用最小假宿主，不引 node_modules，只依赖 node 内建与 `lib/`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ForemanEngine, readChildRoute } from '../lib/engine.js';
import { foremanTools } from '../lib/tools.js';

/** 默认策略：足够大的超时，免得用例被真计时器影响。 */
const POLICY = Object.freeze({
    concurrency: 1,
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
 * 造一个只含指定服务的假 ctx。
 * @param services - 服务名 → 返回值；值是 Error 时 `get` 直接抛。
 */
function ctxOf(services) {
    return {
        get(service) {
            const value = services[service];
            if (value instanceof Error)
                throw value;
            return value;
        },
    };
}

/** 子会话头（宿主 `sessions` / `agents` 两条路返回的同一形状）。 */
const HEADER = Object.freeze({ provider: 'trae', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' });

/**
 * 造一个最小派单宿主：激活立刻落定，子会话头由用例给定。
 * @param args.members - 名册。
 * @param args.policy - 策略。
 * @param args.header - 子会话头的 provider/model/reasoningEffort。
 * @param args.sessionsThrows - true 时 `ctx.get('sessions')` 直接抛错。
 */
function createHost({ members, policy = POLICY, header = HEADER, sessionsThrows = false } = {}) {
    const activations = [];
    const ledger = [];

    const subagents = {
        providers: new Map([['spawn', { name: 'spawn', capabilities: { agentOptions: true } }]]),
        async startActivation(spec) {
            const id = String(spec.label ?? '').split(' ')[0];
            const childId = `child-${activations.length + 1}`;
            activations.push({ id, childId, spec });
            return {
                childId,
                result: Promise.resolve({ output: [{ type: 'text', text: `${id} 做完了` }], stopReason: 'completed' }),
                dispose: async () => {},
            };
        },
    };
    const sessions = { get: () => ({ header }) };
    const services = {
        subagents,
        sessions: sessionsThrows ? new Error('sessions 服务不可用') : sessions,
        // 团队模式必须走普通激活路径，用例只观察一条执行线路。
        agentTeams: undefined,
        agents: undefined,
    };
    const ctx = ctxOf(services);

    const store = {
        members: () => members,
        policy: () => policy,
        writeArtifact: (runId, orderId) => `/tmp/${runId}-${orderId}.md`,
        recordRun: (record) => {
            ledger.push(record);
            return true;
        },
    };

    const engine = new ForemanEngine({ ctx, store, logger: { info() {}, warn() {}, error() {} } });

    return {
        engine,
        store,
        activations,
        ledger,
        dispatch(orders, { sessionId = 'session-1', goal = '把活干完' } = {}) {
            return engine.dispatch({
                parent: { id: 'parent-1' },
                sessionId,
                goal,
                orders,
                policy,
            });
        },
    };
}

// ── readChildRoute：三条分支 ────────────────────────────────────────────────

test('readChildRoute：从 sessions.get(childId).header 读到路由', () => {
    const ctx = ctxOf({
        sessions: { get: id => (id === 'child-9' ? { header: HEADER } : undefined) },
    });
    assert.deepEqual(readChildRoute(ctx, 'child-9'), {
        provider: 'trae',
        model: 'deepseek-v4.1-flash',
        reasoningEffort: 'high',
    });
});

test('readChildRoute：sessions 没有时退到 agents.get(childId).session.header', () => {
    const ctx = ctxOf({
        sessions: { get: () => undefined },
        agents: { get: id => (id === 'child-9' ? { session: { header: HEADER } } : undefined) },
    });
    assert.equal(readChildRoute(ctx, 'child-9')?.model, 'deepseek-v4.1-flash');
    assert.equal(readChildRoute(ctx, 'child-9')?.provider, 'trae');
});

test('readChildRoute：两条来源都没有头时返回 undefined', () => {
    const ctx = ctxOf({
        sessions: { get: () => ({}) },
        agents: { get: () => ({ session: {} }) },
    });
    assert.equal(readChildRoute(ctx, 'child-9'), undefined);
    // 没有服务也一样：诊断读不到就是读不到，不抛。
    assert.equal(readChildRoute(ctxOf({}), 'child-9'), undefined);
});

test('readChildRoute：childId 为空时直接返回 undefined，不碰任何服务', () => {
    let touched = false;
    const ctx = {
        get() {
            touched = true;
            throw new Error('不该被调用');
        },
    };
    assert.equal(readChildRoute(ctx, ''), undefined);
    assert.equal(readChildRoute(ctx, undefined), undefined);
    assert.equal(readChildRoute(ctx, null), undefined);
    assert.equal(touched, false);
});

test('readChildRoute：服务抛错时安静返回 undefined', () => {
    assert.equal(readChildRoute(ctxOf({ sessions: new Error('boom') }), 'child-9'), undefined);
});

// ── 派单：真实路由与名册声明的比对 ─────────────────────────────────────────

test('dispatch：工单拿到子会话里的真实路由', async () => {
    const host = createHost({ members: [member('m')] });
    const run = await host.dispatch([order('W1')]);

    assert.equal(run.orders[0].status, 'done');
    assert.equal(run.orders[0].childId, 'child-1');
    assert.equal(run.orders[0].actualRoute, 'trae/deepseek-v4.1-flash');
    assert.equal(run.orders[0].actualReasoningEffort, 'high');
    // 名册留空 = 跟随父会话，没有可比对的声明。
    assert.equal(run.orders[0].routeMismatch, false);
    assert.equal(run.orders[0].routeNote, '');
});

test('dispatch：名册声明与真实路由不同时 routeMismatch 为 true', async () => {
    const host = createHost({
        members: [member('m', { provider: 'deepseek-official', model: 'deepseek-flash' })],
    });
    const run = await host.dispatch([order('W1')]);

    assert.equal(run.orders[0].route, 'deepseek-official/deepseek-flash', 'route 仍然是声明');
    assert.equal(run.orders[0].actualRoute, 'trae/deepseek-v4.1-flash', 'actualRoute 是事实');
    assert.equal(run.orders[0].routeMismatch, true);
});

test('dispatch：名册声明与真实路由一致时 routeMismatch 为 false', async () => {
    const host = createHost({
        members: [member('m', { provider: 'trae', model: 'deepseek-v4.1-flash' })],
    });
    const run = await host.dispatch([order('W1')]);

    assert.equal(run.orders[0].actualRoute, 'trae/deepseek-v4.1-flash');
    assert.equal(run.orders[0].routeMismatch, false);
});

test('dispatch：名册 provider 为空（跟随父会话）时永远不算不一致', async () => {
    // 声明为空、实际读到什么都是允许的。
    const host = createHost({ members: [member('m')] });
    const run = await host.dispatch([order('W1')]);
    assert.equal(run.orders[0].routeMismatch, false);

    // 声明为空但真实路由与任何值都不同，也不算不一致。
    const other = createHost({
        members: [member('m')],
        header: { provider: 'kimi', model: 'kimi-k3', reasoningEffort: '' },
    });
    const otherRun = await other.dispatch([order('W1')]);
    assert.equal(otherRun.orders[0].actualRoute, 'kimi/kimi-k3');
    assert.equal(otherRun.orders[0].routeMismatch, false);
});

// ── 诊断不能影响派单 ───────────────────────────────────────────────────────

test('dispatch：ctx.get("sessions") 抛错时派单照常成功，路由留空并记说明', async () => {
    const host = createHost({ members: [member('m')], sessionsThrows: true });
    const run = await host.dispatch([order('W1')]);

    assert.equal(run.orders[0].status, 'done', '诊断链路坏掉不影响交付');
    assert.equal(run.orders[0].chars, 'W1 做完了'.length);
    assert.equal(run.orders[0].actualRoute, '');
    assert.equal(run.orders[0].routeMismatch, false);
    assert.match(run.orders[0].routeNote, /读不到子会话模型头/);
    assert.equal(host.ledger.length, 1, '台账照样落一条');
});

// ── 工具结果与 schema ─────────────────────────────────────────────────────

test('foreman_dispatch / review / status 的 orderRow 与 schema 带路由回显字段', async () => {
    const host = createHost({
        members: [member('m', { provider: 'deepseek-official', model: 'deepseek-flash' })],
    });
    const run = await host.dispatch([order('W1')]);
    // 直接走工具层，确认 orderRow 没把这三个字段丢掉。
    const tools = foremanTools({
        ctx: ctxOf({}),
        store: host.store,
        engine: host.engine,
        logger: { info() {}, warn() {}, error() {} },
    });
    const byName = new Map(tools.map(tool => [tool.name, tool]));
    const status = await byName.get('foreman_status').execute({ runId: run.id }, { agent: { session: { id: 'session-1' } } });
    assert.equal(status.orders[0].actualRoute, 'trae/deepseek-v4.1-flash');
    assert.equal(status.orders[0].routeMismatch, true);
    assert.equal(status.orders[0].routeNote, '');

    // required 里不加这三个字段：旧结果不该因为新字段被判不合法。
    for (const name of ['foreman_dispatch', 'foreman_review', 'foreman_status']) {
        const tool = byName.get(name);
        const schema = tool.output.schema;
        assert.ok(!schema.required.includes('actualRoute'), `${name} 不应 required actualRoute`);
        assert.ok(!schema.required.includes('routeMismatch'), `${name} 不应 required routeMismatch`);
        assert.ok(!schema.required.includes('routeNote'), `${name} 不应 required routeNote`);
    }
    const dispatchProps = byName.get('foreman_dispatch').output.schema.properties.orders.items.properties;
    assert.equal(dispatchProps.actualRoute.type, 'string');
    assert.equal(dispatchProps.routeMismatch.type, 'boolean');
    assert.equal(dispatchProps.routeNote.type, 'string');
    assert.equal(dispatchProps.route.type, 'string', '声明字段仍然在');
});
