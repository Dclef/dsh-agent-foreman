import io

p = 'lib/client.js'
s = io.open(p, encoding='utf-8').read()

# ---------- 1. 换掉样式块 ----------
start = s.index('        const PANEL = {')
end = s.index('        /**\n         * 会话头部的「成员」按钮')
styles = '''        const PANEL = {
            position: 'fixed',
            zIndex: '90',
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            padding: '6px 2px 8px',
            maxHeight: 'min(62vh, 540px)',
            borderRadius: '12px',
            border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
            // 用不透明的层级色打底：宿主的 --dsw-specific-menu 是给带 backdrop-filter
            // 的伪元素当底色的半透明色，直接当 background 会透出对话正文。
            background: 'var(--dsw-alias-bg-layer-1, #232327)',
            boxShadow: '0 16px 40px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.28)',
            color: 'var(--dsw-alias-label-primary, #e8e8ea)',
            fontSize: '12px',
            textAlign: 'left',
            overflow: 'hidden',
        };
        const PANEL_BODY = {
            overflowY: 'auto',
            minHeight: '0',
            padding: '2px 12px 6px',
            scrollbarWidth: 'thin',
        };
        const TRIGGER = {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            padding: '3px 7px',
            minHeight: '28px',
            border: '0',
            borderRadius: '6px',
            background: 'transparent',
            color: 'var(--dsw-alias-label-tertiary, #9a9aa2)',
            fontSize: '12px',
            cursor: 'pointer',
        };
        const COUNT_PILL = {
            padding: '0 5px',
            borderRadius: '6px',
            background: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.18))',
            color: 'var(--dsw-alias-label-caption, #8b8b93)',
            fontSize: '11px',
            lineHeight: '16px',
            fontVariantNumeric: 'tabular-nums',
        };
        const SECTION_TITLE = {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            margin: '12px 0 8px',
            fontSize: '12px',
            fontWeight: '600',
            color: 'var(--dsw-alias-label-secondary, #b9b9c0)',
        };
        const CARD = {
            display: 'flex',
            alignItems: 'center',
            gap: '9px',
            padding: '8px 10px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22))',
            background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1))',
        };
        const DOT = { width: '8px', height: '8px', borderRadius: '50%', flex: 'none' };
        const SMALL = { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #9a9aa2)', lineHeight: '1.7' };
        const TAG = {
            marginLeft: 'auto',
            flex: 'none',
            padding: '0 6px',
            borderRadius: '6px',
            fontSize: '10px',
            lineHeight: '16px',
            color: 'var(--dsw-alias-label-tertiary, #9a9aa2)',
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28))',
        };
        /** 会话头的小人图标；跟原生 Agent Teams 的入口同一种语汇。 */
        function peopleIcon() {
            return h(
                'svg',
                {
                    width: '14',
                    height: '14',
                    viewBox: '0 0 16 16',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: '1.2',
                    strokeLinecap: 'round',
                    'aria-hidden': 'true',
                },
                h('path', { d: 'M6 7.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z' }),
                h('path', { d: 'M2.2 12.8c0-1.9 1.7-3.2 3.8-3.2s3.8 1.3 3.8 3.2' }),
                h('path', { d: 'M11.3 7.3a1.7 1.7 0 1 0 0-3.4' }),
                h('path', { d: 'M12.4 9.9c1 .4 1.6 1.4 1.6 2.7' }),
            );
        }

'''
s = s[:start] + styles + s[end:]

# ---------- 2. 换掉整个 MembersAction ----------
start = s.index('        function MembersAction({ sessionId }) {')
end = s.index('        /**\n         * 挂载客户端半边。')
component = '''        /**
         * 会话头部的「成员」按钮 + 浮层：包工头、承包商、本轮共享任务。
         *
         * 浮层用 `position: fixed` + 量出来的锚点坐标，而不是 `absolute`：会话头那一排
         * 容器带 overflow 裁切，absolute 会被裁掉一截，看起来就像浮层"嵌在对话里"。
         *
         * 数据来自宿主半边的 `/api/live`，每 2.5 秒拉一次；还没派过单时 `run` 是 null，
         * 拉不到时如实写"连不上"，不假装没有任务。
         *
         * @param props.sessionId - 宿主会话头座位注入的会话 id。
         */
        function MembersAction({ sessionId }) {
            const [open, setOpen] = react.useState(false);
            const [live, setLive] = react.useState(undefined);
            const [trouble, setTrouble] = react.useState(undefined);
            const [anchor, setAnchor] = react.useState(undefined);
            const rootRef = react.useRef(null);
            const triggerRef = react.useRef(null);
            const panelRef = react.useRef(null);

            const query = typeof sessionId === 'string' && sessionId !== ''
                ? `?session=${encodeURIComponent(sessionId)}`
                : '';
            react.useEffect(() => {
                let stopped = false;
                const load = () => {
                    fetch(`${LIVE_URL}${query}`, { headers: { accept: 'application/json' } })
                        .then(async (res) => {
                            if (!res.ok)
                                throw new Error(`HTTP ${res.status}`);
                            return await res.json();
                        })
                        .then((body) => {
                            if (stopped)
                                return;
                            setLive(body);
                            setTrouble(undefined);
                        })
                        .catch((error) => {
                            // 拉不到就说清楚拉不到：否则面板会装作"本轮没有任务"。
                            if (!stopped)
                                setTrouble(String(error?.message ?? error));
                        });
                };
                load();
                const timer = setInterval(load, 2500);
                return () => {
                    stopped = true;
                    clearInterval(timer);
                };
            }, [query]);

            /** 量触发器位置，把浮层贴在按钮下方、右对齐，并夹在视口里。 */
            const measure = () => {
                const trigger = triggerRef.current;
                if (trigger === null)
                    return;
                const rect = trigger.getBoundingClientRect();
                const margin = 12;
                const width = Math.min(360, window.innerWidth - margin * 2);
                const left = Math.min(
                    Math.max(margin, rect.right - width),
                    Math.max(margin, window.innerWidth - width - margin),
                );
                const top = Math.min(rect.bottom + 6, Math.max(margin, window.innerHeight - 140));
                setAnchor({ left, top, width });
            };

            react.useEffect(() => {
                if (!open) {
                    setAnchor(undefined);
                    return undefined;
                }
                measure();
                const onViewport = () => measure();
                window.addEventListener('resize', onViewport);
                window.addEventListener('scroll', onViewport, true);
                return () => {
                    window.removeEventListener('resize', onViewport);
                    window.removeEventListener('scroll', onViewport, true);
                };
            }, [open]);

            react.useEffect(() => {
                if (!open)
                    return undefined;
                const onDown = (event) => {
                    const root = rootRef.current;
                    const panel = panelRef.current;
                    const inside = (node) => node !== null && node.contains(event.target);
                    if (!inside(root) && !inside(panel))
                        setOpen(false);
                };
                document.addEventListener('mousedown', onDown);
                return () => document.removeEventListener('mousedown', onDown);
            }, [open]);

            const members = Array.isArray(live?.members) ? live.members : [];
            const orders = Array.isArray(live?.run?.orders) ? live.run.orders : [];
            const count = members.length + 1;

            const dot = (status) => h('span', {
                style: {
                    ...DOT,
                    background: status === 'running'
                        ? 'var(--dsw-alias-state-success-primary, #3fb950)'
                        : 'var(--dsw-alias-label-tertiary, #8b8b93)',
                },
            });

            const memberCard = (key, name, status, detail, tag) => h(
                'div',
                { key, style: CARD, title: detail },
                dot(status),
                h(
                    'span',
                    { style: { display: 'flex', flexDirection: 'column', minWidth: '0', gap: '1px' } },
                    h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: '500' } }, name),
                    h('span', { style: { ...SMALL, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, detail),
                ),
                tag === undefined ? null : h('span', { style: TAG }, tag),
            );

            const leadDetail = live?.lead?.waiting
                ? (zh() ? '等你验收' : 'awaiting your review')
                : (live?.lead?.status === 'running'
                    ? (zh() ? '正在调度' : 'dispatching')
                    : (zh() ? '未运行' : 'not running'));

            const body = h(
                'div',
                { style: PANEL_BODY },
                h('div', { style: SECTION_TITLE }, zh() ? '成员' : 'Members'),
                memberCard(
                    'lead',
                    live?.lead?.name ?? (zh() ? '包工头' : 'Foreman'),
                    live?.lead?.status,
                    leadDetail,
                    zh() ? '当前会话' : 'this session',
                ),
                ...members.map(member => memberCard(
                    `m:${member.name}`,
                    member.name,
                    member.enabled === false ? 'inactive' : member.status,
                    member.model !== ''
                        ? member.model
                        : (member.enabled === false
                            ? (zh() ? '已关闭' : 'disabled')
                            : (zh() ? '跟随当前会话' : 'inherits session')),
                    member.enabled === false ? (zh() ? '关' : 'off') : undefined,
                )),
                h(
                    'div',
                    { style: SECTION_TITLE },
                    zh() ? '共享任务' : 'Shared tasks',
                    orders.length === 0
                        ? null
                        : h('span', { style: { ...SMALL, fontWeight: '400' } }, `${orders.length}`, live?.run?.status ? ` · ${runStatusText(live.run.status)}` : ''),
                ),
                trouble === undefined
                    ? null
                    : h(
                        'div',
                        { style: { ...SMALL, color: 'var(--dsw-alias-state-error-primary, #e5534b)', padding: '2px 0 4px' } },
                        zh()
                            ? `连不上宿主接口（${trouble}）。重启 DSH 后这个面板才能读到名册和共享任务。`
                            : `Cannot reach the host API (${trouble}). Restart DSH to let this panel read the roster and tasks.`,
                    ),
                orders.length === 0
                    ? (trouble === undefined
                        ? h('div', { style: { ...SMALL, padding: '6px 2px 10px' } }, zh() ? '暂无共享任务，可以通过对话创建' : 'No shared tasks yet — create them by talking to the foreman')
                        : null)
                    : h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: '7px', paddingBottom: '6px' } },
                        ...orders.map(order => h(
                            'div',
                            { key: order.id, style: { ...CARD, alignItems: 'stretch', flexDirection: 'column', gap: '3px', padding: '9px 11px' } },
                            h('span', { style: { fontWeight: '500' } }, order.title),
                            h('span', { style: SMALL },
                                order.contractor === '' ? '—' : order.contractor,
                                ' · ',
                                orderStatusText(order.status),
                                order.verdict === ''
                                    ? ''
                                    : ` · ${order.verdict === 'pass' ? (zh() ? '已通过' : 'passed') : (zh() ? '已打回' : 'rejected')}`),
                        )),
                    ),
            );

            return h(
                'div',
                { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } },
                h(
                    'button',
                    {
                        ref: triggerRef,
                        type: 'button',
                        style: TRIGGER,
                        onClick: () => setOpen(value => !value),
                        'aria-haspopup': 'dialog',
                        'aria-expanded': open ? 'true' : 'false',
                        title: zh() ? '包工头成员与共享任务' : 'Foreman members and shared tasks',
                    },
                    peopleIcon(),
                    zh() ? '成员' : 'Members',
                    h('span', { style: COUNT_PILL }, count),
                ),
                open && anchor !== undefined
                    ? h(
                        'div',
                        {
                            ref: panelRef,
                            role: 'dialog',
                            style: { ...PANEL, left: `${anchor.left}px`, top: `${anchor.top}px`, width: `${anchor.width}px` },
                        },
                        body,
                    )
                    : null,
            );
        }

'''
s = s[:start] + component + s[end:]

io.open(p, 'w', encoding='utf-8').write(s)
print('ui rewritten')
