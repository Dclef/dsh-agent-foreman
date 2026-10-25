/**
 * 纯函数与存储层测试。
 *
 * 这里只测"不依赖宿主"的部分：校验规则、排期、提示词、看板渲染、名册落盘。
 * 带假宿主的端到端测试在 harness.test.mjs。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    DEFAULT_POLICY,
    ForemanError,
    ForemanStore,
    normalizeMember,
    normalizePolicy,
    resolveDataDir,
} from '../lib/store.js';
import { buildPrompt, extractText, layerOrders, normalizeOrders } from '../lib/engine.js';

/** 造一个临时数据目录。 */
function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-test-'));
}

test('normalizeMember：名字必填、路由必须成对、重复名字被拒', () => {
    assert.throws(() => normalizeMember({ name: '   ' }), /必须有名字/);
    assert.throws(() => normalizeMember({ name: 'a', provider: 'x' }), /必须同时给出/);
    assert.throws(() => normalizeMember({ name: 'a', model: 'm' }), /必须同时给出/);
    const member = normalizeMember({ name: 'coder-a', provider: 'p', model: 'm', reasoningEffort: 'high' });
    assert.equal(member.name, 'coder-a');
    assert.equal(member.enabled, true);
    assert.equal(member.id, 'coder-a');
    // 大小写只差的名字压出同一个 id，视为同一条记录的更新（便于设置页改名不报错）
    assert.equal(normalizeMember({ name: 'CODER-A' }, [member]).id, 'coder-a');
    // 同名的另一条记录（id 不同）仍然要被拒，否则看板上的承包商名字会撞车
    assert.throws(() => normalizeMember({ name: 'coder-a' }, [{ ...member, id: 'legacy-1' }]), /同名/);
    // 中文名压出的 id 仍然可用
    assert.equal(normalizeMember({ name: '老王' }).id, '老王');
});

test('normalizeMember：继承父会话就是两个空字段', () => {
    const member = normalizeMember({ name: 'inherit', provider: '', model: '' });
    assert.equal(member.provider, '');
    assert.equal(member.model, '');
    assert.equal(member.reasoningEffort, '');
});

test('normalizePolicy：越界回退、字段齐全', () => {
    const policy = normalizePolicy({ concurrency: 99, timeoutSeconds: 1, maxRework: 9, maxDepth: -3 });
    assert.equal(policy.concurrency, 8);
    assert.equal(policy.timeoutSeconds, 10);
    assert.equal(policy.maxRework, 3);
    assert.equal(policy.maxDepth, 0);
    assert.equal('maxOutputChars' in policy, false, '产物上限不再是策略字段');
    assert.equal(policy.provider, DEFAULT_POLICY.provider);
    assert.deepEqual(normalizePolicy({}, DEFAULT_POLICY), { ...DEFAULT_POLICY });
});

test('normalizeOrders：id 自动生成、依赖必须在本轮、承包商必须存在', () => {
    const members = [{ id: 'coder-a', name: 'coder-a' }, { id: '老王', name: '老王' }];
    const orders = normalizeOrders([
        { title: '一', task: '做甲', contractor: 'coder-a' },
        { task: '做乙', dependsOn: ['W1'] },
    ], members);
    assert.equal(orders.length, 2);
    assert.equal(orders[0].contractor, 'coder-a');
    assert.equal(orders[1].contractor, '');
    assert.deepEqual(orders[1].dependsOn, ['W1']);

    assert.throws(() => normalizeOrders([{ task: 'x', contractor: '不存在' }], members), /不在名册里/);
    assert.throws(() => normalizeOrders([{ task: 'x' }, { task: 'y' }].map(o => ({ ...o, id: 'same' }))), /id 重复/);
    assert.throws(() => normalizeOrders([{ task: 'x', dependsOn: ['nope'] }]), /不在本轮/);
    assert.throws(() => normalizeOrders([], []), /至少需要一张工单/);
    assert.throws(() => normalizeOrders([{ task: '   ' }]), /缺少 task/);
});

test('layerOrders：依赖成环会被拒绝，分层顺序正确', () => {
    const layers = layerOrders([
        { id: 'a', dependsOn: [] },
        { id: 'b', dependsOn: ['a'] },
        { id: 'c', dependsOn: ['a'] },
        { id: 'd', dependsOn: ['b', 'c'] },
    ]);
    assert.deepEqual(layers.map(layer => layer.map(order => order.id)), [['a'], ['b', 'c'], ['d']]);
    assert.throws(() => layerOrders([
        { id: 'a', dependsOn: ['b'] },
        { id: 'b', dependsOn: ['a'] },
    ]), /成环/);
});

test('buildPrompt：自足、带验收标准与返工反馈', () => {
    const prompt = buildPrompt({
        goal: '把首页修好',
        order: { id: 'W1', title: '修 quota.js', task: '把取整改成四舍五入', accept: 'npm test 通过' },
        feedback: '缺一条回归测试',
    });
    assert.match(prompt, /【工单】W1 · 修 quota\.js/);
    assert.match(prompt, /【总目标】把首页修好/);
    assert.match(prompt, /把取整改成四舍五入/);
    assert.match(prompt, /npm test 通过/);
    assert.match(prompt, /缺一条回归测试/);
    assert.match(prompt, /不要再把工作派给别的智能体/);
    // 没有反馈时不该出现"被打回"段落
    assert.doesNotMatch(buildPrompt({ goal: '', order: { id: 'W2', title: 't', task: 'k', accept: '' } }), /被打回/);
});

test('extractText：只取 text 块，忽略其它块', () => {
    assert.equal(extractText([
        { type: 'text', text: '甲' },
        { type: 'image', data: 'x' },
        { type: 'text', text: '乙' },
    ]), '甲\n乙');
    assert.equal(extractText(undefined), '');
});

test('ForemanStore：保存/读取/删除/策略/台账', () => {
    const dir = tempDir();
    const store = new ForemanStore(dir);
    assert.deepEqual(store.members(), []);
    assert.deepEqual(store.policy(), { ...DEFAULT_POLICY });

    store.saveMembers([
        { name: 'coder-a', provider: 'p', model: 'm' },
        { name: 'tester', provider: 'p', model: 'n', enabled: false },
    ]);
    assert.equal(store.members().length, 2);
    // 重开一次，确认落盘
    const reopened = new ForemanStore(dir);
    assert.deepEqual(reopened.members().map(m => m.name), ['coder-a', 'tester']);

    reopened.upsertMember({ name: 'coder-a', provider: 'p2', model: 'm2' });
    assert.equal(reopened.members()[0].model, 'm2');
    assert.equal(reopened.removeMember('tester'), true);
    assert.equal(reopened.removeMember('nobody'), false);

    const policy = reopened.savePolicy({ concurrency: 2 });
    assert.equal(policy.concurrency, 2);
    assert.equal(new ForemanStore(dir).policy().concurrency, 2);

    reopened.recordRun({ id: 'R-1', at: new Date().toISOString(), status: 'accepted', orders: [] });
    reopened.recordRun({ id: 'R-2', at: new Date().toISOString(), status: 'waiting-review', orders: [] });
    const runs = reopened.recentRuns(5);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].id, 'R-2');
});

test('ForemanStore：坏名册不阻断启动，坏条目被跳过', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'roster.json'), JSON.stringify({
        members: [
            { name: 'ok', provider: 'p', model: 'm' },
            { name: 'broken', provider: 'p' }, // 路由不成对
        ],
    }));
    const store = new ForemanStore(dir);
    assert.deepEqual(store.members().map(m => m.name), ['ok']);

    fs.writeFileSync(path.join(dir, 'roster.json'), '{ not json');
    assert.deepEqual(new ForemanStore(dir).members(), []);
});

test('resolveDataDir：显式变量 > LOCALAPPDATA > baseDir', () => {
    assert.equal(resolveDataDir('C:/x', { DSH_AGENT_FOREMAN_DATA: 'D:/only' }), 'D:/only');
    const local = resolveDataDir('C:/x', { LOCALAPPDATA: 'C:/Users/u/AppData/Local' });
    assert.equal(local, path.join('C:/Users/u/AppData/Local', 'dsh-agent-foreman'));
    assert.equal(resolveDataDir('C:/base', {}), path.join('C:/base', '.data'));
});

test('ForemanError 带 code', () => {
    const error = new ForemanError('x', 'NOPE');
    assert.equal(error.code, 'NOPE');
    assert.ok(error instanceof Error);
});
