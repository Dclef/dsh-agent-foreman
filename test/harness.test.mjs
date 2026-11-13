/**
 * 端到端测试：用假的宿主跑真实的插件半边。
 *
 * 这个文件的价值在于"不重启 DSH 也能证明接线是对的"：它按宿主契约实现
 * `ctx.get` / `ctx.inject` / `ctx.effect` / `tools.register` / `webServer.register`，
 * 再让 `startActivation` 返回一个立刻落定的假激活。于是工具、引擎、路由、名册
 * 这些真实代码都会被跑到——包括跨站防护和错误翻译。
 */
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Config, apply, inject, name } from '../lib/index.js';

/** 造一个隔离的宿主。 */
function createHost({ members = [], text = '交付摘要：做完了', stopReason = 'completed', hang = false, hold = false, commands = true, team = false, teamText = '团队交付：改完了', teamMembers = [] } = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-host-'));
    const tools = new Map();
    const routes = new Map();
    const activations = [];
    const effects = [];

    /** 同时在场的子智能体峰值；`hold` 模式下用来验证单实例并发上限。 */
    let running = 0;
    let maxConcurrent = 0;
    const pending = [];
    const subagents = {
        providers: new Map([['spawn', { name: 'spawn', capabilities: { agentOptions: true } }]]),
        async startActivation(spec) {
            activations.push(spec);
            const childId = `child-${activations.length}`;
            running += 1;
            maxConcurrent = Math.max(maxConcurrent, running);
            const settle = () => {
                running -= 1;
                return { output: [{ type: 'text', text }], stopReason };
            };
            let result;
            if (hang)
                result = new Promise(() => {});
            else if (hold)
                result = new Promise(resolve => { pending.push(() => resolve(settle())); });
            else
                result = Promise.resolve().then(settle);
            return { childId, result, dispose: async () => {} };
        },
    };
    // 团队模式的假服务：spawnTeammate / sendMessage / selectModel / agents.status
    const teamSpawned = [];
    const teamSent = [];
    const teamModels = [];
    const teamTasks = [];
    const teamSessions = new Map();
    const teamNames = new Map();
    const teamEvents = new Map();
    // 预置成员（上一轮留下的）在真宿主里是活的子会话，`agents.get()` 能给出
    // status 与 session。替身若只给状态不给会话，插件的 baseline 会读不到，
    // 从而误判"收不回产物"而放弃团队模式——那是替身失真，不是产品行为。
    for (const row of teamMembers)
        if (typeof row?.id === 'string' && !teamSessions.has(row.id)) {
            // 预置成员也有握手历史（上一轮就建好了），插件的 waitHandshakeDone
            // 靠 assistant 正文判断握手完成，缺了它会白等满窗口。
            teamEvents.set(row.id, [
                { type: 'user/message', data: { message: { content: [{ type: 'text', text: '待命。' }] } } },
                { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '待命。' }] } } },
            ]);
            teamSessions.set(row.id, { snapshotEvents: () => teamEvents.get(row.id) ?? [] });
            // sendMessage 靠 teamNames 把成员名映射到会话 id 才能往事件里写。
            // 预置成员没走 spawnTeammate，不补这层映射的话，sendMessage 写到
            // undefined 上，工单事件根本进不了会话——插件会一直等不到正文而挂死。
            if (typeof row?.name === 'string' && row.name !== '' && !teamNames.has(row.name))
                teamNames.set(row.name, row.id);
        }
    /** spawn 出来的成员行：真宿主的 listMembers 会带上它们，替身也必须带。 */
    const teamRoster = [...teamMembers];
    const agentStatus = new Map();
    // 预置成员（上一轮留下的）在真宿主里是"活着且不在 provisioning"的。
    // 替身若不给状态，插件的等 active 只能空等到超时——那是替身失真。
    for (const row of teamMembers)
        if (typeof row?.id === 'string' && row?.status !== 'provisioning' && row?.status !== 'failed')
            agentStatus.set(row.id, 'inactive');
    const agentTeams = team
        ? {
            async spawnTeammate(parent, options) {
                teamSpawned.push({ parent, options });
                const sessionId = `team-${teamSpawned.length}`;
                // 真宿主在 spawn 时会发一条握手（HANDSHAKE）prompt，成员回复一句。
                // 这两条事件必须有：插件的 waitHandshakeDone 会等握手的 assistant
                // 正文落地才继续（否则 baseline 会早于握手回复，把握手正文当产物回收）。
                teamEvents.set(sessionId, [
                    { type: 'user/message', data: { message: { content: [{ type: 'text', text: '待命。' }] } } },
                    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '待命。' }] } } },
                ]);
                const activation = await this.roster.ctx.subagents.startActivation({
                    delivery: 'parent', childId: sessionId, provider: options.provider,
                    request: { parent, prompt: options.prompt }, signal: options.signal,
                });
                const header = options.routeForTest ?? activations.at(-1)?.request?.agentOptions;
                teamSessions.set(sessionId, { header, snapshotEvents: () => teamEvents.get(sessionId) ?? [] });
                // 真宿主在 spawn 之后要等初始 prompt 被接受，成员才从 provisioning
                // 走到 active；这里直接给 active，等价于"握手已完成"。
                agentStatus.set(sessionId, 'inactive');
                teamNames.set(options.name, sessionId);
                // 关键：新成员必须出现在 listMembers 里，否则插件的"等成员 active
                // 再投递"只能空等到超时，然后退回普通模式——那是替身失真，不是产品行为。
                teamRoster.push({ id: sessionId, name: options.name, role: 'teammate', status: 'inactive', model: header?.model });
                return { member: { id: sessionId, name: options.name } };
            },
            listMembers(parent) {
                return [
                    { id: 'lead-1', name: 'lead', role: 'lead', status: 'idle' },
                    ...teamRoster.map(row => ({ ...row, status: agentStatus.get(row.id) ?? row.status })),
                ];
            },
            async createTask(parent, request) {
                teamTasks.push({ step: 'create', request });
                return { id: `task-${teamTasks.length}`, revision: 1 };
            },
            async updateTask(parent, request) {
                teamTasks.push({ step: request.action, request });
                return { id: request.taskId, revision: request.expectedRevision + 1 };
            },
            async sendMessage(parent, message) {
                teamSent.push({ parent, message });
                const target = teamNames.get(message.target) ?? message.target;
                if (target !== undefined)
                    agentStatus.set(target, 'running');
                teamEvents.get(target ?? message.target)?.push({
                    type: 'user/message',
                    data: { message: { content: message.content } },
                });
                setTimeout(() => {
                    teamEvents.get(target ?? message.target)?.push({
                        type: 'assistant/message',
                        data: { message: { content: [{ type: 'text', text: teamText }] } },
                    });
                    agentStatus.set(target ?? message.target, 'inactive');
                }, 5);
                return { messageId: 'm-1' };
            },
        }
        : undefined;
    if (agentTeams) agentTeams.roster = { ctx: { subagents }, async spawn() {} };
    // 真实宿主里活 agent 同时带 `session`：团队成员是子智能体会话，
    // `sessions.get` 查不到它，插件靠 agents 这条通道读事件与正文。
    // 少了这个字段，团队模式会误判"读不到会话"而退回普通模式。
    const agents = {
        get: id => (agentStatus.has(id)
            ? { status: agentStatus.get(id), session: teamSessions.get(id) }
            : undefined),
    };
    const sessions = {
        get: id => teamSessions.get(id),
    };
    // 宿主真正的切模型服务注册名是 sessionController（不是 sessions）。
    const sessionController = {
        selectModel: async (selection) => {
            teamModels.push(selection);
            return { selected: { provider: selection.provider, model: selection.model } };
        },
    };

    const registeredCommands = [];
    const steered = [];
    const commandService = commands === false ? undefined : {
        register: (definition) => {
            registeredCommands.push(definition);
            return () => {};
        },
    };
    const fakeAgent = {
        steer: (message) => { steered.push(message); },
    };
    const skills = [];
    const skillService = {
        register: (definition) => {
            skills.push(definition);
            return () => {};
        },
    };
    const sections = [];
    const systemPrompt = {
        getSectionOrder: (name) => (name === 'TOOL_SUBAGENT' ? 100 : 200),
        section: (definition) => {
            sections.push(definition);
            return () => {};
        },
    };
    const llm = {
        listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
        listModels: async (provider) => [{ provider, id: 'deepseek-flash', name: 'Flash' }],
        resolveModelInfo: async (provider, model) => ({
            provider,
            id: model,
            name: model,
            reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
        }),
    };

    const ctx = {
        logger: { info() {}, warn() {}, error() {} },
        // cordis 的 `inject(['x'])` 会把服务挂成 `ctx.x`，这里照做。
        systemPrompt,
        skills: skillService,
        get(service) {
            if (service === 'baseDir')
                return dataDir;
            if (service === 'tools')
                return { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } };
            if (service === 'webServer')
                return { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); } };
            if (service === 'subagents')
                return subagents;
            if (service === 'llm')
                return llm;
            if (service === 'systemPrompt')
                return systemPrompt;
            if (service === 'skills')
                return skillService;
            if (service === 'commands')
                return commandService;
            if (service === 'agentTeams')
                return agentTeams;
            if (service === 'agents')
                return agents;
            if (service === 'sessions')
                return sessions;
            if (service === 'sessionController')
                return sessionController;
            return undefined;
        },
        inject(_names, callback) {
            return callback(ctx);
        },
        effect(setup) {
            const dispose = setup();
            effects.push(dispose);
            return dispose;
        },
    };

    // Non-team tests explicitly exercise standalone mode; production defaults
    // remain teamMode:true and missing native services must not be hidden.
    fs.writeFileSync(path.join(dataDir, 'roster.json'), JSON.stringify({ members: [], policy: { teamMode: team, teamFallback: false } }));
    apply(ctx, { ...Config({}), dataDir, members });
    /** 放行所有挂起的假子智能体（`hold` 模式用）。 */
    const releaseAll = () => {
        while (pending.length > 0)
            pending.shift()();
    };
    return { ctx, dataDir, tools, routes, activations, effects, sections, skills, commands: registeredCommands, steered, fakeAgent, store: ctx, releaseAll, maxConcurrent: () => maxConcurrent, teamSpawned, teamSent, teamModels, teamTasks };
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

/** 造一个请求对象。 */
function makeReq({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
    const listeners = new Map();
    const request = {
        method,
        url,
        headers: { host: '127.0.0.1:12497', ...headers },
        on(event, callback) {
            const list = listeners.get(event) ?? [];
            list.push(callback);
            listeners.set(event, list);
            return request;
        },
        destroy() {},
    };
    setTimeout(() => {
        if (body !== '')
            for (const callback of listeners.get('data') ?? []) callback(Buffer.from(body));
        for (const callback of listeners.get('end') ?? []) callback();
    }, 0);
    return request;
}

/** 调一条路由。 */
async function call(host, routePath, options = {}) {
    const pathname = routePath.split('?')[0];
    const route = host.routes.get(pathname);
    assert.ok(route !== undefined, `路由不存在：${routePath}`);
    const res = makeRes();
    await route.handler(makeReq({ ...options, url: options.url ?? routePath }), res);
    return { status: res.statusCode, headers: res.headers, body: res.body };
}

/** 工具执行上下文。 */
function execOf(sessionId = 'session-1') {
    return { agent: { session: { id: sessionId } }, signal: new AbortController().signal };
}

test('插件导出契约：名字、必需服务、配置 schema', () => {
    assert.equal(name, 'dsh-agent-foreman');
    assert.deepEqual(inject, ['tools']);
    const config = Config({});
    assert.equal(config.dataDir, '');
    assert.deepEqual(config.members, []);
});

test('团队探针标记宿主团队开关能力', async () => {
    const host = createHost({ team: true });
    const result = await call(host, '/plugins/dsh-agent-foreman/api/state');
    const body = JSON.parse(result.body);
    assert.equal(body.teamProbe.ctx.switch, 'legacy-host');
});

test('挂载后注册五个工具与六条路由', () => {
    const host = createHost();
    // foreman_report 是承包商的主动上报通道（agent-teams 式自报），
    // 用于宿主读不到成员会话时回收产物。
    assert.deepEqual([...host.tools.keys()].sort(), ['foreman_dispatch', 'foreman_report', 'foreman_review', 'foreman_roster', 'foreman_status']);
    assert.ok(host.routes.has('/plugins/dsh-agent-foreman'));
    assert.ok(host.routes.has('/plugins/dsh-agent-foreman/api/state'));
    assert.ok(host.routes.has('/plugins/dsh-agent-foreman/api/catalog'));
    assert.ok(host.routes.has('/plugins/dsh-agent-foreman/api/members'));
    assert.ok(host.routes.has('/plugins/dsh-agent-foreman/api/policy'));
    assert.ok(host.routes.has('/plugins/dsh-agent-foreman/api/live'));
});

test('foreman_roster：空名册给出可执行的下一步', async () => {
    const host = createHost();
    const result = await host.tools.get('foreman_roster').execute({}, execOf());
    assert.equal(result.ok, true);
    assert.match(result.summary, /空/);
    assert.match(result.summary, /设置 → 包工头/);
});

test('foreman_roster：列出承包商与路由', async () => {
    const host = createHost({
        members: [
            { name: 'coder-a', provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
            { name: 'inherit', provider: '', model: '' },
        ],
    });
    const result = await host.tools.get('foreman_roster').execute({}, execOf());
    assert.match(result.summary, /coder-a — deepseek-official\/deepseek-flash · high/);
    assert.match(result.summary, /inherit — 继承父会话/);
    assert.equal(result.members.length, 2);
});

test('foreman_dispatch：两张工单都跑完，看板带产物与路由', async () => {
    const host = createHost({
        members: [{ name: 'coder-a', prompt: '只动前端代码目录，不许改后端。', provider: 'deepseek-official', model: 'deepseek-flash' }],
    });
    const dispatch = host.tools.get('foreman_dispatch');
    const result = await dispatch.execute({
        goal: '修首页',
        orders: [
            { id: 'W1', title: '改取整', task: '把 quota 取整改成四舍五入', accept: 'npm test 通过' },
            { id: 'W2', title: '补测试', task: '补一条回归测试' },
        ],
    }, execOf());

    assert.equal(result.ok, true);
    assert.equal(result.status, 'waiting-review');
    assert.equal(host.activations.length, 2);
    // 承包商的路由真的套到了子智能体上
    assert.deepEqual(host.activations[0].request.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash' });
    assert.equal(host.activations[0].provider, 'spawn');
    assert.equal(host.activations[0].delivery, 'caller');
    assert.equal(host.activations[0].request.parent.session.id, 'session-1');
    // 提示词自足：带工单、验收标准
    assert.match(host.activations[0].request.prompt[0].text, /把 quota 取整改成四舍五入/);
    assert.match(host.activations[0].request.prompt[0].text, /npm test 通过/);
    // 承包商自己的提示词也塞进去了，且说明以工单为准
    assert.match(host.activations[0].request.prompt[0].text, /【你的提示词】[\s\S]*只动前端代码目录/);
    // 看板
    assert.match(result.summary, /包工头 · R-/);
    assert.match(result.summary, /W1 改取整/);
    assert.match(result.summary, /交付摘要：做完了/);
    assert.equal(result.orders.length, 2);
    assert.equal(result.orders[0].status, 'done');
});

test('团队兜底：宿主团队服务缺失时退回普通子会话并留下诊断', async () => {
    const host = createHost({ team: false, members: [{ name: 'fallback-worker', provider: 'deepseek-official', model: 'deepseek-flash' }] });
    const policy = await call(host, '/plugins/dsh-agent-foreman/api/policy', { method: 'POST', body: JSON.stringify({ teamMode: true, teamFallback: true }) });
    assert.equal(policy.status, 200);
    const result = await host.tools.get('foreman_dispatch').execute({ goal: '兜底', orders: [{ id: 'F1', title: '普通派单', task: '使用普通子会话完成', accept: '收到交付' }] }, execOf());
    assert.equal(result.ok, true);
    assert.equal(host.teamSpawned.length, 0);
    assert.equal(host.activations.length, 1);
    assert.match(result.orders[0].teamMode, /自动退回普通子会话/);
});

test('原生团队：创建真实队友并在首轮锁定模型，共享任务进团队面板', async () => {
    const host = createHost({
        team: true,
        teamText: '自建成员交付',
        members: [{ id: 'w1', name: '力工', prompt: '只动前端目录', provider: 'deepseek-official', model: 'deepseek-flash' }],
    });
    const policy = await call(host, '/plugins/dsh-agent-foreman/api/policy', {
        method: 'POST',
        body: JSON.stringify({ teamMode: true }),
    });
    assert.equal(policy.status, 200);

    const result = await host.tools.get('foreman_dispatch').execute({
        goal: '修关系图',
        orders: [{ id: 'W1', title: '连线', task: '把连线改成曲线', accept: '界面上能看见曲线' }],
    }, execOf());

    assert.equal(result.ok, true);
    // 自建成员走 startActivation（不再 spawnTeammate）。
    assert.equal(host.activations.length, 1, '应通过 startActivation 创建子智能体');
    assert.equal(host.teamSpawned.length, 1, '必须创建真实原生队友');
    // agentOptions 锁定模型。
    const opts = host.activations[0]?.request?.agentOptions;
    assert.ok(opts !== undefined, 'agentOptions 应注入');
    assert.equal(opts.provider, 'deepseek-official');
    assert.equal(opts.model, 'deepseek-flash');
    // 共享任务进团队面板。
    assert.deepEqual(host.teamTasks.map(entry => entry.step), ['create', 'reassign', 'complete']);
    assert.match(host.teamTasks[0].request.subject, /W1/);
    assert.match(result.orders[0].teamMode, /原生团队成员/);
    assert.equal(result.orders[0].actualRoute, 'deepseek-official/deepseek-flash');
    assert.equal(host.teamSpawned.length, 1);
    assert.equal(host.teamModels.length, 0, '不切换忙碌会话，也不修改全局默认模型');
    assert.equal(result.orders[0].status, 'done');
});

test('团队模式：宿主没有 agentTeams 时明确失败，不用普通激活冒充原生团队', async () => {
    const host = createHost({
        members: [{ name: '力工', provider: 'deepseek-official', model: 'deepseek-flash' }],
    });
    await call(host, '/plugins/dsh-agent-foreman/api/policy', {
        method: 'POST',
        body: JSON.stringify({ teamMode: true }),
    });

    const result = await host.tools.get('foreman_dispatch').execute({
        goal: '修关系图',
        orders: [{ id: 'W1', title: '连线', task: '把连线改成曲线' }],
    }, execOf());

    assert.equal(result.ok, true); // Tool call succeeded; the order failed visibly.
    assert.equal(host.activations.length, 0);
    assert.equal(result.orders[0].status, 'failed');
    assert.match(result.orders[0].error, /原生团队服务不可用/);
});

test('foreman_dispatch：承包商名字不在名册里时明确报错', async () => {
    const host = createHost({
        members: [
            { name: '力工-前端', provider: 'p1', model: 'm1' },
            { name: '力工-渲染', provider: 'p2', model: 'm2' },
        ],
    });
    const tool = host.tools.get('foreman_dispatch');
    let error;
    try {
        await tool.execute({ orders: [{ id: 'W1', title: '一', task: '甲', contractor: '不存在的名字' }] }, execOf());
    }
    catch (caught) {
        error = caught;
    }
    assert.ok(error, '应当抛错');
    // 报错里要把可选名字带出来，父模型下一轮才知道能填谁
    assert.match(String(error.message), /力工-前端/);
    assert.equal(host.activations.length, 0);
});

test('团队模式：中文承包商名统一落成 worker / worker-2', async () => {
    const host = createHost({
        team: true,
        teamText: '干完了',
        members: [
            { id: 'a', name: '力工', provider: 'deepseek-official', model: 'deepseek-flash' },
            { id: 'b', name: '力工2号', provider: 'deepseek-official', model: 'deepseek-flash' },
        ],
    });
    await call(host, '/plugins/dsh-agent-foreman/api/policy', {
        method: 'POST',
        body: JSON.stringify({ teamMode: true }),
    });
    await host.tools.get('foreman_dispatch').execute({
        goal: '两单并发',
        orders: [
            { id: 'X', title: '一', task: '甲', contractor: '力工' },
            { id: 'Y', title: '二', task: '乙', contractor: '力工2号' },
        ],
    }, execOf());
    // 自建成员：每个工单走 startActivation，各有自己的 agentOptions。
    assert.equal(host.activations.length, 2, '两单各创建一个子智能体');
    const routes = host.activations.map(a => `${a.request?.agentOptions?.provider}/${a.request?.agentOptions?.model}`);
    assert.deepEqual(routes, ['deepseek-official/deepseek-flash', 'deepseek-official/deepseek-flash']);
});

test('名册：承包商的提示词随名册返回并计入字数', async () => {
    const host = createHost({
        members: [{ name: '力工', prompt: '只改 React 组件，别动后端。', provider: 'p', model: 'm' }],
    });
    const roster = await host.tools.get('foreman_roster').execute({}, execOf());
    assert.equal(roster.members[0].prompt, '只改 React 组件，别动后端。');
    assert.equal(roster.members[0].maxParallel, 1);
    assert.match(roster.summary, /提示词 17 字/);
});

test('名册：不同名字的多个实例可以共存', async () => {
    const host = createHost({
        members: [
            { name: '力工-前端', provider: 'p', model: 'm' },
            { name: '力工-后端', provider: 'p', model: 'm' },
        ],
    });
    const roster = await host.tools.get('foreman_roster').execute({}, execOf());
    assert.equal(roster.members.length, 2);
});

test('单实例并发上限 1：同一个力工不会同时接两张单', async () => {
    const host = createHost({
        hold: true,
        members: [{ name: '力工', role: '力工', provider: 'p', model: 'm', maxParallel: 1 }],
    });
    let settled = false;
    const pendingDispatch = host.tools.get('foreman_dispatch').execute({
        orders: [
            { id: 'W1', title: '一', task: '甲' },
            { id: 'W2', title: '二', task: '乙' },
        ],
    }, execOf()).then((value) => {
        settled = true;
        return value;
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    // 第一张还没交，第二张不应该已经派出
    assert.equal(host.activations.length, 1);
    for (let attempt = 0; attempt < 40 && !settled; attempt += 1) {
        host.releaseAll();
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    const result = await pendingDispatch;
    assert.equal(result.ok, true);
    assert.equal(host.activations.length, 2);
    assert.equal(host.maxConcurrent(), 1);
});

test('单实例并发上限 2：同一个力工可以同时接两张单', async () => {
    const host = createHost({
        hold: true,
        members: [{ name: '力工', provider: 'p', model: 'm', maxParallel: 2 }],
    });
    let settled = false;
    const pendingDispatch = host.tools.get('foreman_dispatch').execute({
        orders: [
            { id: 'W1', title: '一', task: '甲' },
            { id: 'W2', title: '二', task: '乙' },
        ],
    }, execOf()).then((value) => {
        settled = true;
        return value;
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(host.activations.length, 2);
    for (let attempt = 0; attempt < 40 && !settled; attempt += 1) {
        host.releaseAll();
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    await pendingDispatch;
    assert.equal(host.maxConcurrent(), 2);
});

test('foreman_dispatch：dependsOn 串行，并发上限被遵守', async () => {
    const host = createHost({
        members: [
            { name: 'a', provider: 'p', model: 'm' },
            { name: 'b', provider: 'p', model: 'm' },
        ],
    });
    const result = await host.tools.get('foreman_dispatch').execute({
        orders: [
            { id: 'W1', title: '一', task: '甲' },
            { id: 'W2', title: '二', task: '乙', dependsOn: ['W1'] },
        ],
    }, execOf());
    assert.equal(result.ok, true);
    // 依赖顺序：W1 的激活先发
    assert.match(host.activations[0].label, /^W1/);
    assert.match(host.activations[1].label, /^W2/);
});

test('foreman_review：打回 → 返工一次，反馈进提示词，第二轮仍可再打回', async () => {
    const host = createHost({
        members: [{ name: 'coder-a', provider: 'p', model: 'm' }],
    });
    const dispatchResult = await host.tools.get('foreman_dispatch').execute({
        orders: [{ id: 'W1', title: '改取整', task: '改', accept: '通过' }],
    }, execOf());
    const runId = dispatchResult.runId;

    const reviewed = await host.tools.get('foreman_review').execute({
        runId,
        verdicts: [{ order: 'W1', verdict: 'fail', feedback: '缺回归测试' }],
    }, execOf());

    assert.equal(reviewed.ok, true);
    assert.equal(reviewed.status, 'waiting-review');
    assert.equal(host.activations.length, 2);
    assert.match(host.activations[1].request.prompt[0].text, /上一轮被打回/);
    assert.match(host.activations[1].request.prompt[0].text, /缺回归测试/);
    assert.equal(reviewed.orders[0].attempts, 2);

    // 第二次打回：返工额度用完（maxRework=1），不再重派
    const second = await host.tools.get('foreman_review').execute({
        runId,
        verdicts: [{ order: 'W1', verdict: 'fail', feedback: '还是不行' }],
    }, execOf());
    assert.equal(host.activations.length, 2);
    assert.equal(second.status, 'closed');
});

test('foreman_review：全部通过即结案', async () => {
    const host = createHost({ members: [{ name: 'a', provider: 'p', model: 'm' }] });
    const dispatchResult = await host.tools.get('foreman_dispatch').execute({
        orders: [{ id: 'W1', title: '一', task: '甲' }],
    }, execOf());
    const reviewed = await host.tools.get('foreman_review').execute({
        runId: dispatchResult.runId,
        verdicts: [{ order: 'W1', verdict: 'pass' }],
    }, execOf());
    assert.equal(reviewed.status, 'accepted');
    assert.match(reviewed.summary, /通过 1/);
});

test('foreman_status：省略 runId 取最近一轮；未知 id 报错', async () => {
    const host = createHost({ members: [{ name: 'a', provider: 'p', model: 'm' }] });
    const dispatched = await host.tools.get('foreman_dispatch').execute({
        orders: [{ id: 'W1', title: '一', task: '甲' }],
    }, execOf());
    const status = await host.tools.get('foreman_status').execute({}, execOf());
    assert.equal(status.runId, dispatched.runId);
    assert.match(status.summary, /W1/);
    // withOutput 会带上正文
    const withOutput = await host.tools.get('foreman_status').execute({ withOutput: true }, execOf());
    assert.match(withOutput.summary, /交付摘要：做完了/);
    await assert.rejects(() => host.tools.get('foreman_status').execute({ runId: 'R-nope' }, execOf()), /找不到派单记录/);
});

test('派单错误：名册为空、承包商不存在、工具未注册', async () => {
    const empty = createHost();
    await assert.rejects(
        () => empty.tools.get('foreman_dispatch').execute({ orders: [{ task: 'x' }] }, execOf()),
        /名册里没有已启用的承包商/,
    );

    const host = createHost({ members: [{ name: 'a', provider: 'p', model: 'm' }] });
    await assert.rejects(
        () => host.tools.get('foreman_dispatch').execute({ orders: [{ task: 'x', contractor: 'ghost' }] }, execOf()),
        /不在名册里/,
    );
});

test('超时：hanging 的子智能体在墙钟到点后被判超时', async () => {
    const host = createHost({ members: [{ name: 'a', provider: 'p', model: 'm' }], hang: true });
    const engine = host.tools.get('foreman_dispatch');
    // 用 dispatch 的 waitSeconds 掐整轮，避免等默认 900s
    const result = await engine.execute({
        orders: [{ id: 'W1', title: '一', task: '甲' }],
        waitSeconds: 1,
    }, execOf());
    assert.equal(result.ok, true);
    assert.equal(result.orders[0].status, 'failed');
    assert.match(result.orders[0].error, /中止|超时/);
});

test('路由：页面、状态、目录、名册保存、策略保存', async () => {
    const host = createHost({ members: [{ name: 'coder-a', provider: 'p', model: 'm' }] });

    const page = await call(host, '/plugins/dsh-agent-foreman');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.body, /承包商名册/);
    assert.match(page.body, /foreman_dispatch/);

    const state = await call(host, '/plugins/dsh-agent-foreman/api/state');
    assert.equal(state.status, 200);
    const stateBody = JSON.parse(state.body);
    assert.equal(stateBody.ok, true);
    assert.equal(stateBody.members[0].name, 'coder-a');
    assert.deepEqual(stateBody.subagentProviders, ['spawn']);

    const catalog = await call(host, '/plugins/dsh-agent-foreman/api/catalog');
    const catalogBody = JSON.parse(catalog.body);
    assert.equal(catalogBody.providers[0].id, 'deepseek-official');
    assert.equal(catalogBody.providers[0].models[0].id, 'deepseek-flash');

    const efforts = await call(host, '/plugins/dsh-agent-foreman/api/efforts?provider=deepseek-official&model=deepseek-flash');
    assert.deepEqual(JSON.parse(efforts.body).efforts.map(e => e.id), ['high']);

    const saved = await call(host, '/plugins/dsh-agent-foreman/api/members', {
        method: 'POST',
        body: JSON.stringify({ members: [{ name: 'coder-b', provider: 'p', model: 'm' }] }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(saved.body).members.map(m => m.name), ['coder-b']);

    const policy = await call(host, '/plugins/dsh-agent-foreman/api/policy', {
        method: 'POST',
        body: JSON.stringify({ concurrency: 2, timeoutSeconds: 120 }),
    });
    assert.equal(policy.status, 200);
    assert.equal(JSON.parse(policy.body).policy.concurrency, 2);
});

test('路由：坏输入翻译成 400，方法不对翻译成 405', async () => {
    const host = createHost();
    const bad = await call(host, '/plugins/dsh-agent-foreman/api/members', {
        method: 'POST',
        body: JSON.stringify({ members: [{ name: 'x', provider: 'p' }] }),
    });
    assert.equal(bad.status, 400);
    assert.equal(JSON.parse(bad.body).code, 'INVALID_ROUTE');

    const wrongMethod = await call(host, '/plugins/dsh-agent-foreman/api/members', { method: 'GET' });
    assert.equal(wrongMethod.status, 405);

    const brokenJson = await call(host, '/plugins/dsh-agent-foreman/api/policy', { method: 'POST', body: '{oops' });
    assert.equal(brokenJson.status, 400);
});

test('路由：跨站请求被拒（CSRF 面）', async () => {
    const host = createHost();
    const crossSite = await call(host, '/plugins/dsh-agent-foreman/api/state', {
        headers: { 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(crossSite.status, 403);

    const foreignOrigin = await call(host, '/plugins/dsh-agent-foreman/api/members', {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
        body: JSON.stringify({ members: [] }),
    });
    assert.equal(foreignOrigin.status, 403);

    const nonLoopback = await call(host, '/plugins/dsh-agent-foreman/api/state', {
        headers: { host: '192.168.1.5:12497' },
    });
    assert.equal(nonLoopback.status, 403);

    // 正常的同源请求放行
    const sameOrigin = await call(host, '/plugins/dsh-agent-foreman/api/state', {
        headers: { origin: 'http://127.0.0.1:12497' },
    });
    assert.equal(sameOrigin.status, 200);
});

test('live：没派过单时给空态，派单后给共享任务与运行状态', async () => {
    const host = createHost({ members: [{ name: '力工', provider: 'p', model: 'm' }] });

    const empty = await call(host, '/plugins/dsh-agent-foreman/api/live?session=session-1');
    assert.equal(empty.status, 200);
    const emptyBody = JSON.parse(empty.body);
    assert.equal(emptyBody.run, null);
    assert.equal(emptyBody.members.length, 1);
    assert.equal(emptyBody.members[0].name, '力工');
    assert.equal(emptyBody.lead.name, '包工头');

    await host.tools.get('foreman_dispatch').execute({
        goal: '做件事',
        orders: [{ id: 'W1', title: '一', task: '甲' }],
    }, execOf());

    const live = JSON.parse((await call(host, '/plugins/dsh-agent-foreman/api/live?session=session-1')).body);
    assert.equal(live.run.status, 'waiting-review');
    assert.equal(live.run.orders[0].title, '一');
    assert.equal(live.run.orders[0].contractor, '力工');
    assert.equal(live.run.orders[0].status, 'done');
    assert.equal(live.members[0].orders, 1);
    assert.equal(live.lead.waiting, true);

    // 会话 id 对不上时退回全局最近一轮，并标明不是本会话的。
    const other = JSON.parse((await call(host, '/plugins/dsh-agent-foreman/api/live?session=other')).body);
    assert.equal(other.run.matched, false);
    assert.equal(other.run.orders[0].title, '一');
    const same = JSON.parse((await call(host, '/plugins/dsh-agent-foreman/api/live?session=session-1')).body);
    assert.equal(same.run.matched, true);
});

test('台账：派单后写入，state 能读回', async () => {
    const host = createHost({ members: [{ name: 'a', provider: 'p', model: 'm' }] });
    await host.tools.get('foreman_dispatch').execute({
        goal: '做件事',
        orders: [{ id: 'W1', title: '一', task: '甲' }],
    }, execOf());
    const state = await call(host, '/plugins/dsh-agent-foreman/api/state');
    const body = JSON.parse(state.body);
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].goal, '做件事');
    assert.equal(body.runs[0].orders[0].contractor, 'a');
});

test('/foreman：有 commands 服务时注册原生命令，菜单里带标题和输入提示', () => {
    const host = createHost();
    const command = host.commands.find(entry => entry.name === 'foreman');
    assert.ok(command !== undefined, '应当注册 /foreman 命令');
    assert.match(command.description, /工单/);
    assert.equal(typeof command.input.hint, 'string');
    assert.ok(command.input.hint.length > 0);
    // 命令优先时不再重复注册 skill，否则菜单里会出现两个 /foreman
    assert.equal(host.skills.length, 0);
});

test('/foreman：handler 把四步流程和用户那句话一起 steer 进本回合', () => {
    const host = createHost();
    const command = host.commands.find(entry => entry.name === 'foreman');
    const result = command.handler({
        agent: host.fakeAgent,
        rawInput: '把 GraphBlocked 抽出来；给新逻辑补回归测试',
        signal: new AbortController().signal,
    });
    assert.equal(result.kind, 'success');
    assert.equal(host.steered.length, 1);
    const text = host.steered[0].content[0].text;
    assert.equal(host.steered[0].role, 'user');
    // 流程正文
    assert.match(text, /foreman_roster/);
    assert.match(text, /foreman_dispatch/);
    assert.match(text, /foreman_review/);
    // 用户这句话原样带进去，父模型不用再问一遍
    assert.match(text, /把 GraphBlocked 抽出来；给新逻辑补回归测试/);
});

test('/foreman：空输入时报用法，不 steer', () => {
    const host = createHost();
    const command = host.commands.find(entry => entry.name === 'foreman');
    const result = command.handler({ agent: host.fakeAgent, rawInput: '   ', signal: new AbortController().signal });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /用法/);
    assert.equal(host.steered.length, 0);
});

test('/foreman：没有 commands 服务时退回 skill，且 source 是字符串', () => {
    const host = createHost({ commands: false });
    assert.equal(host.commands.length, 0);
    const skill = host.skills.find(entry => entry.name === 'foreman');
    assert.ok(skill !== undefined, '应当退回注册 skill');
    // 宿主加载 skill 时会校验 source/content 都是字符串，缺 source 会让本轮直接报错。
    assert.equal(typeof skill.source, 'string');
    assert.ok(skill.source.length > 0);
    assert.equal(typeof skill.content, 'string');
    assert.match(skill.content, /foreman_roster/);
    assert.match(skill.description, /派单/);
});

test('团队模式：上一轮建的成员还在名册里时复用，不再 spawn', async () => {
    const host = createHost({
        team: true,
        teamMembers: [{ id: 'team-old', name: 'w1-' + createHash('sha256').update(JSON.stringify(['w1', '', '', ''])).digest('hex').slice(0, 16), role: 'teammate', status: 'idle' }],
        members: [{ id: 'w1', name: '力工', provider: '', model: '' }],
    });
    await call(host, '/plugins/dsh-agent-foreman/api/policy', {
        method: 'POST',
        body: JSON.stringify({ teamMode: true }),
    });
    const result = await Promise.race([
        host.tools.get('foreman_dispatch').execute({
            goal: '修关系图',
            orders: [{ id: 'W1', title: '连线', task: '把连线改成曲线', accept: '看得见' }],
        }, execOf()),
        new Promise((_r, reject) => setTimeout(() => reject(new Error('EXEC_TIMEOUT_5S')), 5000)),
    ]);
    // 自建成员模式：不走 spawnTeammate，改走 startActivation + agentOptions。
    assert.equal(host.teamSpawned.length, 0, '不再走 spawnTeammate');
    assert.equal(host.activations.length, 0, '原生成员只通过消息续写');
    assert.equal(host.teamSent.length, 1);
    assert.equal(result.ok, true);
});
