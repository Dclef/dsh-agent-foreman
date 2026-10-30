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
        spawnTeammate: async function (_parent, request) {
            log.push('spawn');
            spawned = true;
            spawnedName = typeof request?.name === 'string' ? request.name : 'worker';
            sessions.set('s1', { snapshotEvents: () => events });
            const activation = await this.roster.ctx.subagents.startActivation({
                delivery: 'parent', childId: 's1', provider: request.provider,
                request: { prompt: request.prompt, parent: _parent }, signal: request.signal,
            });
            const header = opts.actualRoute ?? activation?.route;
            if (header) sessions.get('s1').header = header;
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
    const baseSubagents = {
        async startActivation(spec) {
            return { route: spec.request.agentOptions, childId: spec.childId };
        },
    };
    teams.roster = {
        ctx: { get subagents() { return ctx.get('subagents') ?? baseSubagents; } },
        async spawn() {},
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

test('团队模式：宿主有 subagents 时仍创建原生队友，不用自建会话冒充团队成员', async () => {
    const captured = [];
    const host = fakeHost({
        memberRow: (_read, spawned, name) => spawned
            ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' }
            : undefined,
    });
    const subagents = {
        providers: new Map([['spawn', {}]]),
        async startActivation(spec) {
            captured.push(spec);
            return { childId: 's1', result: Promise.resolve({ output: [{ type: 'text', text: 'standalone' }] }), dispose: async () => {} };
        },
    };
    const originalGet = host.ctx.get;
    host.ctx.get = name => name === 'subagents' ? subagents : originalGet(name);
    const runner = createTeamRunner({ ctx: host.ctx, activeTimeoutMs: 1000 });
    const result = await runner.dispatch({
        order: order({ member: member({ provider: '', model: '' }) }),
        parent: { id: 'lead' }, prompt: '干活', policy: POLICY,
    });
    assert.equal(result.ok, true);
    assert.ok(host.log.includes('spawn'), '必须通过 agentTeams.spawnTeammate 登记真实队友');
    assert.equal(captured.some(spec => spec.delivery === 'caller'), false, '不得直接启动独立会话冒充团队');
});

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

test('dispatch：实际模型与名册不同时拒绝投递，不悄悄继承父模型', async () => {
    const host = fakeHost({
        actualRoute: { provider: 'p', model: 'n' },
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

    assert.equal(result.ok, false);
    assert.match(result.reason, /模型路由未匹配/);
    assert.equal(host.log.includes('send'), false);
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
test('dispatch：成员尚在 running 时不把中间正文误当最终交付', async () => {
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
        policy: { timeoutSeconds: 0.05 },
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(result.ok, false, '成员仍在 running 时中间正文不应被当成最终交付');
    assert.match(result.reason, /超时/);
    assert.ok(elapsed < 1000, `硬超时必须按时返回，实际耗时 ${elapsed}ms`);
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
        order: order({ member: member({ provider: '', model: '' }) }),
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
    const work = order({ member: member({ provider: '', model: '' }) });
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

test('原生建队：创建时注入名册模型、推理等级和深度，原方法从未被替换', async () => {
    const captured = [];
    const subagents = { providers: new Map([['spawn', {}]]), async startActivation(spec) {
        captured.push(spec);
        assert.strictEqual(subagents.startActivation, original);
        return { childId: spec.childId, route: spec.request.agentOptions };
    } };
    const original = subagents.startActivation;
    const host = fakeHost({ memberRow: (_r, spawned, name) => spawned
        ? { id: 's1', name, role: 'teammate', status: 'idle' } : undefined });
    const get = host.ctx.get;
    host.ctx.get = name => name === 'subagents' ? subagents : get(name);
    const runner = createTeamRunner({ ctx: host.ctx });
    const result = await runner.dispatch({
        order: order({ member: member({ provider: 'p1', model: 'm1', reasoningEffort: 'high' }) }),
        parent: { id: 'lead' }, prompt: 'work', policy: { timeoutSeconds: 3, maxDepth: 2 },
    });
    assert.equal(result.ok, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].delivery, 'parent');
    assert.deepEqual(captured[0].request.agentOptions, { provider: 'p1', model: 'm1', reasoningEffort: 'high' });
    assert.equal(captured[0].request.maxDepth, 2);
    assert.strictEqual(subagents.startActivation, original);
    assert.match(result.note, /原生团队成员/);
});

test('原生队友返工：同一团队与名册路由复用同一成员，通过消息续写不重新激活', async () => {
    const host = fakeHost({ memberRow: (_r, spawned, name) => spawned
        ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' } : undefined });
    const runner = createTeamRunner({ ctx: host.ctx });
    const parent = { id: 'lead' };
    const first = await runner.dispatch({ order: order(), parent, prompt: 'first', policy: POLICY });
    const second = await runner.dispatch({ order: order({ id: 'W2' }), parent, prompt: 'rework', policy: POLICY });
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    assert.equal(first.sessionId, second.sessionId);
    assert.equal(host.log.filter(x => x === 'spawn').length, 1);
    assert.equal(host.log.filter(x => x === 'send').length, 2);
});

test('原生队友缓存按父会话隔离，同一承包商不会串到别的团队', async () => {
    const host = fakeHost({ memberRow: (_r, spawned, name) => spawned
        ? { id: 's1', name, role: 'teammate', status: 'idle', model: 'm' } : undefined });
    // Each team independently resolves its members.
    let activeParent;
    const list = host.teams.listMembers;
    host.teams.listMembers = parent => parent === activeParent ? list(parent) : [];
    const spawn = host.teams.spawnTeammate;
    host.teams.spawnTeammate = async function (parent, request) { activeParent = parent; return spawn.call(this, parent, request); };
    const runner = createTeamRunner({ ctx: host.ctx });
    for (const id of ['parent-a', 'parent-b']) {
        const result = await runner.dispatch({ order: order(), parent: { id }, prompt: 'work', policy: POLICY });
        assert.equal(result.ok, true);
    }
    assert.equal(host.log.filter(x => x === 'spawn').length, 2);
    assert.deepEqual(runner.snapshot().map(x => x.parentId), ['parent-a', 'parent-b']);
});
