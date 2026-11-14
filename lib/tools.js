/**
 * 包工头 · 四个工具。
 *
 * 工具是父模型唯一能看见的接口，所以描述就是契约：它必须让人明白"我负责派单
 * 和验收，不负责动手"。四个工具的分工是刻意收窄的——
 *
 * | 工具             | 干什么                                   |
 * | ---------------- | ---------------------------------------- |
 * | foreman_roster   | 看名册：有哪些承包商、各自跑什么模型     |
 * | foreman_dispatch | 派一轮工单并等待全部落定                 |
 * | foreman_review   | 逐单签收；打回的按额度返工               |
 * | foreman_status   | 回看某一轮看板（工具调用被截断时兜底）   |
 *
 * 刻意没有做：指定 persona、指定工具白名单、超时后后台续跑、跨轮次持久派遣。
 * 前两个属于"专家团"那类插件，后两个会让父模型拿到与事实不符的完成状态。
 *
 * @module dsh-agent-foreman/tools
 */
import { ForemanError, normalizePolicy } from './store.js';
import { normalizeOrders, ForemanEngine } from './engine.js';

/** 从调用上下文里取会话 id，取不到时退化成一个固定桶。 */
function sessionKeyOf(exec) {
    const id = exec?.agent?.session?.id;
    return typeof id === 'string' && id !== '' ? id : 'session';
}

/** 工具结果里每单的结构化摘要（不含正文，正文在 summary 里）。 */
function orderRow(order) {
    return {
        id: order.id,
        title: order.title,
        contractor: order.contractorName ?? '',
        // route 是名册声明（"我让它用哪个模型"），actualRoute 是子会话头里的
        // 事实（"它到底用了哪个"）。两者不一致时 routeMismatch 为 true。
        route: order.route ?? '',
        actualRoute: order.actualRoute ?? '',
        routeMismatch: order.routeMismatch === true,
        routeNote: order.routeNote ?? '',
        status: order.status ?? 'queued',
        attempts: order.attempts ?? 1,
        durationMs: order.durationMs ?? 0,
        verdict: order.verdict ?? '',
        error: order.error ?? '',
        chars: order.chars ?? 0,
        teamMode: order.teamNote ?? '',
        writeScopes: Array.isArray(order.writeScopes) ? order.writeScopes : [],
        checklist: Array.isArray(order.checklist) ? order.checklist : [],
        qaRequired: order.qaRequired === true,
        // budget 是提示级约定（写进子智能体的工单里，不在这里强制执行）；
        // checkResults 是父智能体逐项签收的结果，usage 是宿主投影读数。
        budget: order.budget ?? null,
        checkResults: Array.isArray(order.checkResults) ? order.checkResults : [],
        usage: order.usage ?? null,
        reviewedBy: order.reviewedBy ?? '',
        deliveryRedo: order.deliveryRedo ?? null,
    };
}

/**
 * 构建四个工具的定义数组。
 * @param deps - `{ ctx, store, engine, logger }`。
 * @returns 工具定义数组，交给 `ctx.tools.register`。
 */
export function foremanTools({ ctx, store, engine, logger }) {
    /** 一次派单/回看的公共策略解析。 */
    const resolvePolicy = (args) => {
        const base = store.policy();
        const overrides = {};
        for (const key of ['concurrency', 'timeoutSeconds', 'maxRework'])
            if (args?.[key] !== undefined && args?.[key] !== null)
                overrides[key] = args[key];
        return normalizePolicy(overrides, base);
    };

    return [
        {
            name: 'foreman_roster',
            description: '查看包工头名册：有哪些承包商、各自用哪个 provider/模型/思考等级、是否启用、当前忙不忙，以及当前派单策略。名册里只有承包商：力工（业务实现）、小工（便宜简单的活）、安全员（可选，派去审别人的产出）；负责拆单和验收的父智能体不在名册里。点人原则：确实要动手→力工，要人挑错→安全员。最简形态是名册里只开一个力工，那样所有工单都归它，一个人并行干多张单。'
                + '派单前先看一眼，确认有哪些人、谁正忙；名册为空时告诉用户去「设置 → 包工头」里添加承包商。'
                + '注意：派单时**默认省略 contractor** 更好——省略时按实时负载挑人（跳过正忙的、取最空闲的），多会话共用一个名册时才不会都抢同一个人。'
                + '只在用户敲了 `/foreman` 或明确让你派单时才用；平时就当它不存在，不要主动拆单、不要主动接管用户的任务。',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            isConcurrencySafe: () => true,
            async execute() {
                const { members, policy } = store.snapshot();
                // 负载与派单同源：引擎的 runs 里躺着所有会话的看板，所以这里显示的
                // "忙"是真实的跨会话状态，而不是本会话视角。
                let load = new Map();
                try {
                    load = ForemanEngine.countLoad([...engine.runs.values()]);
                }
                catch {
                    // 读不到负载不影响看名册。
                }
                const lines = ['包工头名册：'];
                if (members.length === 0) {
                    lines.push('（空）请到「设置 → 包工头」添加承包商：给它起个名字，选 provider 与模型，保存后才能派单。');
                }
                else {
                    for (const member of members) {
                        const route = member.provider === '' ? '继承父会话' : `${member.provider}/${member.model}${member.reasoningEffort === '' ? '' : ` · ${member.reasoningEffort}`}`;
                        const parallel = member.maxParallel > 1 ? ` · 并发 ${member.maxParallel}` : '';
                        const hint = member.prompt === '' ? '' : ` · 提示词 ${[...member.prompt].length} 字`;
                        // 忙闲是跨会话的实时状态：这是"为什么这单会被派给别人"的
                        // 直接证据，比让模型自己猜名册顺序可靠得多。
                        const busy = load.get(member.id) ?? 0;
                        const state = busy === 0 ? ' · 空闲' : ` · 在跑 ${busy} 单`;
                        lines.push(`${member.enabled ? '●' : '○'} ${member.name} — ${route}${parallel}${hint}${member.enabled ? state : ''}`);
                    }
                }
                lines.push('', `策略：总并发 ${policy.concurrency} · 单张超时 ${policy.timeoutSeconds}s · 返工 ${policy.maxRework} 次`);
                lines.push('派单时省略 contractor 即按负载挑人（跳过正忙的、取最空闲的）；只有必须指定某人才写名字。');
                const used = [...new Set(members.map(member => member.provider).filter(provider => provider !== ''))];
                if (used.length > 0)
                    lines.push(`默认走 subagents provider「${policy.provider}」；承包商模型：${used.join('、')}。`);
                return {
                    ok: true,
                    members: members.map(member => ({ ...member, busy: load.get(member.id) ?? 0 })),
                    policy,
                    summary: lines.join('\n'),
                };
            },
            output: {
                schema: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        summary: { type: 'string' },
                        members: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    name: { type: 'string' },
                                    prompt: { type: 'string' },
                                    enabled: { type: 'boolean' },
                                    provider: { type: 'string' },
                                    model: { type: 'string' },
                                    reasoningEffort: { type: 'string' },
                                    maxParallel: { type: 'integer' },
                                },
                            },
                        },
                        policy: { type: 'object' },
                    },
                    required: ['ok', 'summary', 'members'],
                },
                render: (_args, value) => [{ type: 'text', text: value.summary }],
            },
        },
        {
            name: 'foreman_dispatch',
            description: '把一组工单派给名册里的承包商，并等待全部落定后返回共享看板（含每单的交付摘要）。点名册时按活分人：确实要动手改东西→力工；要人挑毛病/复核→安全员。名册只有一个力工时不用写 contractor，全给它；多张单可以同时来，同一岗位并行数受并发上限约束。'
                + '约定：用户消息以 /派单 开头（`/派单 把 A 抽成共享逻辑；给 B 补回归测试`）时，分号或换行后每一段就是一张工单，看完名册直接派，不要再来回确认。'
                + '用法：父智能体只做拆单与验收，不亲手干活；只有用户派单时才这么做。每张工单必须自足——子智能体看不到本会话任何上下文，'
                + '所以要写清背景、要的文件、验收标准；不同工单之间要有清晰边界，避免两个人改同一处。'
                + '【默认省略 contractor】：只有"这单必须由某个特定的人做"时才写名字。省略时按**实时负载**挑人——跳过正在跑单的人、取最空闲的，'
                + '负载打平才轮转。这条路径能看到别的会话正在用谁，所以多个会话同时派单不会一起压给名册第一个人。'
                + '把 contractor 一律写成「力工」会绕过负载分配，导致其余承包商闲置、活全串行排队；'
                + '只有名册里确实只有一个启用承包商时才这么写。dependsOn 只支持本轮内工单；上游全部成功完成后自动启动，任一上游失败/超时/取消会跳过其下游。'
                + '本插件与 DSH 原生「智能体团队」并存：原生编队提供持久 teammate / 消息 / 共享任务板，包工头补的是**按模型派单 + 逐单独立验收**；两者不互相替代。',
            parameters: {
                type: 'object',
                properties: {
                    goal: {
                        type: 'string',
                        description: '本轮总目标，一句话。会写进每张工单的抬头，便于承包商理解局部任务在整体中的位置。',
                    },
                    orders: {
                        type: 'array',
                        description: '工单数组，1–12 张。',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', description: '工单 id，省略则自动生成。验收时用它引用。' },
                                title: { type: 'string', description: '一句话标题，看板上显示。' },
                                task: {
                                    type: 'string',
                                    description: '完整任务说明：背景、要动哪些文件/目录、期望结果。必须自足。',
                                },
                                accept: {
                                    type: 'string',
                                    description: '验收标准：什么算完成、怎么验证。省略时按交付摘要自述验收。',
                                },
                                writeScopes: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: '写入范围（workspace 相对路径前缀，如 src/a.js 或 lib/）。仅作提示：与原生 Agent Teams 任务板 writeScopes 同形，重叠时只在看板挂软警告，不隔离文件、不授予写权限。',
                                },
                                checklist: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: '验收清单：逐条写清父智能体该核对什么。做的人不自己签收；看板把清单摆出来供逐项核对。',
                                },
                                contractor: {
                                    type: 'string',
                                    description: '承包商名字，或岗位名（如 力工 —— 在该岗位的多个实例之间按负载挑人）。'
                                        + '**默认省略**：省略时按实时负载分配（跳过正忙的人、取最空闲的），这是让多个会话共用一支队伍时不吃亏的唯一方式。'
                                        + '只有在"这单必须由某个特定的人做"时才写具体名字。',
                                },
                                dependsOn: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: '依赖的本轮工单 id；全部成功完成后自动启动，上游未成功会跳过。',
                                },
                                qaRequired: {
                                    type: 'boolean',
                                    description: '逐项验收（默认 false）：为 true 时，这一单在 foreman_review 里给 pass 必须按 checklist 逐条给出 checks，'
                                        + '缺一条就返回 QA_CHECKS_REQUIRED。适合"少一条都不算过"的硬门禁工单。',
                                },
                                budget: {
                                    type: 'object',
                                    description: '提示级预算：写进承包商工单里作为约定，由模型自觉遵守；运行时不强制执行、也不因此中止。',
                                    properties: {
                                        maxToolCalls: {
                                            type: 'integer',
                                            description: '最多多少次工具调用。',
                                        },
                                        maxRetries: {
                                            type: 'integer',
                                            description: '同一个失败最多重试几次。',
                                        },
                                        stopCondition: {
                                            type: 'string',
                                            description: '停止条件：满足这条就停下来写清原因，不要继续硬跑。',
                                        },
                                    },
                                    additionalProperties: false,
                                },
                            },
                            required: ['task'],
                            additionalProperties: false,
                        },
                    },
                    concurrency: {
                        type: 'integer',
                        description: '同时干活的承包商数量，1–8。省略用策略默认值。',
                    },
                    maxRework: {
                        type: 'integer',
                        description: '打回后允许返工的次数，0–3。省略用策略默认值。',
                    },
                    waitSeconds: {
                        type: 'integer',
                        description: '整轮的总墙钟上限（秒）。到点中止未完成的工单并返回现状，避免一次调用卡太久。',
                    },
                },
                required: ['orders'],
                additionalProperties: false,
            },
            isConcurrencySafe: () => false,
            presentCall(args) {
                const count = Array.isArray(args?.orders) ? args.orders.length : 0;
                return {
                    card: 'generic',
                    title: `包工头派单 · ${count} 张工单`,
                    kind: 'execute',
                    rawInput: { goal: args?.goal ?? '', orders: count },
                };
            },
            async execute(args, exec) {
                const members = store.members().filter(member => member.enabled);
                const orders = normalizeOrders(args?.orders ?? [], members);
                const policy = resolvePolicy(args);
                const controller = new AbortController();
                const forwardAbort = () => controller.abort(exec?.signal?.reason);
                if (exec?.signal !== undefined) {
                    if (exec.signal.aborted)
                        controller.abort(exec.signal.reason);
                    else
                        exec.signal.addEventListener('abort', forwardAbort, { once: true });
                }
                let timer;
                const waitSeconds = Number.isFinite(args?.waitSeconds) && args.waitSeconds > 0
                    ? Math.min(3600, Math.round(args.waitSeconds))
                    : 0;
                if (waitSeconds > 0) {
                    timer = setTimeout(() => {
                        controller.abort(new Error('foreman dispatch budget exhausted'));
                        logger?.warn?.(`dsh-agent-foreman: 派单总预算 ${waitSeconds}s 用完，中止未完成的工单`);
                    }, waitSeconds * 1000);
                }
                try {
                    const run = await engine.dispatch({
                        parent: exec.agent,
                        sessionId: sessionKeyOf(exec),
                        goal: typeof args?.goal === 'string' ? args.goal.trim() : '',
                        orders,
                        policy,
                        signal: controller.signal,
                    });
                    const summary = engine.renderBoard(run, { withOutput: true });
                    return {
                        ok: true,
                        runId: run.id,
                        status: run.status,
                        summary,
                        orders: run.orders.map(orderRow),
                    };
                }
                finally {
                    if (timer !== undefined)
                        clearTimeout(timer);
                    if (exec?.signal !== undefined)
                        exec.signal.removeEventListener?.('abort', forwardAbort);
                }
            },
            output: {
                schema: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        runId: { type: 'string' },
                        status: { type: 'string' },
                        summary: { type: 'string', description: '看板全文，含每单交付摘要——据此验收。' },
                        orders: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    title: { type: 'string' },
                                    contractor: { type: 'string' },
                                    route: { type: 'string', description: '名册声明的路由（provider/model）；名册留空时为 inherit。' },
                                    actualRoute: {
                                        type: 'string',
                                        description: '从子会话头读回的真实路由（provider/model）；读不到时为空串。',
                                    },
                                    routeMismatch: {
                                        type: 'boolean',
                                        description: '名册显式配了 provider+model 且与 actualRoute 不同时为 true；名册留空（跟随父会话）时恒为 false。',
                                    },
                                    routeNote: {
                                        type: 'string',
                                        description: '路由诊断说明；非空表示读不到子会话模型头，此时 actualRoute 为空。',
                                    },
                                    status: { type: 'string' },
                                    attempts: { type: 'integer' },
                                    durationMs: { type: 'integer' },
                                    verdict: { type: 'string' },
                                    error: { type: 'string' },
                                    chars: { type: 'integer', description: '交付正文纯文本字数。' },
                                    teamMode: { type: 'string', description: '非空表示这一单在团队模式下执行（或团队模式失败后退回普通模式的原因）。' },
                                    writeScopes: { type: 'array', items: { type: 'string' }, description: '工单声明的写入范围（仅提示）。' },
                                    checklist: { type: 'array', items: { type: 'string' }, description: '父智能体逐项核对的验收清单。' },
                                    reviewedBy: { type: 'string', description: '签收方；pass/fail 后为 foreman，证明不是干活的承包商自验。' },
                                    qaRequired: {
                                        type: 'boolean',
                                        description: '是否要求逐项验收；为 true 时 foreman_review 的 pass 必须带齐 checks。',
                                    },
                                    budget: {
                                        type: 'object',
                                        description: '提示级预算约定；没有声明时为 null。',
                                        properties: {
                                            maxToolCalls: { type: 'integer' },
                                            maxRetries: { type: 'integer' },
                                            stopCondition: { type: 'string' },
                                        },
                                    },
                                    checkResults: {
                                        type: 'array',
                                        description: '逐项验收结果；没开 qaRequired 或还没验收时为空数组。',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                item: { type: 'string' },
                                                passed: { type: 'boolean' },
                                                note: { type: 'string' },
                                            },
                                        },
                                    },
                                    usage: {
                                        type: 'object',
                                        description: '宿主投影的 token 读数（inputTokens/outputTokens/totalTokens）；拿不到时为 null，不是子会话自报。',
                                        properties: {
                                            inputTokens: { type: 'integer' },
                                            outputTokens: { type: 'integer' },
                                            totalTokens: { type: 'integer' },
                                        },
                                    },
                                    deliveryRedo: {
                                        type: 'object',
                                        description: '交付摘要超过 2000 字时的自动重出记录；没触发时为 null。',
                                        properties: {
                                            firstChars: { type: 'integer' },
                                            secondChars: { type: 'integer' },
                                            note: { type: 'string' },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    required: ['ok', 'runId', 'status', 'summary', 'orders'],
                },
                render: (_args, value) => [{ type: 'text', text: value.summary }],
            },
        },
        {
            name: 'foreman_review',
            description: '验收一轮工单：逐单给 pass 或 fail。fail 且还有返工额度时，会把反馈原样发回同一个承包商重做，'
                + '并等它跑完再返回新的看板。省掉 runId 默认审本会话最近一轮。'
                + '父智能体的职责就在这里：**做的人不自己签收**——逐条核对工单的 checklist 与 accept，读交付摘要判断，不合格就打回。'
                + 'fail 必须写具体 feedback（缺哪条、错在哪、改到什么程度），否则拒绝；pass/fail 都会记下 reviewedBy=foreman 以证明不是自验。'
                + '只在用户敲了 `/foreman` 或明确让你派单时才用。',
            parameters: {
                type: 'object',
                properties: {
                    runId: { type: 'string', description: '要验收的派单 id（形如 R-1a2b）。省略则取本会话最近一轮。' },
                    verdicts: {
                        type: 'array',
                        description: '验收结论数组，1 条以上。',
                        items: {
                            type: 'object',
                            properties: {
                                order: { type: 'string', description: '工单 id 或标题。' },
                                verdict: { type: 'string', enum: ['pass', 'fail'], description: '通过或打回。' },
                                feedback: {
                                    type: 'string',
                                    description: '打回理由，会原样进返工提示词；越具体越好（缺什么、错在哪、改到什么程度）。',
                                },
                                checks: {
                                    type: 'array',
                                    description: '逐项验收结果：qaRequired 的工单给 pass 时必须给，且 checklist 每一条都要有一项，'
                                        + 'item 与 checklist 原文一致、passed 是布尔；缺项会返回 QA_CHECKS_REQUIRED，格式不对返回 INVALID_CHECKS。'
                                        + '没开 qaRequired 的工单可以不填。',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            item: { type: 'string', description: '验收清单里的哪一条，建议照抄原文。' },
                                            passed: { type: 'boolean', description: '这一条过没过；必须是 true 或 false。' },
                                            note: { type: 'string', description: '补充说明：证据、失败原因或留给下一位的提示。' },
                                        },
                                        required: ['item', 'passed'],
                                        additionalProperties: false,
                                    },
                                },
                            },
                            required: ['order', 'verdict'],
                            additionalProperties: false,
                        },
                    },
                    rework: {
                        type: 'boolean',
                        description: '打回是否真的返工，默认 true。只想记录结论不想再跑一轮时传 false。',
                    },
                },
                required: ['verdicts'],
                additionalProperties: false,
            },
            isConcurrencySafe: () => false,
            presentCall(args) {
                const count = Array.isArray(args?.verdicts) ? args.verdicts.length : 0;
                const failed = Array.isArray(args?.verdicts) ? args.verdicts.filter(v => v?.verdict === 'fail').length : 0;
                return {
                    card: 'generic',
                    title: `包工头验收 · ${count} 单（打回 ${failed}）`,
                    kind: 'execute',
                    rawInput: { runId: args?.runId ?? '', failed },
                };
            },
            async execute(args, exec) {
                const run = engine.requireRun(typeof args?.runId === 'string' ? args.runId : '', sessionKeyOf(exec));
                const updated = await engine.review({
                    run,
                    verdicts: args?.verdicts ?? [],
                    rework: args?.rework !== false,
                    parent: exec.agent,
                    signal: exec?.signal,
                });
                return {
                    ok: true,
                    runId: updated.id,
                    status: updated.status,
                    summary: engine.renderBoard(updated, { withOutput: true }),
                    orders: updated.orders.map(orderRow),
                };
            },
            output: {
                schema: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        runId: { type: 'string' },
                        status: { type: 'string' },
                        summary: { type: 'string' },
                        orders: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    actualRoute: {
                                        type: 'string',
                                        description: '从子会话头读回的真实路由（provider/model）；读不到时为空串。',
                                    },
                                    routeMismatch: {
                                        type: 'boolean',
                                        description: '名册声明与 actualRoute 不一致时为 true；名册留空时恒为 false。',
                                    },
                                    routeNote: {
                                        type: 'string',
                                        description: '路由诊断说明；非空表示读不到子会话模型头。',
                                    },
                                    qaRequired: {
                                        type: 'boolean',
                                        description: '是否要求逐项验收；为 true 时 foreman_review 的 pass 必须带齐 checks。',
                                    },
                                    budget: {
                                        type: 'object',
                                        description: '提示级预算约定；没有声明时为 null。',
                                        properties: {
                                            maxToolCalls: { type: 'integer' },
                                            maxRetries: { type: 'integer' },
                                            stopCondition: { type: 'string' },
                                        },
                                    },
                                    checkResults: {
                                        type: 'array',
                                        description: '逐项验收结果；没开 qaRequired 或还没验收时为空数组。',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                item: { type: 'string' },
                                                passed: { type: 'boolean' },
                                                note: { type: 'string' },
                                            },
                                        },
                                    },
                                    usage: {
                                        type: 'object',
                                        description: '宿主投影的 token 读数（inputTokens/outputTokens/totalTokens）；拿不到时为 null，不是子会话自报。',
                                        properties: {
                                            inputTokens: { type: 'integer' },
                                            outputTokens: { type: 'integer' },
                                            totalTokens: { type: 'integer' },
                                        },
                                    },
                                    deliveryRedo: {
                                        type: 'object',
                                        description: '交付摘要超过 2000 字时的自动重出记录；没触发时为 null。',
                                        properties: {
                                            firstChars: { type: 'integer' },
                                            secondChars: { type: 'integer' },
                                            note: { type: 'string' },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    required: ['ok', 'runId', 'status', 'summary', 'orders'],
                },
                render: (_args, value) => [{ type: 'text', text: value.summary }],
            },
        },
        {
            name: 'foreman_status',
            description: '回看一轮派单的看板（不含全文产物时只给摘要）。用于确认状态、或者派单结果被上下文截断后重新取。'
                + '省略 runId 取本会话最近一轮。'
                + '只在用户敲了 `/foreman` 或明确让你派单时才用。',
            parameters: {
                type: 'object',
                properties: {
                    runId: { type: 'string', description: '派单 id；省略取最近一轮。' },
                    withOutput: { type: 'boolean', description: '是否带上每单的交付正文，默认 false。' },
                },
                additionalProperties: false,
            },
            isConcurrencySafe: () => true,
            async execute(args, exec) {
                const run = engine.requireRun(typeof args?.runId === 'string' ? args.runId : '', sessionKeyOf(exec));
                return {
                    ok: true,
                    runId: run.id,
                    status: run.status,
                    summary: engine.renderBoard(run, { withOutput: args?.withOutput === true }),
                    orders: run.orders.map(orderRow),
                };
            },
            output: {
                schema: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        runId: { type: 'string' },
                        status: { type: 'string' },
                        summary: { type: 'string' },
                        orders: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    actualRoute: {
                                        type: 'string',
                                        description: '从子会话头读回的真实路由（provider/model）；读不到时为空串。',
                                    },
                                    routeMismatch: {
                                        type: 'boolean',
                                        description: '名册声明与 actualRoute 不一致时为 true；名册留空时恒为 false。',
                                    },
                                    routeNote: {
                                        type: 'string',
                                        description: '路由诊断说明；非空表示读不到子会话模型头。',
                                    },
                                    qaRequired: {
                                        type: 'boolean',
                                        description: '是否要求逐项验收；为 true 时 foreman_review 的 pass 必须带齐 checks。',
                                    },
                                    budget: {
                                        type: 'object',
                                        description: '提示级预算约定；没有声明时为 null。',
                                        properties: {
                                            maxToolCalls: { type: 'integer' },
                                            maxRetries: { type: 'integer' },
                                            stopCondition: { type: 'string' },
                                        },
                                    },
                                    checkResults: {
                                        type: 'array',
                                        description: '逐项验收结果；没开 qaRequired 或还没验收时为空数组。',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                item: { type: 'string' },
                                                passed: { type: 'boolean' },
                                                note: { type: 'string' },
                                            },
                                        },
                                    },
                                    usage: {
                                        type: 'object',
                                        description: '宿主投影的 token 读数（inputTokens/outputTokens/totalTokens）；拿不到时为 null，不是子会话自报。',
                                        properties: {
                                            inputTokens: { type: 'integer' },
                                            outputTokens: { type: 'integer' },
                                            totalTokens: { type: 'integer' },
                                        },
                                    },
                                    deliveryRedo: {
                                        type: 'object',
                                        description: '交付摘要超过 2000 字时的自动重出记录；没触发时为 null。',
                                        properties: {
                                            firstChars: { type: 'integer' },
                                            secondChars: { type: 'integer' },
                                            note: { type: 'string' },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    required: ['ok', 'runId', 'status', 'summary', 'orders'],
                },
                render: (_args, value) => [{ type: 'text', text: value.summary }],
            },
        },
        {
            name: 'foreman_report',
            description: '承包商用它主动上报本单的交付摘要。干完之后调用一次，把结论写进来；宿主读不到你的会话正文时，这是唯一的回收通道。',
            parameters: {
                type: 'object',
                properties: {
                    orderId: { type: 'string', description: '工单 id' },
                    output: { type: 'string', description: '交付摘要' },
                    runId: { type: 'string', description: '照工单填写运行 id' },
                    attempt: { type: 'integer', minimum: 1, description: '照工单填写尝试次数' },
                    token: { type: 'string', description: '照工单填写本次上报令牌' },
                },
                required: ['orderId', 'output'],
                additionalProperties: false,
            },
            isConcurrencySafe: () => true,
            async execute(args, exec) {
                const result = engine.reportOrderOutput(String(args?.orderId ?? ''), String(args?.output ?? ''), { runId: args?.runId, attempt: args?.attempt, token: args?.token, sessionId: exec?.agent?.session?.id });
                if (result?.ok !== true)
                    throw new Error(result?.reason ?? '上报失败');
                return { ok: true, runId: result.runId, orderId: result.orderId };
            },
            output: {
                schema: {
                    type: 'object',
                    properties: {
                        ok: { type: 'boolean' },
                        runId: { type: 'string' },
                        orderId: { type: 'string' },
                    },
                    required: ['ok', 'runId', 'orderId'],
                },
                render: (_args, value) => [{ type: 'text', text: `已上报 ${value.orderId}（${value.runId}）` }],
            },
        },
    ];
}

/**
 * 给系统提示补一小段使用说明。
 *
 * 不注入 persona、不改 DEPLOYMENT 段落——只告诉父模型"什么时候该想起包工头"，
 * 这是工具发现性的问题，不是身份问题。
 *
 * @returns 提示词片段。
 */
export function foremanGuidance() {
    return [
        '## 包工头（dsh-agent-foreman）',
        '',
        '当任务可以拆成几件互不重叠、能分别验证的活时，优先走包工头而不是自己一件件做：',
        '',
        '1. `foreman_roster` 看一眼名册，确认承包商、模型与忙闲（名册为空就先让用户去设置页添加）。',
        '2. 自己拆单：每张工单写清背景、要动的文件、验收标准。子智能体看不到本会话上下文，工单必须自足。',
        '3. `foreman_dispatch` 一次派完，拿回看板与每单的交付摘要。**默认不写 `contractor`**：省略时按实时负载挑人，'
            + '跳过正忙的、取最空闲的，跨会话可见——多会话共用一支队伍时才不会都抢同一个人。只有必须指定某人才写名字。',
        '4. 逐单对照验收标准收活：`foreman_review` 给 pass；不合格的给 fail 并写清理由，会自动返工。',
        '',
        '你自己仍然是负责人：不要把自己的判断（"这里设计得对不对"）外包出去，只把可交付的活派出去。',
        '',
        '和 DSH 原生「智能体团队」的关系：原生编队提供持久 teammate、peer 消息与共享任务板；包工头补的是**按模型派单 + 逐单独立验收 + 返工闭环**，两者并存互补，不要用它替代原生团队。',
        '',
        '注意：派出去的子智能体继承当前工作目录，但看不到你的对话；不要让两张工单改同一批文件。给工单写 writeScopes（仅提示）与 checklist（验收清单），验收时照单核对，做的人不自己签收。',
    ].join('\n');
}

/** 供 index 复用的错误类型。 */
export { ForemanError };
