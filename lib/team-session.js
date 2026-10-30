/** Normalize model evidence from the request that actually ran, not roster labels. */
export function routeFromSession(session) {
    let config;
    try { config = session?.requestHeader?.()?.config; } catch {}
    if (!config) {
        let events;
        try { events = session?.snapshotEvents?.(); } catch {}
        if (Array.isArray(events)) {
            for (let i = events.length - 1; i >= 0; i--) {
                if (events[i]?.type === 'request/header') { config = events[i].data?.header?.config; break; }
            }
        }
    }
    config ??= session?.header?.config;
    config ??= session?.header; // Older hosts/test fixtures.
    const provider = typeof config?.provider === 'string' ? config.provider : '';
    const model = typeof config?.model === 'string' ? config.model : '';
    if (!provider && !model) return undefined;
    return { provider, model, reasoningEffort: typeof config?.reasoningEffort === 'string' ? config.reasoningEffort : '' };
}

/** Observe live or dormant native children. Persistence is opened read-only. */
export async function observeTeamSession(ctx, sessionId, signal) {
    for (const name of ['sessions', 'agents']) {
        try {
            const service = ctx.get(name) ?? ctx.root?.get?.(name);
            const value = await service?.get?.(sessionId);
            const session = name === 'agents' ? value?.session : value;
            if (session) return session;
        } catch {}
    }
    let handle;
    try {
        const persistence = ctx.get('sessionPersistence') ?? ctx.root?.get?.('sessionPersistence');
        if (typeof persistence?.open !== 'function') return undefined;
        handle = await persistence.open(sessionId, 'read', { signal });
        const { events } = await handle.read(0, undefined, { signal });
        return { header: handle.header, snapshotEvents: () => events };
    } catch {
        return undefined;
    } finally {
        await handle?.close?.();
    }
}
