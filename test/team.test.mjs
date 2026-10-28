/**
 * 团队模式的生命周期等待测试。
 *
 * 为什么要有这组用例：宿主 `sendMessage` 只认 phase=active 的成员，`spawnTeammate`
 * 返回时成员还在 provisioning，直接发消息会抛 `active teammate "worker" not found`。
 * 这组用例用假宿主复现那个间隙，证明 `dispatch` 一定等到 `listMembers` 上不再是
 * provisioning 才发消息，并且把宿主回显的实际模型写进 note。
 *
 * 全部用假 ctx，不依赖 node_modules、不启动宿主；超时通过 `activeTimeoutMs`
 * 调到毫秒级，用例不会真的等 120s。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTeamRunner } from '../lib/team.js';

/**
 * 造一个假宿主。
 *
 * @param opts.memberRow - 依调用次数给出成员行的函数：`(readIndex, spawned, name) => row | undefined`，
 *   readIndex 从 1 开始；`sinceSpawn` 是 spawn 之后的读取次数；返回 undefined 视为名册里还没有这个人。
 * @param opts.agentsStatus - `agents.get(sessionId)` 回的状态，默认 'idle'。
 * @param opts.events - 成员会话的事件列表，默认一条工单 + 一条回复。
 * @param opts.log - 可选，记录调用顺序，用于断言 sendMessage 的时机。
 */
function fakeHost(opts = {}) {
    const log = opts.log ?? [];
    const sessions = new Map();
    let reads = 0;
    let spawned = false;
    /** spawn 之后读了几次名册（用例里按它数 provisioning 次数，不受 spawn 前那次读影响）。 */
    let readsSinceSpawn = 0;
    let spawnedName = 'worker';

    // 成员刚进场时跑了一轮握手，这两条是工单派出去之前就存在的事件（baseline）。
    const events = opts.events ?? [
        { type: 'user/message', data: { message: { content: [{ type: 'text', text: '待命。' }] } } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '待命。' }] } } },
    ];

    const teams = {
        spawnTeammate: async (_parent, request) => {
            log.push('spawn');
            spawned = true;
            spawnedName = typeof request?.name === 'string' ? request.name : 'worker';
            sessions.set('s1', { snapshotEvents: () => events });
            // 真实宿主：spawnTeammate 内部调 subagents.startActivation 创建子会话。
            // 这一步让拦截注入有机会生效（插件会临时 patch startActivation 注入 agentOptions）。
            const subagents = ctx.get('subagents');
            if (subagents && typeof subagents.startActivation === 'function') {
                try {
                    await subagents.startActivation({
                        delivery: 'parent',
                        childId: 's1',
                        provider: 'spawn',
                        request: { prompt: request.prompt, parent: _parent },
                        signal: request.signal,
                    });
                }
                catch { /* 假 startActivation 失败不影响 spawn 结果 */ }
            }
            return { member: { id: 's1', name: spawnedName } };
        },
        listMembers: () => {
            reads += 1;
            if (spawned)
                readsSinceSpawn += 1;
            const row = opts.memberRow(reads, spawned, spawnedName, readsSinceSpawn);
            log.push(`list:${row === undefined ? 'none' : row.status}`);
            return row === undefined ? [] : [row];
        },
        sendMessage: async () => {
            log.push('send');
            // 真实宿主：消息投进去之后成员会话里才会多出这两条事件。
            events.push({ type: 'user/message', data: { message: { content: [{ type: 'text', text: '干活' }] } } });
            events.push({
                type: 'assistant/message',
                data: { message: { content: [{ type: 'text', text: opts.reply ?? '干完了' }] } },
            });
        },
        createTask: async () => {
            log.push('createTask');
            return { id: 'T-1', revision: 1 };
        },
        updateTask: async () => {
            log.push('updateTask');
            return { id: 'T-1', revision: 2 };
        },
    };

    const ctx = {
        get: name => {
            if (name === 'agentTeams')
                return teams;
            if (name === 'agents') {
                // agentsStatus 显式传 undefined 时，模拟"宿主不报告状态"。
                const status = 'agentsStatus' in opts ? opts.agentsStatus : 'idle';
                if (status === undefined)
                    return { get: () => undefined };
                // 真实宿主里活 agent 也带 session（子智能体会话靠这条通道读到），
                // 所以这里一并给出，否则 agents 兜底依旧读不到事件。
                return {
                    get: id => ({
                        status,
                        session: sessions.get(id),
                    }),
                };
            }
            if (name === 'sessions') {
                // sessionMissing：模拟"这个成员会话这一次查不到"。
                if (opts.sessionMissing === true)
                    return { get: () => undefined };
                return {
                    get: id => sessions.get(id),
                };
            }
            return undefined;
        },
    };
    ctx.root = ctx;
    return { ctx, teams, log, teamsReads: () => reads };
}

/** 名册里的承包商（正常化后的形状）。 */
function member(overrides = {}) {
    return {
        id: 'coder-a',
        name: 'coder-a',
        provider: 'p',
        model: 'm',
        reasoningEffort: '',
        prompt: '',
        role: 'coder-a',
        ...overrides,
    };
}

/** 工单 + 策略（dispatch 只用到 timeoutSeconds 与 order.member）。 */
function order(overrides = {}) {
    return { id: 'W1', title: '修', member: member(), ...overrides };
}

const POLICY = { timeoutSeconds: 5 };

test('dispatch：成员前两次 provisioning，第三次才 active——必须先等到第三次才发消息', async () => {
    const log = [];
    const host = fakeHost({
        log,
        // spawn 之前名册里没有人；spawn 之后头两次读还是 provisioning，第三次才 idle。
        memberRow: (read, spawned, name, sinceSpawn) => {
            if (!spawned)
                return undefined;
            if (sinceSpawn <= 2)
                return { id: 's1', name, role: 'teammate', status: 'provisioning' };
            return { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' };
        },
    });
    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    const result = await runner.dispatch({
        order: order(),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: POLICY,
    });

    assert.equal(result.ok, true, '成员变成 active 之后应该派单成功');
    const sendAt = log.indexOf('send');
    assert.ok(sendAt > 0, 'sendMessage 应该被调用');
    // 发消息那一刻之前，provisioning 的行已经被读了两遍：第三次（active）之后才发。
    const before = log.slice(0, sendAt);
    assertBeforeSend(before);
});

/** 断言发消息之前看到的 provisioning 次数，以及最后一次读到的不是 provisioning。 */
function assertBeforeSend(before) {
    const provisioning = before.filter(entry => entry === 'list:provisioning');
    assert.equal(provisioning.length, 2, '发消息之前应该正好读到两次 provisioning');
    assert.ok(before.includes('list:idle'), '发消息之前必须已经读到一次非 provisioning 的行');
    assert.equal(
        before[before.length - 1],
        'list:idle',
        '发消息前最后一次名册读取必须是 active 状态的那个成员',
    );
}

test('dispatch：成员一直 provisioning，超时后返回 { ok:false } 且从不发消息', async () => {
    const log = [];
    const host = fakeHost({
        log,
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'provisioning' }
            : undefined),
    });
    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 300 });
    const startedAt = Date.now();
    const result = await runner.dispatch({
        order: order(),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: POLICY,
    });

    assert.equal(result.ok, false, '超时应该退回普通模式而不是抛错');
    assert.match(result.reason, /provisioning/);
    assert.equal(log.includes('send'), false, '成员没 active 时一次消息都不该发');
    assert.ok(Date.now() - startedAt < 10000, '超时要按传入的毫秒级上限收口，不该真的等 120s');
});

test('dispatch：成员 status=failed 直接判失败，reason 带出 diagnostics 的原因', async () => {
    const log = [];
    const host = fakeHost({
        log,
        memberRow: (read, spawned, name) => (spawned
            ? {
                id: 's1',
                name,
                role: 'teammate',
                status: 'failed',
                diagnostics: [{ message: 'provider 目录里没有这个模型' }],
            }
            : undefined),
    });
    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    const result = await runner.dispatch({
        order: order(),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: POLICY,
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /provider 目录里没有这个模型/);
    assert.equal(log.includes('send'), false);
});

test('dispatch：note 带宿主回显的实际模型；名册配 m 而成员跑 n 时报不一致', async () => {
    const host = fakeHost({
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'n' }
            : undefined),
    });
    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    const result = await runner.dispatch({
        order: order(),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: POLICY,
    });

    assert.equal(result.ok, true);
    assert.equal(result.actualModel, 'n');
    assert.equal(result.text, '干完了');
    assert.match(result.note, /实际模型 n/);
    assert.match(result.note, /不一致/);
    assert.match(result.note, /名册配 m/);
});

test('dispatch：名册为空（跟随父会话）时只报实际模型、不报不一致', async () => {
    const host = fakeHost({
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'idle', live: { options: { model: 'n' } } }
            : undefined),
    });
    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    const result = await runner.dispatch({
        order: order({ member: member({ provider: '', model: '' }) }),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: POLICY,
    });

    assert.equal(result.ok, true);
    assert.equal(result.actualModel, 'n', '宿主由 live.options.model 回显实际模型');
    assert.match(result.note, /实际模型 n/);
    assert.doesNotMatch(result.note, /不一致/, '名册为空时不该断言不一致');
});

/**
 * 回归：成员已经回了正文，但宿主仍报 `running`。
 *
 * 这是之前团队模式「成员超时没回」的真凶：旧实现优先信宿主 `status`，成员干完活
 * 之后状态刷新有延迟（或该 agent 被下一次调度占着），就一直等到 timeout，把一份
 * 已经干完的活判成失败，然后退回普通模式再跑一遍——白花一次完整的模型调用。
 *
 * 现在的判定是「先看有没有正文」：正文已经写进会话就先收活，不看状态。
 */
test('dispatch：成员已回正文、宿主仍报 running——必须直接收活，不能等到超时', async () => {
    const host = fakeHost({
        // 关键：状态永远 running，模拟宿主状态刷新滞后。
        agentsStatus: 'running',
        reply: 'TM_OK 干完了',
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'running', model: 'm' }
            : undefined),
    });
    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    const startedAt = Date.now();
    const result = await runner.dispatch({
        order: order(),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: { timeoutSeconds: 30 },
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(result.ok, true, '有正文就该收活，不该因为状态还是 running 而失败');
    assert.match(result.text, /TM_OK 干完了/);
    // 状态一直是 running，旧实现会等满 30 秒 timeout；新实现应在第一次轮询就收活。
    assert.ok(elapsed < 5000, `不该等满超时，实际耗时 ${elapsed}ms`);
});

/**
 * 回归：会话里已有上一单的旧正文，不能把它当成本单交付。
 *
 * 线上真实现象：工单要求 `TM3_FINAL_OK`，插件却把上一轮的 `TM2_OK` 交回去。
 * 根因是 `eventCount` 取不到会话时退回 0，而 0 的含义是"从会话开头算起"，
 * 于是读回复扫到了最早那条 assistant 消息。
 *
 * 这里把「spawn 时就带着两轮旧事件」的场景固定下来：baseline 必须落在旧事件
 * 之后，收到的正文必须是本单那一句。
 */
test('dispatch：会话里已有旧正文时，只能交本单的产物，不能交旧货', async () => {
    const host = fakeHost({
        // 成员进场前就有两轮历史（更早的握手 + 更早的一次派单）。
        events: [
            { type: 'user/message', data: { message: { content: [{ type: 'text', text: '待命' }] } } },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '待命' }] } } },
            { type: 'user/message', data: { message: { content: [{ type: 'text', text: '上一单' }] } } },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'OLD_STALE_REPLY' }] } } },
        ],
        reply: 'FRESH_REPLY',
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' }
            : undefined),
    });
    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    const result = await runner.dispatch({
        order: order(),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: { timeoutSeconds: 10 },
    });

    assert.equal(result.ok, true);
    assert.match(result.text, /FRESH_REPLY/, '必须交本单的正文');
    assert.doesNotMatch(result.text, /OLD_STALE_REPLY/, '绝不能把上一单的旧正文当成本单交付');
});

/**
 * 回归：会话与状态都读不到时，不能死等整单预算。
 *
 * 线上真实现象：新建成员那一单白等 120 秒才退回普通模式，而子智能体其实
 * 早就干完了。根因是读不到会话后，判定退化成只看状态；状态也读不到时，
 * 两个阶段会分别等满 START_TIMEOUT_MS 与 timeoutMs。
 *
 * 现在的处理是「先探可观测性」：两条通道都不可观测就直接认输，让引擎尽早
 * 退回普通模式，而不是把预算烧在看不见结果的等待上。
 */
test('dispatch：读不到会话与状态时，等自报通道；无自报则超时并带回诊断', async () => {
    const host = fakeHost({
        // 关键：sessions 里查不到这个成员，agents 也不返回状态。
        sessionMissing: true,
        agentsStatus: undefined,
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' }
            : undefined),
    });
    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    const startedAt = Date.now();
    const result = await runner.dispatch({
        order: order(),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: { timeoutSeconds: 3 },
    });
    const elapsed = Date.now() - startedAt;

    // 新行为：读不到会话**不再立刻放弃**，而是等自报（成员可能照样调 foreman_report）。
    // 这里没人上报，所以等到超时，但原因必须带回诊断信息。
    assert.equal(result.ok, false, '无自报、无会话正文时只能判失败');
    assert.match(result.reason, /baseline/, '原因要带回诊断（baseline 等）');
    assert.ok(elapsed < 10000, `不该远超 timeoutSeconds，实际耗时 ${elapsed}ms`);
});

/**
 * 新能力：即使读不到成员会话，靠 `foreman_report` 自报也能收活。
 *
 * 这是 dsh-agent-teams 的做法——产物回收不依赖读成员会话，而是成员主动上报到
 * 插件自己的存储。线上已验证承包商会调用 foreman_report，产物落进 order.reportOutput。
 */
test('dispatch：读不到会话时，靠 foreman_report 自报收活', async () => {
    const work = order();
    const host = fakeHost({
        sessionMissing: true,
        agentsStatus: undefined,
        reply: '不该走会话通道',
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' }
            : undefined),
    });
    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    // 成员在 500ms 后"调用 foreman_report"：插件的 reportOrderOutput 会写这个字段。
    setTimeout(() => {
        work.reportOutput = 'SELF_REPORT_FINAL';
        work.reportAt = new Date().toISOString();
    }, 500);

    const result = await runner.dispatch({
        order: work,
        parent: { id: 'lead' },
        prompt: '干活',
        policy: { timeoutSeconds: 8 },
    });

    assert.equal(result.ok, true, '自报应当能收活，不该因读不到会话而失败');
    assert.equal(result.text, 'SELF_REPORT_FINAL', '产物应当来自自报');
    assert.match(result.note, /回收：自报/, 'note 要写明产物来自自报通道');
});

/**
 * 回归：成员会话只能从 `agents` 读到时，baseline 必须拿得到，不能是 -1。
 *
 * 这是线上白等两分钟的真凶：`eventCount` 只读 `ctx.get('sessions').get()`，
 * 而团队成员是**子智能体会话**，`sessions.get` 查不到它（只返回活的普通会话）。
 * 结果明明通过 `agents` 能读到会话，baseline 却仍是 -1，收活路径被判报废。
 *
 * 现在 eventCount 与 sessionEventSummary 共用同一套读取通道（含 agents 兜底），
 * 两者不会再给出互相矛盾的结论。
 */
test('dispatch：会话只能通过 agents 读到时，仍能正常收活并交回本单正文', async () => {
    const host = fakeHost({
        // sessions 查不到这个成员（模拟子智能体会话不在 sessions store 里）…
        sessionMissing: true,
        // …但 agents 注册表里有它，且能给出 status 与 session。
        agentsStatus: 'idle',
        reply: 'VIA_AGENTS_REPLY',
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' }
            : undefined),
    });
    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    const result = await runner.dispatch({
        order: order(),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: { timeoutSeconds: 20 },
    });

    assert.equal(result.ok, true, 'agents 通道可用时应当收活成功');
    assert.match(result.text, /VIA_AGENTS_REPLY/, '正文应来自本轮');
    assert.doesNotMatch(result.reason ?? '', /读不到成员会话/);
});

/**
 * 回归：握手回复落地前不能取 baseline，否则握手正文会被当成本单产物。
 *
 * 线上真实现象：工单要求一个 echo，插件却交回了「共享任务板上还没有工单」——
 * 那是成员收到握手（HANDSHAKE）时的回复。根因是 `waitHandshakeDone` 用
 * 「状态非 running」当完成信号，在握手回复到达前就继续往下走，导致 baseline
 * 早于握手回复，那条握手回复被 readReply 当成本单产物回收。
 *
 * 现在必须等握手的 assistant 正文落地才继续；状态只在事件读不到时兜底。
 */
test('dispatch：握手回复晚到时，不能被当成本单产物交回', async () => {
    // 事件初始只有握手的 user 消息，assistant 回复要过一会儿才到。
    const events = [
        { type: 'user/message', data: { message: { content: [{ type: 'text', text: '待命。' }] } } },
    ];
    const host = fakeHost({
        events,
        // 状态始终 idle：模拟"成员还没开始跑工单"。
        agentsStatus: 'idle',
        reply: 'FRESH_WORK_REPLY',
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' }
            : undefined),
    });
    // 握手回复在 800ms 后落地；工单回复在 sendMessage 时同步写入（fakeHost 行为）。
    setTimeout(() => {
        events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'HANDSHAKE_REPLY_EARLY' }] } } });
    }, 800);

    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    const result = await runner.dispatch({
        order: order(),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: { timeoutSeconds: 15 },
    });

    assert.equal(result.ok, true, '应当收活成功');
    assert.match(result.text, /FRESH_WORK_REPLY/, '必须交回工单产物');
    assert.doesNotMatch(result.text, /HANDSHAKE_REPLY_EARLY/, '绝不能把握手回复当成本单产物');
});

/**
 * 模型拦截注入：spawnTeammate 不接受 model 字段，但它内部调用
 * `subagents.startActivation({ request })`。我们临时拦截该调用，把名册的
 * agentOptions 注入进去——成员创建时就锁定正确模型，同时保留团队成员身份。
 *
 * 这是「先拦截再分发」：解决团队模式"分配不了模型"的根因。
 */
test('spawnTeammate 期间拦截 startActivation，把名册模型注入 agentOptions', async () => {
    const injected = [];
    const subagents = {
        providers: new Map([['spawn', {}]]),
        async startActivation(spec) {
            injected.push(spec?.request?.agentOptions);
            return { childId: 'c1', result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }, ), dispose: async () => {} };
        },
    };
    const host = fakeHost({
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' }
            : undefined),
    });
    const baseGet = host.ctx.get.bind(host.ctx);
    host.ctx.get = (name) => (name === 'subagents' ? subagents : baseGet(name));

    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    await runner.dispatch({
        order: order({ member: member({ provider: 'trae', model: 'glm-5.3-flash', reasoningEffort: 'high' }) }),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: { timeoutSeconds: 10 },
    });

    // spawnTeammate 内部调了 subagents.startActivation，拦截器注入了 agentOptions。
    assert.ok(injected.length > 0, 'spawnTeammate 应内部调用 startActivation');
    const opts = injected[0];
    assert.ok(opts !== undefined, '拦截器应注入 agentOptions');
    assert.equal(opts.provider, 'trae', 'provider 应来自名册');
    assert.equal(opts.model, 'glm-5.3-flash', 'model 应来自名册');
    assert.equal(opts.reasoningEffort, 'high', 'reasoningEffort 应来自名册');
    // 拦截器用完应还原。
    assert.notEqual(subagents.startActivation.name, 'interceptedStartActivation', '拦截器用完应还原成原函数');
});

/**
 * 自建成员：startActivation + agentOptions 锁定模型，delivery:'caller' 同步回收。
 *
 * 仿 agent-teams 但带模型可选——不靠 spawnTeammate（无法指定模型），
 * 不靠事后 selectModel（被 agent-busy 拒绝）。
 */
test('dispatchViaActivation：agentOptions 锁定模型，result 同步回收', async () => {
    const captured = [];
    const subagents = {
        providers: new Map([['spawn', {}]]),
        async startActivation(spec) {
            captured.push(spec);
            return {
                childId: 'child-1',
                result: Promise.resolve({ output: [{ type: 'text', text: '自建成员交付' }], stopReason: 'completed' }),
                dispose: async () => {},
            };
        },
    };
    const host = fakeHost({
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' }
            : undefined),
    });
    const baseGet = host.ctx.get.bind(host.ctx);
    host.ctx.get = (name) => (name === 'subagents' ? subagents : baseGet(name));

    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    const result = await runner.dispatch({
        order: order({ member: member({ provider: 'qoder', model: 'mmodel', reasoningEffort: 'max' }) }),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: { timeoutSeconds: 10, provider: 'spawn', maxDepth: 1 },
    });

    assert.equal(result.ok, true, '自建成员应成功收活');
    assert.equal(result.text, '自建成员交付', '产物来自 result');
    // 模型通过 agentOptions 锁定。
    assert.equal(captured.length, 1, '应调用一次 startActivation');
    const opts = captured[0]?.request?.agentOptions;
    assert.ok(opts !== undefined, 'agentOptions 应注入');
    assert.equal(opts.provider, 'qoder', 'provider 应来自名册');
    assert.equal(opts.model, 'mmodel', 'model 应来自名册');
    assert.equal(opts.reasoningEffort, 'max', 'reasoningEffort 应来自名册');
    assert.match(result.note, /自建成员/, 'note 应写明自建成员');
});

/**
 * 返工复用（核心目标）：同一名册成员的 sessionId 已缓存时，返工**不再新建
 * 子智能体**——宿主没有高级续写通道时，退回「重激活同一个 childId」，即
 * `startActivation` 收到与首单相同的 childId，而不是开一个全新的子会话。
 *
 * 这修复了一个真实缺陷：所有派单路径（含返工）都走 startActivation 开新
 * 子智能体，成员每打回一次就换一个新会话、丢掉上一轮的上下文与身份。
 * 现在首单记录缓存，返工在原地续写。
 */
test('dispatchViaActivation：返工复用缓存的 sessionId，不再新建子智能体', async () => {
    const captured = [];
    const subagents = {
        providers: new Map([['spawn', {}]]),
        async startActivation(spec) {
            captured.push(spec);
            const childId = spec?.childId ?? `child-${captured.length}`;
            return {
                childId,
                result: Promise.resolve({ output: [{ type: 'text', text: `交付-${captured.length}` }], stopReason: 'completed' }),
                dispose: async () => {},
            };
        },
    };
    const host = fakeHost({
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' }
            : undefined),
    });
    const baseGet = host.ctx.get.bind(host.ctx);
    host.ctx.get = (name) => (name === 'subagents' ? subagents : baseGet(name));

    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    // 第 1 单：创建成员。
    const first = await runner.dispatch({
        order: order({ member: member({ provider: 'qoder', model: 'mmodel' }) }),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: { timeoutSeconds: 10, provider: 'spawn', maxDepth: 1 },
    });
    assert.equal(first.ok, true);
    assert.equal(captured.length, 1, '首单应创建一次子智能体');
    const firstChildId = first.sessionId;
    assert.equal(typeof firstChildId, 'string');
    assert.equal(firstChildId, 'child-1');

    // 同一名的返工单：宿主没有 submitPrompt/steer → 走重激活同一个 childId。
    const second = await runner.dispatch({
        order: order({ id: 'W1', member: member({ id: 'coder-a', provider: 'qoder', model: 'mmodel' }) }),
        parent: { id: 'lead' },
        prompt: '上一轮被打回 缺回归测试',
        policy: { timeoutSeconds: 10, provider: 'spawn', maxDepth: 1 },
    });
    assert.equal(second.ok, true);
    assert.equal(captured.length, 2, '返工仍走 startActivation（reactivate 兜底）');
    // 关键断言：第二次激活携带与首单相同的 childId，而不是新会话。
    assert.equal(captured[1].childId, firstChildId, '返工必须复用同一 childId');
    assert.equal(captured[1].request?.sessionId, firstChildId, 'request.sessionId 也要指向同一会话');
    // 返工不再新建成员缓存条目，note 里写明复用。
    assert.equal(second.sessionId, firstChildId, '产物仍回到同一会话');
    assert.match(second.note, /返工·复用会话/, 'note 应如实写明返工复用会话');
    assert.equal(second.text, '交付-2');
});

/**
 * 返工走高级续写通道：宿主给子会话挂了 steer 句柄时，返工通过 steer 续写
 * 既有会话，**完全不再调用 startActivation**——子智能体数量不增。
 */
test('dispatchViaActivation：宿主有 steer 句柄时返工走续写，不再 startActivation', async () => {
    const captured = [];
    const steered = [];
    const subagents = {
        providers: new Map([['spawn', {}]]),
        async startActivation(spec) {
            captured.push(spec);
            return {
                childId: 'child-9',
                result: Promise.resolve({ output: [{ type: 'text', text: '首单交付' }], stopReason: 'completed' }),
                dispose: async () => {},
            };
        },
    };
    const host = fakeHost({
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' }
            : undefined),
    });
    const baseGet = host.ctx.get.bind(host.ctx);
    host.ctx.get = (name) => {
        if (name === 'subagents')
            return subagents;
        if (name === 'agents') {
            return {
                get: id => (id === 'child-9'
                    ? {
                        status: 'idle',
                        session: { snapshotEvents: () => [] },
                        steer: async (msg) => {
                            steered.push(msg);
                            return { output: [{ type: 'text', text: '返工交付' }], stopReason: 'completed' };
                        },
                    }
                    : undefined),
            };
        }
        return baseGet(name);
    };

    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    const first = await runner.dispatch({
        order: order({ member: member({ provider: 'qoder', model: 'mmodel' }) }),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: { timeoutSeconds: 10, provider: 'spawn', maxDepth: 1 },
    });
    assert.equal(first.ok, true);

    const second = await runner.dispatch({
        order: order({ id: 'W1', member: member({ id: 'coder-a', provider: 'qoder', model: 'mmodel' }) }),
        parent: { id: 'lead' },
        prompt: '上一轮被打回 缺回归测试',
        policy: { timeoutSeconds: 10, provider: 'spawn', maxDepth: 1 },
    });
    assert.equal(second.ok, true);
    assert.equal(captured.length, 1, '返工走 steer 续写，绝不新增 startActivation');
    assert.equal(steered.length, 1, '应调用一次 steer 续写');
    assert.match(steered[0]?.text ?? '', /上一轮被打回/, 'steer 内容应带上返工反馈');
    assert.equal(second.sessionId, 'child-9', '产物回到既有会话');
    assert.match(second.note, /返工·steer 会话/, 'note 应写明走 steer 续写');
});

/**
 * 普通自建成员（非返工、名册成员第一次出现）**仍然**每次新建子智能体——
 * 这是刻意保留的隔离特性，绝不能被返工复用误伤。
 */
test('dispatchViaActivation：不同名册成员仍各自新建子智能体，互不复用', async () => {
    const captured = [];
    const subagents = {
        providers: new Map([['spawn', {}]]),
        async startActivation(spec) {
            captured.push(spec);
            return {
                childId: `child-${captured.length}`,
                result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
                dispose: async () => {},
            };
        },
    };
    const host = fakeHost({
        memberRow: (read, spawned, name) => (spawned
            ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' }
            : undefined),
    });
    const baseGet = host.ctx.get.bind(host.ctx);
    host.ctx.get = (name) => (name === 'subagents' ? subagents : baseGet(name));

    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 2000 });
    await runner.dispatch({
        order: order({ member: member({ id: 'coder-a', provider: 'qoder', model: 'm' }) }),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: { timeoutSeconds: 10, provider: 'spawn', maxDepth: 1 },
    });
    await runner.dispatch({
        order: order({ id: 'W2', member: member({ id: 'coder-b', provider: 'qoder', model: 'm' }) }),
        parent: { id: 'lead' },
        prompt: '干活',
        policy: { timeoutSeconds: 10, provider: 'spawn', maxDepth: 1 },
    });

    assert.equal(captured.length, 2, '两个不同成员应各自创建子智能体');
    // 两个新会话都没有携带复用 childId（是纯新建，而非返工续写同一会话）。
    assert.equal('childId' in captured[0], false, '新成员首单不应传复用 childId');
    assert.equal('childId' in captured[1], false, '新成员首单不应传复用 childId');
});
