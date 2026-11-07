/**
 * 包工头 · 模型目录读取。
 *
 * 承包商的名字只是标签，真正决定"谁干活"的是 provider + 模型。设置页要能下拉
 * 出宿主机真实在用的目录，所以这里直接问 `llm` 服务，不维护第二份清单。
 *
 * 三个已知的宿主约束，这里的代码都绕开了：
 *
 * 1. `listModels()` 不带推理等级——等级只在 `resolveModelInfo()` 里，而且那是
 *    一次按模型的异步查询。所以等级走单独端点，等用户选了模型才查。
 * 2. 某个 provider 的目录可能整个失败（没配 key、网关不通）。一个 provider 挂掉
 *    不应该让整个下拉框变空，因此逐个捕获，把错误挂在该 provider 上返回。
 * 3. `llm` 可能根本不存在（无头 profile）。这时返回空目录而不是抛错，设置页会
 *    退化成手填输入框。
 *
 * @module dsh-agent-foreman/catalog
 */

/**
 * 取 LLM 服务；缺失时返回 undefined（`get()` 不会因未 inject 而抛）。
 * @param ctx - cordis 上下文。
 */
function llmOf(ctx) {
    try {
        const llm = ctx.get('llm');
        return typeof llm?.listProviders === 'function' ? llm : undefined;
    }
    catch {
        return undefined;
    }
}

/**
 * 列出宿主当前注册的 provider。
 * @param ctx - cordis 上下文。
 * @returns `{ id, name }[]`，缺失服务时为空数组。
 */
export function readProviders(ctx) {
    const llm = llmOf(ctx);
    if (llm === undefined)
        return [];
    try {
        const providers = llm.listProviders();
        return Array.isArray(providers)
            ? providers.map(provider => ({ id: String(provider.id), name: String(provider.name ?? provider.id) }))
            : [];
    }
    catch {
        return [];
    }
}

/**
 * 读取完整目录：每个 provider 及其模型。
 *
 * 串行而不是并发，因为适配器的 `listModels` 大多要打一次远端接口，而目录读取
 * 只在打开设置页时发生一次——并发省不下多少时间，却会把某个坏网关的错误放大
 * 成一片超时。
 *
 * @param ctx - cordis 上下文。
 * @returns `{ providers: [{ id, name, models, error? }], fetchedAt }`。
 */
export async function readCatalog(ctx) {
    const llm = llmOf(ctx);
    if (llm === undefined)
        return { providers: [], fetchedAt: new Date().toISOString(), unavailable: true };
    const providers = readProviders(ctx);
    const out = [];
    for (const provider of providers) {
        try {
            const models = await llm.listModels(provider.id);
            out.push({
                ...provider,
                models: Array.isArray(models)
                    ? models.map(model => ({ id: String(model.id), name: String(model.name ?? model.id) }))
                    : [],
            });
        }
        catch (error) {
            out.push({ ...provider, models: [], error: error instanceof Error ? error.message : String(error) });
        }
    }
    return { providers: out, fetchedAt: new Date().toISOString() };
}

/**
 * 读取单个模型的推理等级。等级随模型而异，不能拿父会话的等级硬套。
 * @param ctx - cordis 上下文。
 * @param provider - provider id。
 * @param model - 模型 id。
 * @returns `{ efforts: [{ id, name }], defaultEffort? }`；查不到时为空。
 */
export async function readEfforts(ctx, provider, model) {
    const llm = llmOf(ctx);
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function')
        return { efforts: [] };
    try {
        const info = await llm.resolveModelInfo(provider, model, undefined);
        const efforts = Array.isArray(info?.reasoning?.efforts)
            ? info.reasoning.efforts.map(effort => ({ id: String(effort.id), name: String(effort.name ?? effort.id) }))
            : [];
        const defaultEffort = info?.reasoning?.defaultEffort;
        return typeof defaultEffort === 'string' ? { efforts, defaultEffort } : { efforts };
    }
    catch {
        return { efforts: [] };
    }
}

/**
 * 宿主实际注册的 subagents provider 名。
 *
 * 优先用宿主公开的 `list()`（DSH 0.2.2-rc.1 起 `SubagentRuntime.list()` 返回
 * 注册顺序里的 provider 名），它既能发现自定义名字，也不依赖内部字段。旧宿主
 * 没有这个公开方法时再退回 `providers` Map，最后才是按已知名字猜——每一层都是
 * 可选降级，服务尚未就绪时返回空数组，由调用方回退到配置里的默认名。
 *
 * @param ctx - cordis 上下文。
 * @returns provider 名数组。
 */
export function readSubagentProviders(ctx) {
    try {
        const service = ctx.get('subagents');
        if (service === undefined || service === null)
            return [];
        // 公开 API 优先：不碰内部 Map，也能读到用户自定义 provider 名。
        if (typeof service.list === 'function') {
            const names = service.list();
            if (Array.isArray(names))
                return names.map(String).filter(name => name !== '');
        }
        // 旧宿主：读公开的 Map（审计工具也这么读）。
        const providers = service.providers;
        if (providers instanceof Map)
            return [...providers.keys()].map(String).filter(name => name !== '');
        // 最后一层：只按已知名字探测，猜不到就交给调用方的默认值。
        if (typeof service.getProvider === 'function') {
            const names = [];
            for (const candidate of ['spawn', 'cursor', 'acp', 'external'])
                if (service.getProvider(candidate) !== undefined)
                    names.push(candidate);
            return names;
        }
        return [];
    }
    catch {
        return [];
    }
}
