import test from 'node:test';
import assert from 'node:assert/strict';
import { teammateDisplayName, MAX_TEAMMATE_NAME_LENGTH } from '../lib/team.js';

/** 宿主 spawnTeammate 的命名规则：1..32、^[a-z][a-z0-9-]*$、不等于 lead。 */
const HOST_NAME = /^[a-z][a-z0-9-]*$/;

function assertHostLegal(name, label) {
    assert.equal(typeof name, 'string', label + ' 应返回字符串');
    assert.ok(name.length >= 1 && name.length <= 32, label + ' 长度应为 1..32，实际 ' + name.length + '：' + name);
    assert.match(name, HOST_NAME, label + ' 应匹配 ^[a-z][a-z0-9-]*$：' + name);
    assert.notEqual(name, 'lead', label + ' 不能叫 lead');
    assert.ok(!/[^a-z0-9-]/.test(name), label + ' 不应含大写/下划线/中文/空格：' + name);
}

/** 本轮真实故障的两张工单用的承包商 id。 */
const FAILED_IDS = ['member-1-mw2bmnak', 'member-1-mvs979da'];

test('真实故障 id 生成的名字不再超过宿主 32 字符上限', () => {
    for (const id of FAILED_IDS) {
        const name = teammateDisplayName({ id });
        assertHostLegal(name, id);
        assert.ok(name.length <= 32);
        assert.ok(name.startsWith('member-1-mw2b') || name.length <= 32);
    }
});

test('generation 1..100 全部落在宿主的命名规则内', () => {
    for (const id of FAILED_IDS) {
        for (let generation = 1; generation <= 100; generation += 1) {
            assertHostLegal(teammateDisplayName({ id }, generation), id + ' gen' + generation);
        }
    }
});

test('generation 1..100 对超长 id 与中文名同样合法', () => {
    const members = [{ id: 'x'.repeat(200) }, { id: '力工', name: '力工' }, { id: 'member-' + '9'.repeat(64) }];
    for (const member of members) {
        for (let generation = 1; generation <= 100; generation += 1) {
            assertHostLegal(teammateDisplayName(member, generation), 'gen' + generation);
        }
    }
});

test('边界：空对象 / 中文 id / 中文 name / 纯数字开头 / id 恰为 lead', () => {
    assertHostLegal(teammateDisplayName({}), '空对象');
    assertHostLegal(teammateDisplayName({ id: '' }), '空 id');
    assertHostLegal(teammateDisplayName({ id: '力工-一号' }), '中文 id');
    assertHostLegal(teammateDisplayName({ name: '力工' }), '中文 name');
    assertHostLegal(teammateDisplayName({ id: '123abc' }), '纯数字开头 id');
    assertHostLegal(teammateDisplayName({ id: '9' }), '单个数字 id');
    assertHostLegal(teammateDisplayName({ id: 'lead' }), 'id 恰为 lead');
    assertHostLegal(teammateDisplayName({ id: 'lead', name: 'lead' }, 7), 'lead + generation');
    assertHostLegal(teammateDisplayName({ id: '---' }), '仅连字符 id');
    assertHostLegal(teammateDisplayName({ id: 'A_B C' }), '大写/下划线/空格 id');
});

test('稳定：同一 member + 同一 generation 每次结果相同', () => {
    for (const id of [...FAILED_IDS, '力工', 'x'.repeat(80)]) {
        for (let generation = 1; generation <= 5; generation += 1) {
            const first = teammateDisplayName({ id }, generation);
            const second = teammateDisplayName({ id }, generation);
            assert.equal(first, second, id + ' gen' + generation + ' 应稳定');
        }
    }
});

test('唯一性：不同 id 或不同模型路由得到不同名字', () => {
    const a = teammateDisplayName({ id: 'member-1-mw2bmnak' });
    const b = teammateDisplayName({ id: 'member-1-mvs979da' });
    assert.notEqual(a, b, '不同 id 不应撞名');
    assert.notEqual(teammateDisplayName({ id: 'worker' }), teammateDisplayName({ id: 'worker', model: 'gpt-x' }), '不同 model 不应同名');
    assert.notEqual(
        teammateDisplayName({ id: 'worker', provider: 'p1', model: 'm' }),
        teammateDisplayName({ id: 'worker', provider: 'p2', model: 'm' }),
        '不同 provider 不应同名',
    );
    assert.notEqual(
        teammateDisplayName({ id: 'worker', provider: 'p', model: 'm', reasoningEffort: 'high' }),
        teammateDisplayName({ id: 'worker', provider: 'p', model: 'm', reasoningEffort: 'low' }),
        '不同 reasoningEffort 不应同名',
    );
});

test('导出常量与函数签名符合约定', () => {
    assert.equal(MAX_TEAMMATE_NAME_LENGTH, 32);
    assert.equal(typeof teammateDisplayName, 'function');
    // 省略 generation 等价于 gen 1。
    assert.equal(teammateDisplayName({ id: 'member-1-mw2bmnak' }), teammateDisplayName({ id: 'member-1-mw2bmnak' }, 1));
    // 非法 generation 退化到 1，不产生非法名字。
    assertHostLegal(teammateDisplayName({ id: 'worker' }, 0), 'gen0');
    assertHostLegal(teammateDisplayName({ id: 'worker' }, -5), 'gen-5');
    assertHostLegal(teammateDisplayName({ id: 'worker' }, Number.NaN), 'genNaN');
});