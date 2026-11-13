/**
 * 实时工地看板：/api/live 的新字段与设置页的新区块。
 *
 * 这里不起 HTTP，也不加载宿主：手工造 `mountRoutes` 需要的最小 store/engine，
 * 直接把路由 handler 当普通函数调用。这样能锁住字段契约（尤其是防御式读取
 * `actualRoute` / `routeMismatch` / `routeNote`），又不依赖别的工单先落盘。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mountRoutes, ROUTE_PREFIX } from '../lib/routes.js';
import { renderPage } from '../lib/page.js';

/** 手工造一轮运行记录；刻意带上看板要展示的全部字段。 */
function sampleRun() {
    return {
        id: 'R-live',
        sessionId: 'session-1',
        goal: '把看板做出来',
        status: 'waiting-review',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:05:00.000Z',
        recovered: true,
        interrupted: true,
        orders: [
            {
                id: 'W0',
                title: '打底',
                contractorName: '力工',
                status: 'done',
                verdict: 'pass',
                durationMs: 1200,
                dependsOn: [],
                error: '',
                artifactPath: 'w0.md',
                actualRoute: 'deepseek-official/deepseek-flash',
                routeMismatch: false,
                routeNote: '',
            },
            {
                id: 'W1',
                title: '接线',
                contractorName: '力工',
                status: 'skipped',
                dependsOn: ['W0'],
                error: '依赖 W0 未完成',
                artifactPath: 'x.md',
                actualRoute: 'trae/m1',
                routeMismatch: true,
                routeNote: '宿主拒绝了 selectModel',
                updatedAt: '2026-01-01T00:06:00.000Z',
            },
        ],
    };
}

/** 造一个最小的 store：只实现路由用到的那几个方法。 */
function fakeStore() {
    const members = [
        { id: 'a', name: '力工', role: '力工', specialty: '', provider: 'p', model: 'm', maxParallel: 1, enabled: true },
        { id: 'b', name: '小工', role: '小工', specialty: '', provider: '', model: '', maxParallel: 1, enabled: true },
    ];
    const policy = { concurrency: 2, timeoutSeconds: 60, maxRework: 1, maxDepth: 0, provider: 'spawn', teamMode: false };
    return {
        members: () => members.map(member => ({ ...member })),
        policy: () => ({ ...policy }),
        snapshot: () => ({ members: members.map(member => ({ ...member })), policy: { ...policy } }),
        recentRuns: () => [{ id: 'R-live', at: '2026-01-01T00:00:00.000Z', goal: '把看板做出来', status: 'waiting-review', orders: [] }],
    };
}

/** 造一个最小 engine：`latestRun('')` 给全局最近一轮。 */
function fakeEngine() {
    const run = sampleRun();
    return {
        latestRun: (sessionId) => (sessionId === 'session-1' || sessionId === '' ? run : undefined),
    };
}

/** 挂上路由，返回 `路径 → handler` 的表。显式传 `engine: undefined` 表示"引擎没有该能力"。 */
function mountFake(options = {}) {
    const store = options.store ?? fakeStore();
    const engine = 'engine' in options ? options.engine : fakeEngine();
    const routes = new Map();
    const ctx = {
        logger: { info() {}, warn() {}, error() {} },
        get(name) {
            if (name === 'webServer')
                return { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } };
            return undefined;
        },
    };
    const release = mountRoutes(ctx, { store, engine, logger: ctx.logger });
    return { routes, release };
}

/** 造一个响应对象。 */
function makeRes() {
    return {
        statusCode: 0,
        headers: {},
        writableEnded: false,
        body: '',
        setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
        end(text) {
            if (text !== undefined)
                this.body += String(text);
            this.writableEnded = true;
        },
    };
}

/** 造一个请求对象（环回 Host，过得了本地跨站门卫）。 */
function makeReq(url = '/') {
    return { method: 'GET', url, headers: { host: '127.0.0.1:12497' } };
}

/** 调一条路由并把响应体解成 JSON。 */
async function callJson(routes, path, url = path) {
    const route = routes.get(path);
    assert.ok(route !== undefined, `路由 ${path} 应当已注册`);
    const res = makeRes();
    await route.handler(makeReq(url), res);
    assert.equal(res.statusCode, 200);
    return JSON.parse(res.body);
}

test('/api/live：run 带 updatedAt / recovered / interrupted', async () => {
    const { routes } = mountFake();
    const body = await callJson(routes, `${ROUTE_PREFIX}/api/live`, `${ROUTE_PREFIX}/api/live?session=session-1`);
    assert.equal(body.ok, true);
    assert.equal(body.run.id, 'R-live');
    assert.equal(body.run.matched, true);
    assert.equal(body.run.updatedAt, '2026-01-01T00:05:00.000Z');
    assert.equal(body.run.recovered, true);
    assert.equal(body.run.interrupted, true);
    // 原有字段不能被挤掉
    assert.equal(body.lead.name, '包工头');
    assert.equal(body.run.goal, '把看板做出来');
    assert.equal(body.run.status, 'waiting-review');
});

test('/api/live：orders 的依赖/错误/产物/真实路由都在，dependsOn 一定是数组', async () => {
    const { routes } = mountFake();
    const body = await callJson(routes, `${ROUTE_PREFIX}/api/live`, `${ROUTE_PREFIX}/api/live?session=session-1`);
    assert.equal(body.run.orders.length, 2);

    const [first, second] = body.run.orders;
    assert.deepEqual(first.dependsOn, []);
    assert.equal(first.artifactPath, 'w0.md');
    assert.equal(first.routeMismatch, false);

    assert.equal(second.status, 'skipped');
    assert.deepEqual(second.dependsOn, ['W0']);
    assert.equal(second.error, '依赖 W0 未完成');
    assert.equal(second.artifactPath, 'x.md');
    assert.equal(second.actualRoute, 'trae/m1');
    assert.equal(second.routeMismatch, true);
    assert.equal(second.routeNote, '宿主拒绝了 selectModel');
    assert.equal(second.durationMs, 0, '缺 durationMs 时补 0，页面才不会算出 NaN');
});

test('/api/live：members 带 actualModel，取自该成员最近一单', async () => {
    const { routes } = mountFake();
    const body = await callJson(routes, `${ROUTE_PREFIX}/api/live`, `${ROUTE_PREFIX}/api/live?session=session-1`);
    const worker = body.members.find(member => member.name === '力工');
    const helper = body.members.find(member => member.name === '小工');
    // W1 的 updatedAt 更晚，所以力工的真实模型是 W1 的 trae/m1
    assert.equal(worker.actualModel, 'trae/m1');
    assert.equal(worker.model, 'p/m');
    assert.equal(worker.orders, 2);
    // 没跑过的成员给空串，不是 undefined
    assert.equal(helper.actualModel, '');
});

test('/api/live：会话对不上时仍退回全局最近一轮并标 matched:false', async () => {
    const { routes } = mountFake();
    const body = await callJson(routes, `${ROUTE_PREFIX}/api/live`, `${ROUTE_PREFIX}/api/live?session=other`);
    assert.equal(body.run.matched, false);
    assert.equal(body.run.id, 'R-live');
    assert.equal(body.run.orders[1].actualRoute, 'trae/m1');
});

test('/api/live：没有 run 时 run 为 null，members 的 actualModel 仍是空串', async () => {
    const { routes } = mountFake({ engine: { latestRun: () => undefined } });
    const body = await callJson(routes, `${ROUTE_PREFIX}/api/live`, `${ROUTE_PREFIX}/api/live?session=none`);
    assert.equal(body.run, null);
    assert.equal(body.members.length, 2);
    assert.equal(body.members[0].actualModel, '');
});

test('/api/live：engine 缺 latestRun 时不炸', async () => {
    const { routes } = mountFake({ engine: {} });
    const body = await callJson(routes, `${ROUTE_PREFIX}/api/live`, `${ROUTE_PREFIX}/api/live?session=session-1`);
    assert.equal(body.run, null);
    assert.equal(body.ok, true);
});

test('/api/state：带上 latestRunId', async () => {
    const { routes } = mountFake();
    const body = await callJson(routes, `${ROUTE_PREFIX}/api/state`);
    assert.equal(body.ok, true);
    assert.equal(body.latestRunId, 'R-live');
    assert.equal(body.runs.length, 1);
    assert.equal(body.members.length, 2);
});

test('/api/state：engine 没有 latestRun 能力时 latestRunId 为空串', async () => {
    const { routes } = mountFake({ engine: undefined });
    const body = await callJson(routes, `${ROUTE_PREFIX}/api/state`);
    assert.equal(body.latestRunId, '');
    assert.equal(body.ok, true);
});

test('/api/state 与 /api/live 返回内存中加载的原生编队构建标识', async () => {
    const { routes } = mountFake();
    for (const endpoint of ['/api/state', '/api/live']) {
        const body = await callJson(routes, ROUTE_PREFIX + endpoint);
        assert.equal(body.runtime.execution, 'native-roster');
        assert.equal(body.runtime.build, 'native-team-v5-20261113');
        assert.ok(Number.isFinite(Date.parse(body.runtime.loadedAt)));
    }
});

test('page：含实时工地区块的关键文案', () => {
    const html = renderPage();
    assert.match(html, /实时工地/);
    assert.match(html, /真实 provider\/model/);
    assert.match(html, /声明 provider\/model/);
    assert.match(html, /⊘/);
    assert.match(html, /真实模型与名册不一致/);
    assert.match(html, /连接中断，重试中/);
    assert.match(html, /\/api\/live/);
    assert.match(html, /2500/);
    assert.match(html, /teamFallback/);
    assert.match(html, /team-status-hint/);
    assert.match(html, /启用智能体团队协作/);
    // 新区块要排在「最近派单」之前
    assert.ok(html.indexOf('实时工地') < html.indexOf('最近派单'), '实时工地应插在最近派单之前');
});

test('page：名册使用响应式分行布局，保留模型全名与可读并发输入', () => {
    const html = renderPage();
    assert.ok(html.includes('id="roster" class="roster-list"'));
    assert.ok(!html.includes('<tbody id="roster">'));
    assert.ok(html.includes("row.className = 'contractor'"));
    assert.ok(html.includes("field('并发', 'parallel', parallel)"));
    assert.ok(html.includes("control.setAttribute('aria-label', label)"));
    assert.ok(html.includes('min-width: 64px'));
    assert.ok(html.includes('contractor-route'));
    assert.ok(html.includes('编辑提示词'));
    assert.ok(html.includes("effortRequest"));
});

test('page：内联脚本能被 new Function 解析（防模板拼错）', () => {
    const html = renderPage();
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(match !== null, '页面里应当有内联脚本');
    assert.doesNotThrow(() => new Function(match[1]));
});

test('page：首屏之后开始轮询，页面隐藏时暂停', () => {
    const html = renderPage();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    assert.match(script, /document\.hidden/);
    assert.match(script, /visibilitychange/);
    assert.match(script, /setInterval\(liveTick, 2500\)/);
});
