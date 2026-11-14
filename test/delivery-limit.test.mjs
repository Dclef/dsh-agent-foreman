/**
 * 交付摘要超限自动重出：边界、提示词、看板与纯函数回归。
 *
 * 用户要求：超过 2000 字直接打回重出一次，不截断、不把超长文本送进父模型看板。
 * 全部离线：不启宿主、不联网、不调用真实模型、不写真实台账。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_LIMIT, checkDelivery, buildPrompt, ForemanEngine } from '../lib/engine.js';

test('SUMMARY_LIMIT 是 2000，checkDelivery 按中文字符计数', () => {
    assert.equal(SUMMARY_LIMIT, 2000);
    assert.deepEqual(checkDelivery(''), { ok: true, chars: 0, reason: '' });
    assert.equal(checkDelivery('中'.repeat(1999)).ok, true);
    assert.equal(checkDelivery('中'.repeat(2000)).ok, true);
    const over = checkDelivery('中'.repeat(2001));
    assert.equal(over.ok, false);
    assert.equal(over.chars, 2001);
    assert.match(over.reason, /2001/);
    assert.equal(checkDelivery(null).ok, true);
    assert.equal(checkDelivery(123).chars, 0);
});

test('buildPrompt：不传 redo 时无重出段，传 redo 时明确只重写摘要', () => {
    const order = { id: 'W1', title: '甲', task: '干活', accept: '', dependsOn: [], writeScopes: [], checklist: [] };
    const plain = buildPrompt({ goal: '', order });
    assert.ok(!plain.includes('上一份摘要超限'));
    const redo = buildPrompt({ goal: '', order, redo: { chars: 2500 } });
    assert.ok(redo.includes('上一份摘要超限，这次必须重写'));
    assert.ok(redo.includes('2500'));
    assert.ok(redo.includes('不要重新做一遍任务'));
    assert.ok(redo.includes('详见 <路径>'));
    const both = buildPrompt({ goal: '', order, feedback: '补齐测试', redo: { chars: 2500 } });
    assert.ok(both.includes('上一份摘要超限'));
    assert.ok(both.includes('补齐测试'));
});

test('renderBoard：重出记录与超限失败都不把超长正文送进看板', () => {
    const engine = new ForemanEngine({ ctx: { get: () => undefined }, store: {}, logger: {} });
    const long = '超长内容'.repeat(400);
    const run = {
        id: 'R-1', goal: '', status: 'waiting-review', orders: [
            { id: 'W1', title: '甲', contractorName: '力工', route: 'p/m', status: 'done',
                dependsOn: [], writeScopes: [], checklist: [], text: '精简摘要',
                deliveryRedo: { firstChars: 2500, secondChars: 800, note: '自动重出一次' } },
            { id: 'W2', title: '乙', contractorName: '力工', route: 'p/m', status: 'failed',
                dependsOn: [], writeScopes: [], checklist: [], text: '',
                error: '交付摘要超限且重出后仍超限',
                deliveryRedo: { firstChars: 2500, secondChars: 3000, note: '自动重出一次' } },
        ],
    };
    const board = engine.renderBoard(run, { withOutput: true });
    assert.ok(board.includes('摘要重出 2500→800 字'));
    assert.ok(board.includes('摘要重出 2500→3000 字'));
    assert.ok(board.includes('交付摘要超过 2000 字会自动重出一次'));
    assert.ok(!board.includes(long), '失败工单的超长正文绝不能出现在看板');
});
