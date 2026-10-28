/**
 * 岗位匹配测试：`contractor` 写名字、id 或岗位时，工单落到谁身上。
 *
 * 这组用例只碰纯函数（`normalizeMember` / `normalizeOrders` / `assignContractors`），
 * 不启动宿主：要证明的是"点名点得准"，而不是接线。名册持久化另有测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ForemanError, normalizeMember } from '../lib/store.js';
import { ForemanEngine, normalizeOrders } from '../lib/engine.js';

/** 造一个规范化后的承包商，省掉重复字段。 */
function member(raw) {
    return normalizeMember({ provider: 'p', model: 'm', ...raw });
}

/** 只取分配结果的名字，便于比对顺序。 */
function names(assigned) {
    return assigned.map(order => order.member.name);
}

test('normalizeMember：role 可选，缺省用名字，trim 且有长度上限', () => {
    assert.equal(member({ name: '力工-前端' }).role, '力工-前端', '没有 role 时用名字当岗位');
    assert.equal(member({ name: '力工-前端', role: '  力工  ' }).role, '力工', 'role 要去空白');
    assert.equal(member({ name: 'x', role: '' }).role, 'x', '空 role 退回名字');
    assert.equal(member({ name: 'x', role: '   ' }).role, 'x', '全空白 role 退回名字');
    assert.equal(member({ name: 'x', role: '岗'.repeat(40) }).role, '岗'.repeat(40), '40 字刚好合法');
    // 非字符串当成没填，不因为面板传了数字就整条记录作废
    assert.equal(member({ name: 'x', role: 42 }).role, 'x');
});

test('normalizeMember：旧的描述性 role 不被当成岗位，也不会让记录失效', () => {
    // 升级前 role 是自由描述，可能很长；硬报错会把老条目整条丢掉
    const long = '负责前端实现，遇到不确定的地方先问，不要改后端'.repeat(4);
    const member1 = member({ name: '老王', role: long });
    assert.equal(member1.role, '老王', '超长旧 role 退回名字当岗位');
    assert.match(member1.prompt, /负责前端实现/, '旧 role 文本折进提示词，配置不丢');

    const withControl = member({ name: '老李', role: '力工\u0001附注' });
    assert.equal(withControl.role, '老李');
    assert.match(withControl.prompt, /力工 附注/);
});

test('normalizeMember：旧名册记录（无 role）照样可加载', () => {
    const legacy = normalizeMember({ id: 'w1', name: '老王', provider: 'p', model: 'm', enabled: false });
    assert.equal(legacy.name, '老王');
    assert.equal(legacy.role, '老王');
    assert.equal(legacy.enabled, false);
    // specialty/note 仍然并进提示词，老配置不丢
    const withNote = member({ name: 'x', specialty: '只改前端', note: '别动后端' });
    assert.match(withNote.prompt, /只改前端/);
    assert.match(withNote.prompt, /别动后端/);
});

test('normalizeOrders：岗位名是已知值，未知岗位/名字仍然报错', () => {
    const members = [
        member({ name: '力工-前端', role: '力工' }),
        member({ name: '安全员', role: '安全员' }),
    ];
    const orders = normalizeOrders([{ task: 'x', contractor: '力工' }], members);
    assert.equal(orders[0].contractor, '力工', '岗位名原样留着，解析交给 assignContractors');

    // 报错信息里要能看见可选的名字与岗位，父模型下一轮才知道填什么
    let error;
    try {
        normalizeOrders([{ task: 'x', contractor: '不存在的岗位' }], members);
    }
    catch (caught) {
        error = caught;
    }
    assert.ok(error instanceof ForemanError);
    assert.equal(error.code, 'UNKNOWN_MEMBER');
    assert.match(error.message, /力工-前端/);
    assert.match(error.message, /安全员/);

    // 停用的岗位不算已知：派给停用实例等于派给不存在的人
    const withDisabled = [...members, member({ name: '小工', role: '小工', enabled: false })];
    assert.throws(() => normalizeOrders([{ task: 'x', contractor: '小工' }], withDisabled), /不在名册里/);
});

test('assignContractors：精确名字优先于岗位，id 优先于名字', () => {
    const members = [
        member({ id: 'a', name: '力工-前端', role: '力工' }),
        member({ id: 'b', name: '力工-后端', role: '力工' }),
    ];
    const assigned = ForemanEngine.assignContractors([
        { id: 'W1', title: '前端', contractor: '力工-前端' },
        { id: 'W2', title: '按 id', contractor: 'b' },
        { id: 'W3', title: '大小写', contractor: ' 力工-前端 ' },
    ], members);
    assert.deepEqual(names(assigned), ['力工-前端', '力工-后端', '力工-前端']);
});

test('assignContractors：岗位在启用实例之间独立轮转', () => {
    const members = [
        member({ id: 'a', name: '力工-前端', role: '力工' }),
        member({ id: 'b', name: '力工-后端', role: '力工' }),
        member({ id: 'c', name: '安全员', role: '安全员' }),
    ];
    const orders = [
        { id: 'W1', title: '一', contractor: '力工' },
        { id: 'W2', title: '二', contractor: '力工' },
        { id: 'W3', title: '三', contractor: '力工' },
        { id: 'W4', title: '四', contractor: '安全员' },
    ];
    const assigned = ForemanEngine.assignContractors(orders, members);
    assert.deepEqual(names(assigned), ['力工-前端', '力工-后端', '力工-前端', '安全员']);
    // 只按岗位过滤：不该混进别的岗位
    assert.ok(assigned.slice(0, 3).every(order => order.member.role === '力工'));
});

test('assignContractors：岗位池只含启用的实例', () => {
    const members = [
        member({ id: 'a', name: '力工-前端', role: '力工' }),
        member({ id: 'b', name: '力工-后端', role: '力工', enabled: false }),
        // 停用成员不该被直接点名派单，即使名字写对了
    ];
    const [first, second] = ForemanEngine.assignContractors([
        { id: 'W1', title: '一', contractor: '力工' },
        { id: 'W2', title: '二', contractor: '力工' },
    ], members);
    assert.equal(first.member.name, '力工-前端');
    assert.equal(second.member.name, '力工-前端', '池子里只有一个人，所有单都给他');
});

test('assignContractors：不存在的岗位报 UNKNOWN_MEMBER，绝不回退全名册', () => {
    const members = [
        member({ id: 'a', name: '力工', role: '力工' }),
        member({ id: 'b', name: '小工', role: '小工' }),
    ];
    let error;
    try {
        ForemanEngine.assignContractors([{ id: 'W1', title: '复核', contractor: '安全员' }], members);
    }
    catch (caught) {
        error = caught;
    }
    assert.ok(error instanceof ForemanError);
    assert.equal(error.code, 'UNKNOWN_MEMBER');
    assert.match(error.message, /安全员/);
    assert.match(error.message, /力工/);
    // 报错里要带上这一单的标题，多单并派时才知道是哪张
    assert.match(error.message, /复核/);
});

test('assignContractors：没写 contractor 时全名册轮转，旧行为不变', () => {
    const members = [member({ name: 'a' }), member({ name: 'b' })];
    const assigned = ForemanEngine.assignContractors([
        { id: 'W1', title: '一' },
        { id: 'W2', title: '二' },
        { id: 'W3', title: '三' },
    ], members);
    assert.deepEqual(names(assigned), ['a', 'b', 'a']);
    // 传进来的数组不被改写
    assert.equal(assigned[0].contractor, undefined);
});

test('assignContractors：空名册与全停用名册都报 EMPTY_ROSTER', () => {
    const cases = [
        [],
        [member({ name: 'a', enabled: false })],
    ];
    for (const members of cases) {
        let error;
        try {
            ForemanEngine.assignContractors([{ id: 'W1', title: '一' }], members);
        }
        catch (caught) {
            error = caught;
        }
        assert.ok(error instanceof ForemanError);
        assert.equal(error.code, 'EMPTY_ROSTER');
    }
});

test('端到端（纯函数）：同一岗位的两张单分给两个实例', () => {
    // 模拟一次真实派单：normalizeOrders 预校验 + assignContractors 分配。
    const members = [
        member({ name: '力工-A', role: '力工' }),
        member({ name: '力工-B', role: '力工' }),
    ];
    const orders = normalizeOrders([
        { id: 'W1', task: '改前端', contractor: '力工' },
        { id: 'W2', task: '改后端', contractor: '力工' },
    ], members);
    const assigned = ForemanEngine.assignContractors(orders, members);
    assert.deepEqual(names(assigned), ['力工-A', '力工-B']);
    assert.equal(new Set(assigned.map(order => order.member.id)).size, 2);
});
