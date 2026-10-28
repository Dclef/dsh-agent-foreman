/**
 * 快照存储与只读恢复测试。
 *
 * 两块：
 *
 * 1. `ForemanStore` 的快照区（`<dataDir>/runs/`）：原子写、损坏跳过、同 id 取新、
 *    runId 不能穿出目录。
 * 2. `ForemanEngine` 在内存 miss 时的恢复：能按显式 runId 或本会话找回，中断的
 *    那轮只读不重跑，跨会话不串单。
 *
 * 只依赖 node 内建模块与 `lib/`，不碰宿主的 `subagents` 服务——恢复路径若真去
 * 启动子智能体，下面的假 ctx 会直接抛错把它暴露出来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ForemanError, ForemanStore, sanitizeRunId } from '../lib/store.js';
import { ForemanEngine } from '../lib/engine.js';

/** 造一个临时数据目录。 */
function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-recovery-'));
}

/** 快照目录下所有文件名（排序后便于断言）。 */
function runFiles(dir) {
    try {
        return fs.readdirSync(path.join(dir, 'runs')).sort();
    }
    catch {
        return [];
    }
}

/** 一轮最小运行记录。 */
function makeRun(overrides = {}) {
    return {
        id: 'R-1',
        goal: '改点东西',
        sessionId: 'session-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: 'waiting-review',
        policy: { concurrency: 2, timeoutSeconds: 900, maxRework: 1, maxDepth: 1, provider: 'spawn', teamMode: false },
        orders: [
            {
                id: 'W1',
                title: '一',
                task: '做甲',
                contractorName: '力工',
                route: 'p/m',
                status: 'done',
                text: '做完了',
                member: { id: 'a', name: '力工', prompt: '只改前端，别动后端', provider: 'p', model: 'm' },
            },
        ],
        ...overrides,
    };
}

/** 假宿主：任何一次 `get('subagents')` 都算失败——恢复不该要服务。 */
function makeEngine(store) {
    const calls = [];
    const ctx = {
        get(service) {
            calls.push(service);
            throw new Error(`恢复路径不该向宿主取服务：${service}`);
        },
    };
    const engine = new ForemanEngine({ ctx, store, logger: { info() {}, warn() {}, error() {} } });
    return { engine, calls };
}

test('saveRunSnapshot：往返保存，剪掉不可序列化字段与密钥', () => {
    const dir = tempDir();
    const store = new ForemanStore(dir);
    const run = makeRun();
    // 宿主对象、函数、循环引用都不该进快照
    run.parent = { session: { id: 'parent' } };
    run.ctx = { get: () => undefined };
    run.signal = new AbortController().signal;
    run.touch = () => {};
    run.self = run;
    run.apiKey = 'sk-live-abcdefghijklmnop';
    run.orders[0].nested = { token: 'secret-value', note: '保留' };

    assert.equal(store.saveRunSnapshot(run), true);

    const files = runFiles(dir);
    assert.deepEqual(files, ['R-1.json'], '只允许 .json 快照，不留临时文件');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'runs', 'R-1.json'), 'utf8'));
    assert.equal(saved.id, 'R-1');
    assert.equal(saved.sessionId, 'session-1');
    assert.equal(saved.orders[0].status, 'done');
    assert.equal(saved.orders[0].text, '做完了');
    assert.equal(saved.orders[0].member.prompt, '只改前端，别动后端', '承包商提示词属于本机数据目录，保留');
    assert.equal(saved.orders[0].nested.note, '保留');
    assert.equal(typeof saved.savedAt, 'string');
    for (const key of ['parent', 'ctx', 'signal', 'touch', 'self', 'apiKey'])
        assert.equal(key in saved, false, `${key} 不该被写进快照`);
    assert.equal('token' in saved.orders[0].nested, false, '疑似密钥的字段整条跳过');
    assert.doesNotMatch(JSON.stringify(saved), /sk-live/, '密钥片段不该落盘');

    const loaded = store.loadRunSnapshots();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'R-1');
    assert.equal(loaded[0].orders[0].member.prompt, '只改前端，别动后端');
});

test('saveRunSnapshot：写不进去时返回 false，不抛', () => {
    const dir = tempDir();
    const store = new ForemanStore(dir);
    // 把 runs 目录的位置先占成一个普通文件，mkdir 与写入必然失败
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'runs'), 'not a directory', 'utf8');
    assert.equal(store.saveRunSnapshot(makeRun()), false);
    assert.equal(store.saveRunSnapshot(null), false);
    assert.equal(store.saveRunSnapshot('R-1'), false);
    assert.equal(store.saveRunSnapshot({ id: 'R-1' }), false, '没有工单数组的记录不写');
});

test('runId 必须 sanitize：路径穿越一律拒绝', () => {
    assert.equal(sanitizeRunId('R-1a2b'), 'R-1a2b');
    assert.equal(sanitizeRunId('R-1_ok.2'), 'R-1_ok.2');
    assert.equal(sanitizeRunId('  R-9  '), 'R-9');
    assert.equal(sanitizeRunId('..'), '');
    assert.equal(sanitizeRunId('.'), '');
    assert.equal(sanitizeRunId('../../evil'), '');
    assert.equal(sanitizeRunId('a/b'), '');
    assert.equal(sanitizeRunId('a\\b'), '');
    assert.equal(sanitizeRunId(''), '');
    assert.equal(sanitizeRunId(42), '');

    const dir = tempDir();
    const store = new ForemanStore(dir);
    for (const id of ['../../evil', '..', 'a/b', 'C:\\Windows\\evil', 'R-1\u0000']) {
        assert.equal(store.saveRunSnapshot(makeRun({ id })), false, `${id} 必须被拒`);
    }
    assert.deepEqual(runFiles(dir), []);
    assert.equal(fs.existsSync(path.join(dir, '..', 'evil.json')), false);
    assert.equal(store.loadRunSnapshots().length, 0);
});

test('loadRunSnapshots：单条损坏跳过，其余照读，按时间新在前', () => {
    const dir = tempDir();
    const store = new ForemanStore(dir);
    const runsDir = path.join(dir, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'broken.json'), '{ this is not json', 'utf8');
    fs.writeFileSync(path.join(runsDir, 'empty.json'), '', 'utf8');
    fs.writeFileSync(path.join(runsDir, 'array.json'), '[1,2,3]', 'utf8');
    fs.writeFileSync(path.join(runsDir, 'no-orders.json'), JSON.stringify({ id: 'no-orders', sessionId: 's' }), 'utf8');
    fs.writeFileSync(path.join(runsDir, 'notes.txt'), 'ignore me', 'utf8');
    assert.equal(store.loadRunSnapshots().length, 0, '坏文件全跳过，不抛');

    assert.equal(store.saveRunSnapshot(makeRun({ id: 'R-old', createdAt: '2026-01-01T00:00:00.000Z' })), true);
    assert.equal(store.saveRunSnapshot(makeRun({ id: 'R-new', createdAt: '2026-03-01T00:00:00.000Z' })), true);
    const loaded = store.loadRunSnapshots();
    assert.deepEqual(loaded.map(run => run.id), ['R-new', 'R-old']);
    assert.equal(store.loadRunSnapshots(1).length, 1, 'limit 生效');
});

test('loadRunSnapshots：同一 runId 以较新的 updatedAt/finishedAt 覆盖', () => {
    const dir = tempDir();
    const store = new ForemanStore(dir);
    const runsDir = path.join(dir, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const older = makeRun({
        id: 'R-dup',
        orderCount: 1,
        updatedAt: '2026-02-01T00:00:00.000Z',
        orders: [{ id: 'W1', title: '旧', task: 'x', status: 'running' }],
    });
    const newer = makeRun({
        id: 'R-dup',
        updatedAt: '2026-05-01T00:00:00.000Z',
        orders: [{ id: 'W1', title: '新', task: 'x', status: 'done', text: '新版' }],
    });
    // 模拟手工拷贝/备份留在目录里的同名副本：文件名不同，内容里的 runId 相同
    fs.writeFileSync(path.join(runsDir, 'R-dup.json'), JSON.stringify(newer), 'utf8');
    fs.writeFileSync(path.join(runsDir, 'R-dup.backup.json'), JSON.stringify(older), 'utf8');

    const loaded = store.loadRunSnapshots();
    assert.equal(loaded.length, 1, '同一个 runId 只留一条');
    assert.equal(loaded[0].id, 'R-dup');
    assert.equal(loaded[0].orders[0].title, '新', '较新的那份胜出，与文件名无关');
    assert.equal(loaded[0].updatedAt, '2026-05-01T00:00:00.000Z');

    // 反过来写：旧的那份内容更新时也该它胜出（依据是时间戳，不是文件名顺序）
    const fresher = { ...older, updatedAt: '2026-09-01T00:00:00.000Z', orders: [{ id: 'W1', title: '更新', task: 'x', status: 'done' }] };
    fs.writeFileSync(path.join(runsDir, 'R-dup.backup.json'), JSON.stringify(fresher), 'utf8');
    assert.equal(store.loadRunSnapshots()[0].orders[0].title, '更新');
});

test('恢复：已结案的快照原样可读，不启动任何子智能体', () => {
    const dir = tempDir();
    const store = new ForemanStore(dir);
    assert.equal(store.saveRunSnapshot(makeRun({
        id: 'R-settled',
        sessionId: 'session-1',
        updatedAt: '2026-04-01T00:00:00.000Z',
        orders: [
            { id: 'W1', title: '成功', task: 'x', status: 'done', text: '交付正文', verdict: 'pass' },
            { id: 'W2', title: '失败', task: 'y', status: 'failed', error: '激活失败', stopReason: 'error' },
        ],
    })), true);
    const { engine, calls } = makeEngine(store);

    const run = engine.requireRun('R-settled', 'session-1');
    assert.equal(run.id, 'R-settled');
    assert.equal(run.status, 'waiting-review');
    assert.equal(run.recovered, true);
    assert.equal(run.orders[0].status, 'done');
    assert.equal(run.orders[0].text, '交付正文');
    assert.equal(run.orders[0].error, undefined, '已完成的结果保留原样');
    assert.equal(run.orders[1].status, 'failed');
    assert.equal(run.orders[1].error, '激活失败', '失败原因不被恢复逻辑覆盖');
    assert.deepEqual(calls, [], '恢复过程不该碰 ctx.get');
    // 恢复后的记录放进内存看板，下一次取到的就是同一份
    assert.equal(engine.runs.get('R-settled'), run);
    assert.match(engine.renderBoard(run), /W1 成功/);
});

test('恢复：running/rework 的快照改成 waiting-review，未完成工单标 failed', () => {
    const dir = tempDir();
    const store = new ForemanStore(dir);
    assert.equal(store.saveRunSnapshot(makeRun({
        id: 'R-live',
        sessionId: 'session-1',
        status: 'running',
        updatedAt: '2026-04-02T00:00:00.000Z',
        orders: [
            { id: 'W1', title: '做完了', task: 'x', status: 'done', text: 'ok' },
            { id: 'W2', title: '跑到一半', task: 'y', status: 'running', childId: 'child-1' },
            { id: 'W3', title: '还在排队', task: 'z', status: 'queued' },
            { id: 'W4', title: '被打回', task: 'w', status: 'done', verdict: 'fail' },
        ],
    })), true);
    assert.equal(store.saveRunSnapshot(makeRun({
        id: 'R-rework',
        sessionId: 'session-1',
        status: 'rework',
        orders: [{ id: 'W1', title: '返工中', task: 'x', status: 'running' }],
    })), true);
    const { engine, calls } = makeEngine(store);

    const run = engine.requireRun('R-live', 'session-1');
    assert.equal(run.status, 'waiting-review', 'running 不该继续显示为进行中');
    assert.equal(run.interrupted, true);
    assert.equal(run.recovered, true);
    assert.deepEqual(run.orders.map(order => order.status), ['done', 'failed', 'failed', 'done']);
    assert.equal(run.orders[0].text, 'ok', '已交付的不动');
    assert.equal(run.orders[1].error, '插件重启导致中断，未自动重跑');
    assert.equal(run.orders[2].error, '插件重启导致中断，未自动重跑');
    assert.equal(run.orders[1].stopReason, 'aborted');
    assert.equal(run.orders[3].verdict, 'fail', '验收结论保留');

    const rework = engine.requireRun('R-rework', 'session-1');
    assert.equal(rework.status, 'waiting-review');
    assert.equal(rework.orders[0].status, 'failed');
    assert.equal(rework.orders[0].error, '插件重启导致中断，未自动重跑');

    const board = engine.renderBoard(run);
    assert.match(board, /W2 跑到一半/);
    assert.match(board, /中断/);
    assert.doesNotMatch(board, /进行中/);
    assert.deepEqual(calls, [], '恢复不该启动子智能体，也不该取服务');
});

test('恢复：显式 runId 必须对得上会话，否则 UNKNOWN_RUN', () => {
    const dir = tempDir();
    const store = new ForemanStore(dir);
    assert.equal(store.saveRunSnapshot(makeRun({ id: 'R-owned', sessionId: 'session-a' })), true);
    const { engine, calls } = makeEngine(store);

    let error;
    try {
        engine.requireRun('R-owned', 'session-b');
    }
    catch (caught) {
        error = caught;
    }
    assert.ok(error instanceof ForemanError);
    assert.equal(error.code, 'UNKNOWN_RUN');
    // 拿到过的那份进内存后同样要校验：不能靠"先读一次"绕过归属
    const owned = engine.requireRun('R-owned', 'session-a');
    assert.equal(owned.id, 'R-owned');
    error = undefined;
    try {
        engine.requireRun('R-owned', 'session-b');
    }
    catch (caught) {
        error = caught;
    }
    assert.ok(error instanceof ForemanError);
    assert.equal(error.code, 'UNKNOWN_RUN');

    // 完全找不到 / 非法 id / 空会话也都是 UNKNOWN_RUN
    assert.throws(() => engine.requireRun('R-nope', 'session-a'), (caught) => caught.code === 'UNKNOWN_RUN');
    assert.throws(() => engine.requireRun('../../etc/passwd', 'session-a'), (caught) => caught.code === 'UNKNOWN_RUN');
    assert.throws(() => engine.requireRun('R-owned', ''), (caught) => caught.code === 'UNKNOWN_RUN', '空会话不许读别人的快照');
    assert.throws(() => engine.requireRun('R-owned'), (caught) => caught.code === 'UNKNOWN_RUN');
    assert.deepEqual(calls, []);
});

test('恢复：省略 runId 只取本会话最新，空会话不串读', () => {
    const dir = tempDir();
    const store = new ForemanStore(dir);
    assert.equal(store.saveRunSnapshot(makeRun({
        id: 'R-a1',
        sessionId: 'session-a',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    })), true);
    assert.equal(store.saveRunSnapshot(makeRun({
        id: 'R-a2',
        sessionId: 'session-a',
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-02-01T00:00:00.000Z',
    })), true);
    assert.equal(store.saveRunSnapshot(makeRun({
        id: 'R-b1',
        sessionId: 'session-b',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
    })), true);
    const { engine, calls } = makeEngine(store);

    assert.equal(engine.requireRun('', 'session-a').id, 'R-a2', '取本会话最新的那轮');
    assert.equal(engine.requireRun(undefined, 'session-a').id, 'R-a2');
    assert.equal(engine.requireRun('  ', 'session-b').id, 'R-b1');
    assert.throws(() => engine.requireRun('', 'session-c'), (caught) => caught.code === 'NO_RUN');
    // 空会话不许退化成"随便给一个"
    assert.throws(() => engine.requireRun('', ''), (caught) => caught.code === 'NO_RUN');
    assert.throws(() => engine.requireRun('', undefined), (caught) => caught.code === 'NO_RUN');

    // 设置页/诊断路径允许全局最新
    assert.equal(engine.latestRun('session-b').id, 'R-b1');
    assert.equal(engine.latestRun('').id, 'R-b1');
    assert.equal(engine.latestRun().id, 'R-b1', '省略会话 = 全局最新，仅供设置页/诊断');
    assert.equal(engine.latestRun('session-c'), undefined);
    assert.deepEqual(calls, []);
});

test('恢复：内存命中优先，且不重复读盘', () => {
    const dir = tempDir();
    const store = new ForemanStore(dir);
    assert.equal(store.saveRunSnapshot(makeRun({ id: 'R-mem', sessionId: 'session-1' })), true);
    let reads = 0;
    const counting = {
        saveRunSnapshot: (...args) => store.saveRunSnapshot(...args),
        loadRunSnapshots: (...args) => {
            reads += 1;
            return store.loadRunSnapshots(...args);
        },
    };
    const { engine } = makeEngine(counting);

    const first = engine.requireRun('R-mem', 'session-1');
    assert.equal(reads, 1);
    const second = engine.requireRun('R-mem', 'session-1');
    assert.equal(second, first, '同一份记录，不再读盘');
    assert.equal(reads, 1);
    assert.equal(engine.latestRun('session-1'), first);
});
