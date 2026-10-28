/**
 * 子智能体白名单同步测试。
 *
 * 这一层的价值全在"宿主配置和我们想的不是一回事"上，所以这里造的是宿主那两份
 * volatile 的**行为复制品**——冻结对象 + `Symbol.for("cosmokit.volatile.write")`
 * 写入通道，与 `@deepseek-ai/cosmokit` 的 `createVolatile` 完全同形。用真符号而
 * 不是自造一个，因为跨模块共享正是它能work的前提，测的就得是这个前提。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { rosterRoutes, syncWhitelist, writeVolatile } from '../lib/whitelist.js';

/** cosmokit 的写入符号；`Symbol.for` 保证和宿主拿到的同一个键。 */
const WRITE = Symbol.for('cosmokit.volatile.write');

/**
 * 造一个与宿主同形的 volatile：冻结，只有 get() 和写入符号。
 * @param value - 初始值。
 * @returns 引用对象。
 */
function volatileRef(value) {
    let current = value;
    return Object.freeze({
        get: () => current,
        [WRITE]: (next) => {
            current = next;
        },
    });
}

/**
 * 造一个"不可写"的 volatile：有 get() 但没有写入符号。
 * 宿主换了 volatile 实现时就是这个形状。
 * @param value - 初始值。
 * @returns 引用对象。
 */
function readOnlyRef(value) {
    return Object.freeze({ get: () => value });
}

/** 造一个假 ctx：`get()` 只认 `subagentModelSelection`。 */
function fakeCtx(service) {
    return {
        get(name) {
            return name === 'subagentModelSelection' ? service : undefined;
        },
    };
}

/** 造一个假 store：只需要 `members()`。 */
function fakeStore(members) {
    return { members: () => members.map(member => ({ ...member })) };
}

/** 造一个假服务：两份 volatile。 */
function fakeService({ enabled = false, allowedModels = [] } = {}) {
    return {
        config: {
            enabled: volatileRef(enabled),
            allowedModels: volatileRef(allowedModels),
        },
    };
}

/** 一个什么都不做的 logger，避免测试输出噪音。 */
const silentLogger = { warn() {}, info() {}, debug() {}, error() {} };

test('rosterRoutes：去重、跳过停用、跳过路由不全，并保持名册顺序', () => {
    const routes = rosterRoutes([
        { name: 'a', provider: 'trae', model: 'solo', enabled: true },
        // 同一条路由的第二个人不重复进白名单
        { name: 'b', provider: 'trae', model: 'solo' },
        // 停用的不进白名单
        { name: 'c', provider: 'qoder', model: 'q1', enabled: false },
        // 只有 provider 没有 model：属于"继承父会话"，不进白名单
        { name: 'd', provider: 'workbuddy', model: '' },
        // 只有 model 没有 provider，同样跳过
        { name: 'e', provider: '', model: 'w1' },
        // 空白串也算缺字段（面板会存成空串）
        { name: 'f', provider: '   ', model: 'm' },
        { name: 'g', provider: 'qodercn', model: 'q2' },
    ]);
    assert.deepEqual(routes, [
        { provider: 'trae', model: 'solo' },
        { provider: 'qodercn', model: 'q2' },
    ], '只保留启用且路由完整的成员，按名册顺序');
});

test('rosterRoutes：同一个 provider 下不同 model 算两条路由', () => {
    const routes = rosterRoutes([
        { name: 'a', provider: 'qwen-local', model: 'taste-v1' },
        { name: 'b', provider: 'qwen-local', model: 'taste-v2' },
    ]);
    assert.deepEqual(routes, [
        { provider: 'qwen-local', model: 'taste-v1' },
        { provider: 'qwen-local', model: 'taste-v2' },
    ]);
});

test('rosterRoutes：非数组与空名册都给空数组，不抛', () => {
    assert.deepEqual(rosterRoutes(undefined), []);
    assert.deepEqual(rosterRoutes(null), []);
    assert.deepEqual(rosterRoutes([]), []);
    // 名册里混进脏条目也不该连累整批
    assert.deepEqual(rosterRoutes([null, 42, 'x']), []);
});

test('rosterRoutes：provider/model 会被 trim，返回的是新对象', () => {
    const members = [{ name: 'a', provider: '  trae  ', model: ' solo ' }];
    const routes = rosterRoutes(members);
    assert.deepEqual(routes, [{ provider: 'trae', model: 'solo' }]);
    routes[0].model = '改过了';
    assert.equal(members[0].model, ' solo ', '不能把内部对象直接送出去');
});

test('syncWhitelist：写入后 allowedModels 等于名册路由，enabled 变 true', () => {
    const service = fakeService({ enabled: false, allowedModels: [{ provider: 'old', model: 'stale' }] });
    const result = syncWhitelist(
        fakeCtx(service),
        fakeStore([
            { name: 'a', provider: 'trae', model: 'solo' },
            { name: 'b', provider: 'qoder', model: 'q1' },
        ]),
        silentLogger,
    );
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.deepEqual(service.config.allowedModels.get(), [
        { provider: 'trae', model: 'solo' },
        { provider: 'qoder', model: 'q1' },
    ]);
    assert.equal(service.config.enabled.get(), true, 'enabled 必须一起置 true');
    // previous 是写之前的快照，方便面板说明"从什么改成了什么"
    assert.deepEqual(result.previous, { enabled: false, allowedModels: [{ provider: 'old', model: 'stale' }] });
});

test('syncWhitelist：已经对齐时 changed 为 false，但仍然幂等地写一遍', () => {
    const routes = [{ provider: 'trae', model: 'solo' }];
    const service = fakeService({ enabled: true, allowedModels: routes });
    const result = syncWhitelist(fakeCtx(service), fakeStore([{ name: 'a', ...routes[0] }]), silentLogger);
    assert.equal(result.ok, true);
    assert.equal(result.changed, false, '内容一致就不算改动');
    assert.deepEqual(service.config.allowedModels.get(), routes);
});

test('syncWhitelist：名册里没有显式路由时不动宿主原配置，changed 为 false', () => {
    const original = [{ provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4-Flash' }];
    const service = fakeService({ enabled: true, allowedModels: original });
    const result = syncWhitelist(
        fakeCtx(service),
        // 全员都继承父会话（provider/model 空）
        fakeStore([{ name: 'a', provider: '', model: '' }, { name: 'b' }]),
        silentLogger,
    );
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.deepEqual(service.config.allowedModels.get(), original, '绝不能写成空数组：宿主会直接抛错');
    assert.equal(service.config.enabled.get(), true, 'enabled 也不该被顺手改掉');
    assert.match(result.reason, /保持宿主原配置/);
});

test('syncWhitelist：宿主没有该服务时静默返回 ok:false，不抛', () => {
    const result = syncWhitelist(fakeCtx(undefined), fakeStore([{ name: 'a', provider: 'p', model: 'm' }]), silentLogger);
    assert.equal(result.ok, false);
    assert.match(result.reason, /没有 subagentModelSelection/);
});

test('syncWhitelist：ctx.get 抛错等价于服务不存在', () => {
    const ctx = {
        get() {
            throw new Error('service not injected');
        },
    };
    const result = syncWhitelist(ctx, fakeStore([{ name: 'a', provider: 'p', model: 'm' }]), silentLogger);
    assert.equal(result.ok, false);
});

test('syncWhitelist：服务存在但没有 config 时不抛', () => {
    const result = syncWhitelist(fakeCtx({}), fakeStore([{ name: 'a', provider: 'p', model: 'm' }]), silentLogger);
    assert.equal(result.ok, false);
    assert.match(result.reason, /config/);
});

test('syncWhitelist：volatile 不可写时返回 ok:false，不抛也不硬改原值', () => {
    const readonly = readOnlyRef([{ provider: 'old', model: 'x' }]);
    const service = { config: { enabled: readOnlyRef(false), allowedModels: readonly } };
    const result = syncWhitelist(fakeCtx(service), fakeStore([{ name: 'a', provider: 'p', model: 'm' }]), silentLogger);
    assert.equal(result.ok, false);
    assert.match(result.reason, /volatile|写入/);
    assert.deepEqual(service.config.allowedModels.get(), [{ provider: 'old', model: 'x' }]);
    // 名册路由照样带回去，便于面板显示"想同步成什么"
    assert.deepEqual(result.routes, [{ provider: 'p', model: 'm' }]);
});

test('syncWhitelist：写完一半就失败也不能把 enabled 留成 true + 空名单的状态', () => {
    // enabled 可写、allowedModels 不可写：这是真实存在的坏组合，宿主的 current()
    // 会因为"开着但没有名单"直接抛错。所以写入顺序是先 names 后 enabled ——
    // 这里验证的就是 allowedModels 先失败时 enabled 不会被改成 true。
    const enabledRef = volatileRef(false);
    const service = { config: { enabled: enabledRef, allowedModels: readOnlyRef([{ provider: 'keep', model: 'me' }]) } };
    const result = syncWhitelist(fakeCtx(service), fakeStore([{ name: 'a', provider: 'p', model: 'm' }]), silentLogger);
    assert.equal(result.ok, false);
    assert.equal(enabledRef.get(), false, '名单没写成时不能开启开关');
});

test('writeVolatile：能写进带写入符号的引用', () => {
    const ref = volatileRef([]);
    writeVolatile(ref, [{ provider: 'a', model: 'b' }]);
    assert.deepEqual(ref.get(), [{ provider: 'a', model: 'b' }]);
});

test('writeVolatile：不可写时抛错（由 syncWhitelist 翻译成结果对象）', () => {
    assert.throws(() => writeVolatile(readOnlyRef({}), { a: 1 }));
    assert.throws(() => writeVolatile({}, { a: 1 }), /get/);
});
