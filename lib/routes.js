/**
 * 包工头 · HTTP 表面。
 *
 * 三条路由类别：页面、名册读写、目录查询。它们都挂在宿主 `webServer` 的
 * `/plugins/dsh-agent-foreman` 前缀下，**在宿主自己的 `/api` 载体之外**——
 * 也就是说宿主的浏览器鉴权中间件看不到它们。所以这里的写接口必须自带
 * 跨站防护，否则任何网页都能 POST 过来改写名册。
 *
 * 防护分两层（与 dsh-cursor-dev 的 fence 同一思路）：
 *
 * 1. 优先问宿主的 `connection.requestRejection(req)`，它知道受信 authority 列表；
 * 2. 宿主没有 `connection` 服务时退回到本地规则：Host 必须是环回地址，
 *    `Sec-Fetch-Site: cross-site` 直接拒绝，有 `Origin` 时其 host 必须与 Host 一致。
 *
 * 只采纳 403，不采纳 401：面板本来就不需要浏览器登录态（这是它能在 iframe 里
 * 直接显示的原因），加了鉴权反而会让它变成一块空白。
 *
 * @module dsh-agent-foreman/routes
 */
import { ForemanError } from './store.js';
import { renderPage } from './page.js';
import { readCatalog, readEfforts, readSubagentProviders } from './catalog.js';

/** 路由前缀；package 的客户端半边也用它。 */
export const ROUTE_PREFIX = '/plugins/dsh-agent-foreman';

/** 写接口的请求体上限，名册这种规模 64KB 都嫌多。 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * 判断 Host 是否环回。
 * @param host - `req.headers.host`。
 * @returns 是否只可能是本机。
 */
function isLoopbackHost(host) {
    if (typeof host !== 'string' || host === '')
        return false;
    const bare = host.startsWith('[')
        ? host.slice(1, host.indexOf(']'))
        : host.replace(/:\d+$/, '');
    return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
}

/**
 * 本地兜底规则：这一步只处理"浏览器形状"的跨站请求。
 * @param req - HTTP 请求。
 * @returns 拒绝理由，放行时返回 undefined。
 */
function localRejection(req) {
    const headers = req?.headers ?? {};
    const site = headers['sec-fetch-site'];
    if (site === 'cross-site')
        return 'cross-site request refused';
    if (!isLoopbackHost(headers.host))
        return 'non-loopback host refused';
    const origin = headers.origin;
    if (typeof origin === 'string' && origin !== '') {
        try {
            if (new URL(origin).host !== headers.host)
                return 'origin does not match host';
        }
        catch {
            return 'unparsable origin';
        }
    }
    return undefined;
}

/**
 * 造一个 `(req, res) => boolean` 门卫：false 表示响应已经写完，handler 不要跑。
 * @param ctx - cordis 上下文。
 * @returns 门卫函数。
 */
/**
 * 团队服务可达性探针。
 *
 * 插件作用域和宿主团队服务不一定同域，取不到时会静默退回普通模式，
 * 所以把两条查找路径的结果都摊开，重启后看一眼就知道卡在哪。
 *
 * @param ctx - 插件上下文。
 * @returns 两条路径各自拿到的服务形态。
 */
/** 探针失败不能连累整个 state 接口。 */
function safe(read) {
    try {
        return read();
    }
    catch (error) {
        return { error: String(error instanceof Error ? error.message : error) };
    }
}

function remoteSelectModel(ctx) {
    for (const scope of [ctx, ctx?.root]) {
        try {
            const value = typeof scope?.remote?.session?.selectModel;
            if (value !== 'undefined')
                return value;
        }
        catch {
            // 没 inject。
        }
    }
    return 'missing';
}

function teamProbe(ctx) {
    const describe = (scope) => {
        try {
            const service = scope?.get?.('agentTeams');
            if (service === undefined || service === null)
                return 'missing';
            return {
                spawn: typeof service.spawnTeammate,
                send: typeof service.sendMessage,
                list: typeof service.listMembers,
            };
        }
        catch (error) {
            return `error: ${String(error?.message ?? error)}`;
        }
    };
    const capability = (name, member) => {
        for (const scope of [ctx, ctx?.root]) {
            try {
                const service = scope?.get?.(name);
                if (service !== undefined && service !== null)
                    return `${typeof service?.[member]}`;
            }
            catch {
                // 换下一个作用域。
            }
        }
        return 'missing';
    };
    return {
        ctx: describe(ctx),
        root: describe(ctx?.root),
        hasRoot: ctx?.root !== undefined,
        agentsGet: capability('agents', 'get'),
        sessionsGet: capability('sessions', 'get'),
        selectModel: capability('sessions', 'selectModel'),
        remoteSelectModel: remoteSelectModel(ctx),
        controllerSelectModel: capability('sessionController', 'selectModel'),
        subagentsWait: capability('subagents', 'waitForChildren'),
    };
}

export function createFence(ctx) {
    return (req, res) => {
        let rejection;
        try {
            const connection = ctx.get('connection');
            if (typeof connection?.requestRejection === 'function') {
                const verdict = connection.requestRejection(req);
                if (verdict === 403)
                    rejection = 'the host refused this request as cross-site';
            }
        }
        catch {
            // 宿主自己判定失败时退回本地规则，不影响面板。
        }
        rejection ??= localRejection(req);
        if (rejection === undefined)
            return true;
        sendJson(res, 403, { ok: false, error: rejection });
        return false;
    };
}

/**
 * 写 JSON 响应。
 * @param res - HTTP 响应。
 * @param status - 状态码。
 * @param payload - 可序列化对象。
 */
function sendJson(res, status, payload) {
    const text = JSON.stringify(payload);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(text);
}

/**
 * 读 JSON 请求体。
 * @param req - HTTP 请求。
 * @returns 解析结果；空体返回 `{}`。
 */
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new ForemanError('请求体过大', 'BODY_TOO_LARGE'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (text === '') {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(text));
            }
            catch {
                reject(new ForemanError('请求体不是合法 JSON', 'INVALID_BODY'));
            }
        });
        req.on('error', error => reject(error));
    });
}

/**
 * 挂载全部路由。返回一个释放函数，宿主 fiber 卸载时调用。
 *
 * @param ctx - cordis 上下文（已注入 webServer）。
 * @param deps - `{ store, logger }`。
 * @returns 释放函数；webServer 缺失时是空函数。
 */
export function mountRoutes(ctx, { store, engine, logger }) {
    const server = ctx.get('webServer');
    if (server === undefined || typeof server.register !== 'function') {
        logger?.warn?.('dsh-agent-foreman: webServer 不可用，设置页不会挂载');
        return () => {};
    }
    const fence = createFence(ctx);
    const releases = [];

    /**
     * 注册一条路由，并把错误统一翻译成 JSON。
     * @param path - 精确路径。
     * @param handler - 业务处理函数。
     */
    const route = (path, handler) => {
        const wrapped = async (req, res) => {
            if (!fence(req, res))
                return;
            try {
                await handler(req, res);
            }
            catch (error) {
                const code = error instanceof ForemanError ? error.code : 'INTERNAL';
                const message = error instanceof Error ? error.message : String(error);
                if (code === 'INTERNAL')
                    logger?.error?.(`dsh-agent-foreman: ${path} 失败 — ${message}`);
                if (!res.writableEnded)
                    sendJson(res, code === 'INTERNAL' ? 500 : 400, { ok: false, error: message, code });
            }
        };
        try {
            releases.push(server.register({ kind: 'exact', path, handler: wrapped }));
        }
        catch (error) {
            logger?.error?.(`dsh-agent-foreman: 注册路由 ${path} 失败 — ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    /** 设置页本身。 */
    const page = (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(renderPage());
    };
    route(ROUTE_PREFIX, page);
    route(`${ROUTE_PREFIX}/`, page);

    /**
     * 诊断：团队成员各自会话里的模型（`memberView` 只回 lead 的模型，
     * 想确认 `selectModel` 到底生效没有只能看会话头）。
     */
    route(`${ROUTE_PREFIX}/api/team-debug`, (_req, res) => {
        const sessions = ctx.get('sessions');
        const members = (engine?.teamSnapshot?.() ?? []).map((entry) => {
            let header;
            try {
                header = sessions?.get?.(entry.sessionId)?.header;
            }
            catch {
                header = undefined;
            }
            return {
                contractorId: entry.contractorId,
                name: entry.name,
                sessionId: entry.sessionId,
                provider: header?.provider,
                model: header?.model,
                reasoningEffort: header?.reasoningEffort,
                switchStatus: entry.switchStatus,
                switchDetail: entry.switchDetail,
            };
        });
        sendJson(res, 200, { ok: true, members });
    });

    /** 名册 + 策略 + 台账，一次拿全，面板只发一个请求。 */
    route(`${ROUTE_PREFIX}/api/state`, (_req, res) => {
        const { members, policy } = store.snapshot();
        sendJson(res, 200, {
            ok: true,
            members,
            policy,
            runs: store.recentRuns(10),
            subagentProviders: readSubagentProviders(ctx),
            teamProbe: safe(() => teamProbe(ctx)),
        });
    });

    /**
     * 聊天里那块「成员」面板要的实时状态：包工头在不在跑、每个承包商在不在跑、
     * 本轮有哪些共享任务。会话里还没派过单时 `run` 为 null，面板据此显示空态。
     */
    route(`${ROUTE_PREFIX}/api/live`, (req, res) => {
        const url = new URL(`http://localhost${req.url ?? '/'}`);
        const session = url.searchParams.get('session') ?? '';
        const members = store.members();
        // 会话 id 对不上时（例如宿主换了会话键的写法）退回到全局最近一轮，
        // 面板上注明「不是本会话」，总比整块空白强。
        let run = engine?.latestRun?.(session) ?? undefined;
        let matched = run !== undefined;
        if (run === undefined && session !== '') {
            run = engine?.latestRun?.('') ?? undefined;
            matched = false;
        }
        const busy = new Map();
        for (const order of run?.orders ?? []) {
            if (order.status === 'running')
                busy.set(order.contractorName, (busy.get(order.contractorName) ?? 0) + 1);
        }
        const working = run !== undefined && (run.status === 'running' || run.status === 'rework');
        sendJson(res, 200, {
            ok: true,
            session,
            lead: {
                name: '包工头',
                status: working ? 'running' : 'inactive',
                waiting: run !== undefined && run.status === 'waiting-review',
            },
            members: members.map(member => ({
                id: member.id,
                name: member.name,
                role: member.role,
                specialty: member.specialty,
                maxParallel: member.maxParallel,
                model: member.provider === '' ? '' : `${member.provider}/${member.model}`,
                enabled: member.enabled !== false,
                status: busy.has(member.name) ? 'running' : 'inactive',
                orders: run?.orders.filter(order => order.contractorName === member.name).length ?? 0,
            })),
            run: run === undefined ? null : {
                id: run.id,
                matched,
                goal: run.goal,
                status: run.status,
                orders: run.orders.map(order => ({
                    id: order.id,
                    title: order.title,
                    contractor: order.contractorName ?? '',
                    status: order.status,
                    verdict: order.verdict ?? '',
                })),
            },
        });
    });

    /** 模型目录（provider → 模型）。 */
    route(`${ROUTE_PREFIX}/api/catalog`, async (_req, res) => {
        sendJson(res, 200, await readCatalog(ctx));
    });

    /** 单个模型的推理等级；等级随模型而异，所以按需查。 */
    route(`${ROUTE_PREFIX}/api/efforts`, async (req, res) => {
        const url = new URL(`http://localhost${req.url ?? '/'}`);
        const provider = url.searchParams.get('provider') ?? '';
        const model = url.searchParams.get('model') ?? '';
        if (provider === '' || model === '') {
            sendJson(res, 400, { ok: false, error: '需要 provider 与 model' });
            return;
        }
        sendJson(res, 200, { ok: true, ...(await readEfforts(ctx, provider, model)) });
    });

    /** 整体保存名册（面板的保存语义就是整体替换）。 */
    route(`${ROUTE_PREFIX}/api/members`, async (req, res) => {
        if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '只接受 POST' });
            return;
        }
        const body = await readJsonBody(req);
        const members = store.saveMembers(body?.members ?? []);
        sendJson(res, 200, { ok: true, members, policy: store.policy() });
    });

    /** 保存策略字段。 */
    route(`${ROUTE_PREFIX}/api/policy`, async (req, res) => {
        if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '只接受 POST' });
            return;
        }
        const body = await readJsonBody(req);
        const policy = store.savePolicy(body ?? {});
        sendJson(res, 200, { ok: true, policy });
    });

    return () => {
        for (const release of releases) {
            try {
                release?.();
            }
            catch {
                // 卸载期的重复释放可以忽略。
            }
        }
        releases.length = 0;
    };
}
