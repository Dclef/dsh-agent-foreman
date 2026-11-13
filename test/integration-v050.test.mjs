/**
 * 0.5.0 全链路集成测试：真实插件装配（apply）→ 工具 → 引擎 → 路由 → 验收。
 *
 * 和 optimization.test.mjs（纯函数）不同，这里跑的是宿主实际会执行的那条线：
 * 工具定义注册、子智能体激活、HTTP 路由、看板渲染、逐单签收。
 * 用假宿主，不调用真实模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config, apply } from '../lib/index.js';

function createHost() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-v050-'));
    const tools = new Map();
    const routes = new Map();
    const activations = [];
    const subagents = {
        providers: new Map([['spawn', { name: 'spawn', capabilities: { agentOptions: true } }]]),
        async startActivation(spec) {
            activations.push(spec);
            return {
                childId: 'child-' + activations.length,
                result: Promise.resolve({ output: [{ type: 'text', text: '交付摘要：做完了' }], stopReason: 'completed' }),
                dispose: async () => {},
            };
        },
    };
    const ctx = {
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        get(service) {
            if (service === 'baseDir') return dataDir;
            if (service === 'tools') return { register: (d) => { tools.set(d.name, d); return () => tools.delete(d.name); } };
            if (service === 'webServer') return { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path); } };
            if (service === 'subagents') return subagents;
            if (service === 'llm') return { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => null };
            if (service === 'commands') return { register: () => () => {} };
            if (service === 'skills') return { register: () => () => {} };
            return undefined;
        },
        inject(_names, cb) { return cb(ctx); },
        effect(setup) { return setup(); },
    };
    // 关闭团队模式：本轮验的是普通子会话路径上的新字段，不掺原生编队桥。
    fs.writeFileSync(path.join(dataDir, 'roster.json'), JSON.stringify({
        members: [{ name: '力工', provider: 'p', model: 'm', maxParallel: 2, enabled: true }],
        policy: { teamMode: false },
    }));
    apply(ctx, { ...Config({}), dataDir });
    return { ctx, dataDir, tools, routes, activations };
}

const exec = () => ({ agent: { session: { id: 'session-1' } }, signal: new AbortController().signal });

function makeRes() {
    return {
        statusCode: 0, headers: {}, writableEnded: false, body: '',
        setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
        end(t) { if (t !== undefined) this.body += String(t); this.writableEnded = true; },
    };
}
async function call(host, url) {
    const route = host.routes.get(url.split('?')[0]);
    assert.ok(route, '路由不存在：' + url);
    const res = makeRes();
    const req = {
        method: 'GET', url, headers: { host: '127.0.0.1:12497' },
        on() { return req; }, destroy() {},
    };
    await route.handler(req, res);
    return JSON.parse(res.body);
}

test('全链路：writeScopes/checklist 从工单进到子智能体提示词、看板与 /api/live', async () => {
    const host = createHost();
    const dispatch = host.tools.get('foreman_dispatch');
    assert.ok(dispatch, 'foreman_dispatch 必须已注册');

    const result = await dispatch.execute({
        goal: '验证 0.5.0 新字段',
        orders: [
            {
                id: 'W1', title: '改前端', task: '把按钮改圆',
                accept: 'npm test 通过',
                writeScopes: ['./src/ui/', 'src/ui/button.jsx'],
                checklist: ['按钮为圆形', 'npm test 通过'],
            },
            {
                id: 'W2', title: '改文档', task: '补一句说明',
                writeScopes: ['docs'], checklist: ['英文 README 有这段'],
            },
        ],
    }, exec());

    assert.equal(result.ok, true);
    assert.equal(result.orders.length, 2);
    // 工具返回的结构化行里带上新字段
    // 'src/ui/' 与 'src/ui/button.jsx' 是不同字符串，只去 ./ 与去重，不做前缀合并。
    assert.deepEqual(result.orders[0].writeScopes, ['src/ui', 'src/ui/button.jsx']);
    assert.deepEqual(result.orders[0].checklist, ['按钮为圆形', 'npm test 通过']);
    assert.equal(result.orders[0].reviewedBy, '');

    // 子智能体真的收到了范围与清单（去 ./、去重）
    const prompt = host.activations[0].request.prompt[0].text;
    assert.ok(prompt.includes('【写入范围（仅提示，不是文件锁）】src/ui'));
    assert.ok(prompt.includes('【验收清单（父智能体逐项核对，做的人不自己签收）】'));
    assert.ok(prompt.includes('按钮为圆形'));

    // 看板把清单摆给父智能体
    assert.ok(result.summary.includes('验收清单（做的人不自己签收'));
    assert.ok(result.summary.includes('W1：按钮为圆形'));

    // /api/live 透出新字段
    const live = await call(host, '/plugins/dsh-agent-foreman/api/live?session=session-1');
    assert.equal(live.ok, true);
    const w1 = live.run.orders.find(o => o.id === 'W1');
    assert.deepEqual(w1.writeScopes, ['src/ui', 'src/ui/button.jsx']);
    assert.deepEqual(w1.checklist, ['按钮为圆形', 'npm test 通过']);
    assert.equal(w1.reviewedBy, '');

    // fail 无 feedback 被拒；带 feedback 也不该凭空通过
    const review = host.tools.get('foreman_review');
    await assert.rejects(
        () => review.execute({ runId: result.runId, verdicts: [{ order: 'W1', verdict: 'fail' }] }, exec()),
        /打回时必须写清 feedback/,
    );

    // 独立签收：pass 后 reviewedBy=foreman，且 /api/live 能看到
    const signed = await review.execute({
        runId: result.runId,
        verdicts: [
            { order: 'W1', verdict: 'pass' },
            { order: 'W2', verdict: 'pass' },
        ],
    }, exec());
    assert.equal(signed.status, 'accepted');
    assert.equal(signed.orders[0].reviewedBy, 'foreman', '签收方必须是父智能体');
    const live2 = await call(host, '/plugins/dsh-agent-foreman/api/live?session=session-1');
    assert.equal(live2.run.orders.find(o => o.id === 'W1').reviewedBy, 'foreman');
});

test('全链路：并行工单写入范围重叠时看板挂软警告，但不阻止派单', async () => {
    const host = createHost();
    const result = await host.tools.get('foreman_dispatch').execute({
        orders: [
            { id: 'W1', title: '甲', task: '甲', writeScopes: ['lib'] },
            { id: 'W2', title: '乙', task: '乙', writeScopes: ['lib/core.js'] },
        ],
    }, exec());
    assert.equal(result.ok, true, '重叠只是提示，两张单都要派出去');
    assert.equal(result.orders.length, 2);
    assert.ok(result.summary.includes('写入范围重叠（仅提示'));
    assert.ok(result.summary.includes('W1 ↔ W2：lib'));
});
