/**
 * Compatibility adapter for the native Agent Teams roster in DSH 0.2.1-rc.5.
 *
 * spawnTeammate delegates to roster.spawn, which reads this.ctx.subagents. The
 * host currently omits agentOptions when constructing its activation request.
 * Give only THIS invocation a scoped context, forwarding the native request to
 * the real subagent service with its original authority, reserved child id, and
 * lifecycle. The persisted child descriptor therefore contains the chosen route.
 * No shared service, method, parent options, or application defaults are changed.
 *
 * This is a guarded compatibility bridge, not a public upstream model API. If
 * the host shape changes, fail visibly before accepting a work order.
 */
export class NativeTeamRoutingError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NativeTeamRoutingError';
        this.code = 'NATIVE_TEAM_ROUTING_UNSUPPORTED';
    }
}

export function nativeRoutingAvailable(teams) {
    try {
        return typeof teams?.spawnTeammate === 'function'
            && typeof teams?.roster?.spawn === 'function'
            && typeof teams?.roster?.ctx?.subagents?.startActivation === 'function';
    }
    catch {
        return false;
    }
}

export async function spawnNativeTeammate({ teams, parent, request, agentOptions, maxDepth }) {
    if (agentOptions !== undefined && (typeof agentOptions.provider !== 'string'
        || agentOptions.provider.trim() === '' || typeof agentOptions.model !== 'string'
        || agentOptions.model.trim() === ''))
        throw new NativeTeamRoutingError('成员模型必须同时提供非空 provider 和 model');
    if (agentOptions === undefined && maxDepth === undefined)
        return teams.spawnTeammate(parent, request);
    if (!nativeRoutingAvailable(teams))
        throw new NativeTeamRoutingError('当前宿主不支持原生团队模型路由适配；未创建替代子会话，也未退回父模型');

    const roster = teams.roster;
    const hostContext = roster.ctx;
    const subagents = hostContext.subagents;
    const originalStart = subagents.startActivation;
    let forwarded = false;
    const scopedSubagents = new Proxy(subagents, {
        get(target, key) {
            if (key === 'startActivation') {
                return spec => {
                    // Route only the native reserved-child creation for this
                    // exact caller and prompt. Never affect another activation.
                    if (forwarded || spec?.request?.parent !== parent
                        || spec?.request?.prompt !== request.prompt
                        || typeof spec?.childId !== 'string' || spec.childId === ''
                        || spec.delivery !== 'parent' || spec.provider !== request.provider)
                        throw new NativeTeamRoutingError('原生建队调用契约已改变，拒绝给不匹配的激活注入模型');
                    forwarded = true;
                    return originalStart.call(target, {
                        ...spec,
                        request: {
                            ...spec.request,
                            ...(agentOptions === undefined ? {} : { agentOptions: { ...agentOptions } }),
                            ...(maxDepth === undefined ? {} : { maxDepth }),
                        },
                    });
                };
            }
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const scopedContext = new Proxy(hostContext, {
        get(target, key) {
            if (key === 'subagents')
                return scopedSubagents;
            // Preserve the actual Cordis receiver for other services/getters.
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const scopedRoster = new Proxy(roster, {
        get(target, key, receiver) {
            return key === 'ctx' ? scopedContext : Reflect.get(target, key, receiver);
        },
    });
    const scopedTeams = new Proxy(teams, {
        get(target, key, receiver) {
            return key === 'roster' ? scopedRoster : Reflect.get(target, key, receiver);
        },
    });
    const created = await teams.spawnTeammate.call(scopedTeams, parent, request);
    if (!forwarded)
        throw new NativeTeamRoutingError('宿主未经过已验证的原生建队路径，未确认模型；拒绝投递工单');
    return created;
}
