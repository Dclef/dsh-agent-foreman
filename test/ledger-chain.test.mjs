/**
 * 台账 SHA-256 哈希链：纯函数与真实 ForemanStore 的回归测试。
 *
 * 借鉴文渊阁 append-only ledger：每行带 prevHash / hash，verifyLedger 逐行
 * 重算校验；裁剪产生的 anchor: 断点是预期行为。测试只用纯函数与 os.tmpdir()
 * 临时文件，绝不写真实 %LOCALAPPDATA% 台账、不联网、不启宿主、不调用模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    ForemanStore, LEDGER_GENESIS, chainHash, verifyLedger,
} from '../lib/store.js';

/** 造一批键序故意打乱、带嵌套的记录，验证规范化与透传形状。 */
function sampleRecords() {
    return [
        { id: 'R-1', status: 'accepted', orders: [], at: '2026-01-01T00:00:00.000Z' },
        { orders: [{ title: '甲', attempts: 1 }], at: '2026-01-02T00:00:00.000Z', status: 'waiting-review', id: 'R-2' },
        { id: 'R-3', status: 'done', orders: [{ title: '乙', attempts: 2 }], at: '2026-01-03T00:00:00.000Z' },
    ];
}

/** 用 chainHash 把记录串成合法链，返回 JSONL 全文。 */
function buildLedger(records) {
    let prevHash = LEDGER_GENESIS;
    const lines = [];
    for (const record of records) {
        const hash = chainHash(prevHash, record);
        lines.push(JSON.stringify({ ...record, prevHash, hash }));
        prevHash = hash;
    }
    return `${lines.join('\n')}\n`;
}

/** 造一个隔离的临时目录，用完由调用方清理。 */
function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ledger-chain-'));
}

// ── 一、chainHash 纯函数 ────────────────────────────────────────────────────

test('chainHash：相同输入稳定、键序无关', () => {
    const a = { b: 2, a: 1 };
    const b = { a: 1, b: 2 };
    assert.equal(chainHash(LEDGER_GENESIS, a), chainHash(LEDGER_GENESIS, a), '同一输入必须稳定');
    assert.equal(chainHash(LEDGER_GENESIS, a), chainHash(LEDGER_GENESIS, b), '键名排序后应一致');
    assert.match(chainHash(LEDGER_GENESIS, a), /^[0-9a-f]{64}$/, '必须是 64 位小写 hex');
});

test('chainHash：不同 record / 不同 prevHash 都不同', () => {
    const base = chainHash(LEDGER_GENESIS, { id: 'R-1', n: 1 });
    assert.notEqual(base, chainHash(LEDGER_GENESIS, { id: 'R-1', n: 2 }), 'record 变了 hash 必须变');
    assert.notEqual(base, chainHash('a'.repeat(64), { id: 'R-1', n: 1 }), 'prevHash 变了 hash 必须变');
});

test('chainHash：record 自带 prevHash / hash 不参与计算', () => {
    const clean = { id: 'R-1', n: 1 };
    const dirty = { id: 'R-1', n: 1, prevHash: 'fake', hash: 'fake' };
    assert.equal(chainHash(LEDGER_GENESIS, clean), chainHash(LEDGER_GENESIS, dirty));
});

// ── 二、verifyLedger 纯函数 ─────────────────────────────────────────────────

test('verifyLedger：空文本 ok:true / count:0', () => {
    assert.deepEqual(verifyLedger(''), { ok: true, count: 0, brokenAt: null, reason: '' });
    assert.equal(verifyLedger('   \n\n  \n').ok, true, '纯空行应跳过');
    assert.equal(verifyLedger('   \n\n  \n').count, 0);
});

test('verifyLedger：合法链 ok:true 且 count 正确', () => {
    const records = sampleRecords();
    const result = verifyLedger(buildLedger(records));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.count, records.length);
    assert.equal(result.brokenAt, null);
});

test('verifyLedger：合法链里夹空行仍跳过', () => {
    const text = buildLedger(sampleRecords()).replace('\n', '\n\n');
    assert.equal(verifyLedger(text).ok, true);
});

test('verifyLedger：篡改中间行 record 后 ok=false 且 brokenAt 指向该行', () => {
    const records = sampleRecords();
    const lines = buildLedger(records).trim().split('\n');
    const tampered = JSON.parse(lines[1]);
    tampered.status = 'TAMPERED';
    lines[1] = JSON.stringify(tampered);
    const result = verifyLedger(lines.join('\n'));
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 2, '第 2 行（1-based）该被抓到');
    assert.equal(result.count, 1, '断点前已通过 1 行');
    assert.match(result.reason, /hash/i);
});

test('verifyLedger：prevHash 改成不匹配的值时 ok=false', () => {
    const records = sampleRecords();
    const lines = buildLedger(records).trim().split('\n');
    const broken = JSON.parse(lines[2]);
    broken.prevHash = 'b'.repeat(64);
    lines[2] = JSON.stringify(broken);
    const result = verifyLedger(lines.join('\n'));
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 3);
});

test('verifyLedger：anchor: 行自身 hash 正确时可接受', () => {
    const anchor = 'anchor:deadbeefdeadbeef';
    const records = [{ id: 'R-a', x: 1 }, { id: 'R-b', x: 2 }];
    const h0 = chainHash(anchor, records[0]);
    const h1 = chainHash(h0, records[1]);
    const lines = [
        JSON.stringify({ ...records[0], prevHash: anchor, hash: h0 }),
        JSON.stringify({ ...records[1], prevHash: h0, hash: h1 }),
    ];
    const result = verifyLedger(lines.join('\n'));
    assert.equal(result.ok, true, `锚点行应跳过前驱连续性校验：${result.reason}`);
    assert.equal(result.count, 2);
});

test('verifyLedger：anchor: 行自身 hash 错仍判不合法', () => {
    const anchor = 'anchor:deadbeefdeadbeef';
    const line = JSON.stringify({ id: 'R-a', x: 1, prevHash: anchor, hash: 'c'.repeat(64) });
    const result = verifyLedger(line);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 1);
});

test('verifyLedger：坏 JSON 行判不合法并写明解析失败', () => {
    const records = sampleRecords();
    const lines = buildLedger(records).trim().split('\n');
    lines.splice(1, 0, '{ this is not json');
    const result = verifyLedger(lines.join('\n'));
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 2);
    assert.match(result.reason, /解析失败/);
});

test('verifyLedger：缺 hash 字段的行判不合法', () => {
    const line = JSON.stringify({ id: 'R-1', prevHash: LEDGER_GENESIS });
    const result = verifyLedger(line);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 1);
});

// ── 三、真实 ForemanStore 连写 ───────────────────────────────────────────────

test('ForemanStore：连写 3 条后 runs.jsonl 全链可校验', () => {
    const dir = tempDir();
    try {
        const store = new ForemanStore(dir);
        for (const record of sampleRecords())
            assert.equal(store.recordRun(record), true, '写入应成功');
        const text = fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8');
        const result = verifyLedger(text);
        assert.equal(result.ok, true, result.reason);
        assert.ok(result.count >= 3, `至少 3 行，实际 ${result.count}`);
        assert.equal(result.count, 3);
        const lines = text.trim().split('\n').map(line => JSON.parse(line));
        assert.equal(lines[0].prevHash, LEDGER_GENESIS, '首行前驱应是创世值');
        for (let i = 1; i < lines.length; i += 1)
            assert.equal(lines[i].prevHash, lines[i - 1].hash, '每行前驱接上一行 hash');
        // recentRuns 透传 prevHash / hash，但原有字段形状不变、签名不变。
        const recent = store.recentRuns(3);
        assert.equal(recent.length, 3);
        assert.equal(recent[0].id, 'R-3', '仍是新在前');
        assert.equal(recent[0].status, 'done');
        assert.deepEqual(recent[0].orders, [{ title: '乙', attempts: 2 }]);
        assert.equal(typeof recent[0].prevHash, 'string');
        assert.equal(typeof recent[0].hash, 'string');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('ForemanStore：record 自带 prevHash / hash 会被剔除并重建', () => {
    const dir = tempDir();
    try {
        const store = new ForemanStore(dir);
        assert.equal(store.recordRun({ id: 'R-1', prevHash: 'evil', hash: 'evil' }), true);
        const lines = fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
        assert.equal(lines[0].prevHash, LEDGER_GENESIS);
        assert.notEqual(lines[0].hash, 'evil');
        assert.equal(verifyLedger(fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8')).ok, true);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('ForemanStore：写失败仍返回 false 且不影响后续派单语义', () => {
    const dir = tempDir();
    try {
        // 把 dataDir 指到一个普通文件上，mkdirSync / appendFileSync 必然失败。
        const blocker = path.join(dir, 'not-a-dir');
        fs.writeFileSync(blocker, 'x', 'utf8');
        const store = new ForemanStore(blocker);
        assert.equal(store.recordRun({ id: 'R-1' }), false, '写盘失败返回 false，不抛异常');
        assert.deepEqual(store.recentRuns(5), [], '读不到也不抛');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('ForemanStore：末行无 hash 的旧台账之后追加，链从创世值重新起步仍可校验', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'runs.jsonl');
        fs.writeFileSync(file, `${JSON.stringify({ id: 'legacy', status: 'done' })}\n`, 'utf8');
        const store = new ForemanStore(dir);
        assert.equal(store.recordRun({ id: 'R-new' }), true);
        const text = fs.readFileSync(file, 'utf8');
        // 旧行不带哈希链，verifyLedger 会把第一行判为断点；这正是「兼容旧数据」的
        // 边界：新行自身从创世值起步，单独抽出来必须完整可校验。
        const fresh = text.trim().split('\n').slice(1).join('\n');
        const result = verifyLedger(fresh);
        assert.equal(result.ok, true, result.reason);
        assert.equal(result.count, 1);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── 四、#trimLedger 原子裁剪与 anchor ────────────────────────────────────────

test('ForemanStore：超阈值裁剪后保留段首行带 anchor 且链内自洽', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'runs.jsonl');
        // 直接构造一条 401 行、每行 >1.3KB 的合法链（超 LEDGER_LIMIT 且超 512KB）。
        const records = Array.from({ length: 401 }, (_, i) => ({
            id: `R-${i}`, status: 'done', padding: 'x'.repeat(1400),
        }));
        fs.writeFileSync(file, buildLedger(records), 'utf8');
        assert.ok(fs.statSync(file).size > 512 * 1024, '必须触发裁剪阈值');
        const store = new ForemanStore(dir);
        assert.equal(store.recordRun({ id: 'R-trigger' }), true, '追加触发 #trimLedger');
        const text = fs.readFileSync(file, 'utf8');
        const result = verifyLedger(text);
        assert.equal(result.ok, true, `裁剪后保留段必须自洽：${result.reason}`);
        assert.equal(result.count, 400, '保留 LEDGER_LIMIT 条');
        const first = JSON.parse(text.trim().split('\n')[0]);
        assert.match(first.prevHash, /^anchor:/, '首行前驱应是 anchor 断点');
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

