/**
 * 包工头 · 子智能体模型白名单同步。
 *
 * ## 为什么需要这一层
 *
 * 宿主有一个单例服务 `subagentModelSelection`（`@deepseek-ai/dsh-tool-subagent`
 * 的 `SubagentModelSelectionConfig`），它持有两份 volatile 配置：
 *
 * - `enabled: boolean`
 * - `allowedModels: { provider, model }[]`
 *
 * `dsh-tool-subagent` 在**会话首次建立时**读一次 `current()`，把结果快照进该会话的
 * `subagent/model-selection-policy` 投影，之后这个会话只认那份快照。也就是说：
 * 白名单和会话设置页里"名册"是两份独立维护的清单，一旦不一致，派单就会悄悄
 * 退化——父智能体以为派给了名册里那档模型，实际跑的是宿主白名单放行的那些。
 *
 * 用户的选择是**让名册成为唯一来源**：名册里每个启用的承包商都带 provider/model，
 * 那这些就是"应该能派出去的模型"。于是这里把它们同步进 `allowedModels`，用户只
 * 维护名册一份。
 *
 * ## 怎么写进去
 *
 * `createVolatile()` 返回**冻结对象**，对外只有 `get()`；真正的写入通道是内部符号
 * `Symbol.for("cosmokit.volatile.write")`。这个符号是跨模块共享的（`Symbol.for`
 * 的注册表语义），所以即使宿主和我们各自打包了一份 cosmokit，拿到的也是同一个键。
 *
 * cosmokit 导出的 `updateVolatile(target, source)` 实现就是 `target[write](source.get())`。
 * 因此有两条等价路径，优先用官方函数，解析不到就按符号手工构造一个只带 `get()` 的
 * 源对象——两条路径都包在 try/catch 里，宿主换了实现也只会降级成"同步失败"，
 * 不会把插件带崩。
 *
 * ## 空名册的坑
 *
 * `SubagentModelSelectionConfig.current()` 在 `enabled && allowedModels.length === 0`
 * 时**直接抛错**。所以名册里一条显式路由都没有时，绝不能把 `allowedModels` 写成空
 * 数组——那会让宿主每次给会话定策略都炸。策略是保持宿主原配置不动。
 *
 * @module dsh-agent-foreman/whitelist
 */
import { createRequire } from 'node:module';

/** volatile 的写入符号；用 `Symbol.for` 保证跨模块（跨 cosmokit 副本）一致。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/**
 * 解析到的 `updateVolatile`，只探一次。
 * @type {((target: object, source: { get: () => unknown }) => void) | undefined}
 */
let cachedUpdateVolatile;
/** 是否已经探过（探不到就别每次都 createRequire 一遍）。 */
let probed = false;

/**
 * 懒加载 cosmokit 的 `updateVolatile`。
 *
 * 走 `createRequire` 而不是静态 `import`：插件环境的 node_modules 与宿主不一定
 * 同源，静态 import 解析失败会让整个模块加载不了，那就不只是"同步不可用"了。
 *
 * @returns updateVolatile，取不到时返回 undefined。
 */
function updateVolatileOf() {
    if (probed)
        return cachedUpdateVolatile;
    probed = true;
    try {
        const require = createRequire(import.meta.url);
        const mod = require('@deepseek-ai/cosmokit');
        if (typeof mod?.updateVolatile === 'function')
            cachedUpdateVolatile = mod.updateVolatile;
    }
    catch {
        // 解析不到就走符号路径，属于预期分支，不必吵。
        cachedUpdateVolatile = undefined;
    }
    return cachedUpdateVolatile;
}

/**
 * 判断一个值是不是可以写进去的 volatile 引用。
 * @param value - 任意值。
 * @returns 是否带 `get()`。
 */
function isVolatileLike(value) {
    return typeof value === 'object' && value !== null && typeof value.get === 'function';
}

/** 从名册里挑出一条显式路由；缺字段返回 undefined。 */
function routeOf(member) {
    if (member === null || typeof member !== 'object')
        return undefined;
    if (member.enabled === false)
        return undefined;
    const provider = typeof member.provider === 'string' ? member.provider.trim() : '';
    const model = typeof member.model === 'string' ? member.model.trim() : '';
    if (provider === '' || model === '')
        return undefined;
    return { provider, model };
}

/**
 * 名册里所有显式路由，按 `provider\0model` 去重并保持名册顺序。
 *
 * 跳过 `enabled === false` 的成员（关掉的人不该继续占白名单），也跳过 provider /
 * model 不全的成员——那些是"继承父会话"的，不该被当成一条白名单路由写进去。
 *
 * @param members - 承包商数组。
 * @returns `{ provider, model }[]`，新的数组，调用方可以随意改。
 */
export function rosterRoutes(members) {
    if (!Array.isArray(members))
        return [];
    const routes = [];
    const seen = new Set();
    for (const member of members) {
        const route = routeOf(member);
        if (route === undefined)
            continue;
        const key = `${route.provider}\u0000${route.model}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        routes.push(route);
    }
    return routes;
}

/**
 * 往一个 volatile 引用里写值。
 *
 * 路径一：cosmokit 的 `updateVolatile(target, source)`，源对象只要带 `get()`；
 * 路径二：直接调引用上的写入符号。两者语义完全相同（前者就是后者的语法糖），
 * 留两条是因为插件环境里 cosmokit 可能解析不到。
 *
 * 写失败时抛错，由调用方（`syncWhitelist`）翻译成结果对象——这个函数本身是
 * "要么写成、要么抛"的诚实语义。
 *
 * @param volatileRef - 宿主持有的 volatile 引用。
 * @param value - 要写入的新值。
 * @returns 写入是否成功（当前实现成功即返回 true，失败抛错）。
 */
export function writeVolatile(volatileRef, value) {
    if (!isVolatileLike(volatileRef))
        throw new TypeError('volatile 引用必须带 get()');
    const update = updateVolatileOf();
    if (typeof update === 'function') {
        // 源对象只需要 get()，updateVolatile 内部就是 target[write](source.get())。
        update(volatileRef, { get: () => value });
        return true;
    }
    const write = volatileRef[VOLATILE_WRITE];
    if (typeof write !== 'function')
        throw new Error('volatile 引用不可写（缺少 cosmokit.volatile.write）');
    write(value);
    return true;
}

/** 读 volatile 当前值；读不到给 fallback。 */
function readVolatile(ref, fallback) {
    try {
        if (!isVolatileLike(ref))
            return fallback;
        const value = ref.get();
        return value === undefined ? fallback : value;
    }
    catch {
        return fallback;
    }
}

/** 从服务上取两份配置引用。 */
function refsOf(service) {
    const config = service?.config;
    const enabled = config?.enabled;
    const allowedModels = config?.allowedModels;
    if (!isVolatileLike(enabled) || !isVolatileLike(allowedModels))
        return undefined;
    return { enabled, allowedModels };
}

/** 两条路由是否同一条（provider + model 全等）。 */
function sameRoute(a, b) {
    return a?.provider === b?.provider && a?.model === b?.model;
}

/**
 * 造一份冻结的路由副本，用来交给宿主的 volatile。
 *
 * 返回值里的 `routes` 是就地构造的新数组，面板/日志都可能持有它；如果写进宿主的
 * 正好是同一个数组，一次 `routes[0].model = 'x'` 就能悄悄改掉宿主的配置。
 *
 * @param routes - 校验过的路由数组。
 * @returns 冻结副本。
 */
function frozenRoutes(routes) {
    return Object.freeze(routes.map(route => Object.freeze({ provider: route.provider, model: route.model })));
}

/**
 * 两组路由是否一致（同长度、同顺序、逐条 provider+model 相等）。
 *
 * 为什么连顺序也比：宿主把这份名单快照进会话投影，快照里带顺序；用户只是拖动
 * 了一下名册次序，会话里看到的清单也确实变了，面板标"未同步"更诚实。
 */
function sameRoutes(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i += 1) {
        if (!sameRoute(a[i], b[i]))
            return false;
    }
    return true;
}

/**
 * 把名册路由同步进宿主的 `subagentModelSelection`。
 *
 * 全流程 try/catch，**绝不抛给调用方**——它会在插件启动和保存名册时被顺手调用，
 * 任何一次抛错都会变成"设置页打不开"，代价远大于收益。失败通过返回值报告。
 *
 * @param ctx - cordis 上下文。
 * @param store - 名册存储（`members()` 可读）。
 * @param logger - 日志（可缺省）。
 * @returns `{ ok, changed?, routes?, previous?, reason? }`。
 */
export function syncWhitelist(ctx, store, logger) {
    try {
        let service;
        try {
            service = typeof ctx?.get === 'function' ? ctx.get('subagentModelSelection') : undefined;
            if (service === undefined && ctx?.root !== undefined)
                service = ctx.root.get?.('subagentModelSelection');
        }
        catch {
            // 没 inject 时某些宿主会抛；这等价于"服务不存在"。
            service = undefined;
        }
        // 宿主没装这个设置模块时静默跳过：这不是错误，只是没得同步。
        if (service === undefined || service === null)
            return { ok: false, reason: '宿主没有 subagentModelSelection 服务' };

        const refs = refsOf(service);
        if (refs === undefined)
            return { ok: false, reason: '宿主 subagentModelSelection 的 config 结构不认识' };

        const routes = rosterRoutes(typeof store?.members === 'function' ? store.members() : []);
        const previous = {
            enabled: readVolatile(refs.enabled, false) === true,
            allowedModels: readVolatile(refs.allowedModels, []),
        };

        // 空名册：保持宿主原配置。写成空数组会让宿主的 current() 直接抛错。
        if (routes.length === 0)
            return { ok: true, changed: false, routes, previous, reason: '名册里没有显式路由，保持宿主原配置' };

        try {
            // 顺序有讲究：先写名单再开开关。宿主的 `current()` 在
            // `enabled && allowedModels.length === 0` 时直接抛错，所以任何一次
            // 写失败都必须停在这个状态之外——名单没写成，开关就得留在原处。
            //
            // 写进去的是一份冻结副本：`createVolatile` 的写入通道只赋值不拷贝，
            // 若直接把 routes 交出去，返回值里的同一个数组就能反手改掉宿主配置。
            writeVolatile(refs.allowedModels, frozenRoutes(routes));
            writeVolatile(refs.enabled, true);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger?.warn?.(`dsh-agent-foreman: 写入子智能体白名单失败 — ${message}`);
            return { ok: false, reason: `写入宿主 volatile 失败 — ${message}`, routes, previous };
        }

        const changed = previous.enabled !== true || !sameRoutes(previous.allowedModels, routes);
        return { ok: true, changed, routes, previous };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger?.warn?.(`dsh-agent-foreman: 同步子智能体白名单失败 — ${message}`);
        return { ok: false, reason: `同步白名单失败 — ${message}` };
    }
}

/**
 * 只读地看一眼宿主白名单和名册对不对得上（设置页展示用）。
 *
 * **不做任何写入**：`/api/state` 是轮询接口，读一次就改一次配置属于惊吓式设计。
 * 用户想让它对齐就显式点同步，走 `POST /api/whitelist/sync`。
 *
 * @param ctx - cordis 上下文。
 * @param store - 名册存储（可缺省）。
 * @returns `{ enabled, allowedModels, synced, rosterRoutes }`。
 */
export function readWhitelist(ctx, store) {
    const empty = { enabled: false, allowedModels: [], synced: false, rosterRoutes: [] };
    try {
        const routes = rosterRoutes(typeof store?.members === 'function' ? store.members() : []);
        let service;
        try {
            service = typeof ctx?.get === 'function' ? ctx.get('subagentModelSelection') : undefined;
            if (service === undefined && ctx?.root !== undefined)
                service = ctx.root.get?.('subagentModelSelection');
        }
        catch {
            service = undefined;
        }
        const refs = refsOf(service);
        if (refs === undefined)
            return { ...empty, rosterRoutes: routes };
        const enabled = readVolatile(refs.enabled, false) === true;
        const allowedModels = readVolatile(refs.allowedModels, []);
        return {
            enabled,
            allowedModels,
            // "对得上" = 开着，且放行的路由集合正是名册里那些显式路由。
            synced: enabled && routes.length > 0 && sameRoutes(Array.isArray(allowedModels) ? allowedModels : [], routes),
            rosterRoutes: routes,
        };
    }
    catch {
        return empty;
    }
}
