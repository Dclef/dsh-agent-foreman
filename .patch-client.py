import io, re

p = 'lib/client.js'
s = io.open(p, encoding='utf-8').read()

anchor = "        /**\n         * 挂载客户端半边。"
assert anchor in s, 'anchor missing'

component = r'''
        /** 成员面板轮询地址；会话 id 由宿主的会话头座位传进来。 */
        const LIVE_URL = '/plugins/dsh-agent-foreman/api/live';

        /** 工单状态的措辞。 */
        function orderStatusText(status) {
            const zhText = { queued: '排队中', running: '进行中', done: '已完成', failed: '失败', timeout: '超时' };
            const enText = { queued: 'queued', running: 'running', done: 'done', failed: 'failed', timeout: 'timed out' };
            const table = zh() ? zhText : enText;
            return table[status] ?? status ?? '';
        }

        /** 派单状态的措辞。 */
        function runStatusText(status) {
            const zhText = { running: '干活中', rework: '返工中', 'waiting-review': '待验收', accepted: '已验收', closed: '已结案' };
            const enText = { running: 'working', rework: 'rework', 'waiting-review': 'awaiting review', accepted: 'accepted', closed: 'closed' };
            const table = zh() ? zhText : enText;
            return table[status] ?? status ?? '';
        }

        const PANEL = {
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: '0',
            zIndex: '60',
            width: 'min(380px, calc(100vw - 32px))',
            maxHeight: 'min(60vh, 520px)',
            overflowY: 'auto',
            boxSizing: 'border-box',
            padding: '10px',
            borderRadius: '12px',
            border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28))',
            background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-1, #1f1f22))',
            boxShadow: 'var(--dsw-elevation-prominent, 0 12px 32px rgba(0,0,0,.32))',
            color: 'var(--dsw-alias-label-primary, #e8e8ea)',
            fontSize: '12px',
            textAlign: 'left',
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
        const SECTION_TITLE = { fontSize: '12px', fontWeight: '500', margin: '14px 0 8px', opacity: '0.8' };
        const CARD = {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 10px',
            borderRadius: '8px',
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2))',
            background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08))',
        };
        const DOT = { width: '8px', height: '8px', borderRadius: '50%', flex: 'none' };
        const SMALL = { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #9a9aa2)' };
        const TAG = {
            marginLeft: 'auto',
            flex: 'none',
            padding: '0 5px',
            borderRadius: '4px',
            fontSize: '10px',
            lineHeight: '16px',
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28))',
        };

        /**
         * 会话头部的「成员」按钮 + 浮层：包工头、承包商、本轮共享任务。
         *
         * 数据来自宿主半边的 `/api/live`，每 2.5 秒拉一次；宿主没有派单时
         * `run` 是 null，这里渲染空态而不是空白。
         *
         * @param props.sessionId - 宿主会话头座位注入的会话 id。
         */
        function MembersAction({ sessionId }) {
            const [open, setOpen] = react.useState(false);
            const [live, setLive] = react.useState(undefined);
            const rootRef = react.useRef(null);

            const query = typeof sessionId === 'string' && sessionId !== ''
                ? `?session=${encodeURIComponent(sessionId)}`
                : '';
            react.useEffect(() => {
                let stopped = false;
                const load = () => {
                    fetch(`${LIVE_URL}${query}`, { headers: { accept: 'application/json' } })
                        .then((res) => (res.ok ? res.json() : undefined))
                        .then((body) => {
                            if (!stopped && body !== undefined)
                                setLive(body);
                        })
                        .catch(() => undefined);
                };
                load();
                const timer = setInterval(load, 2500);
                return () => {
                    stopped = true;
                    clearInterval(timer);
                };
            }, [query]);

            react.useEffect(() => {
                if (!open)
                    return undefined;
                const onDown = (event) => {
                    if (rootRef.current !== null && !rootRef.current.contains(event.target))
                        setOpen(false);
                };
                document.addEventListener('mousedown', onDown);
                return () => document.removeEventListener('mousedown', onDown);
            }, [open]);

            const members = Array.isArray(live?.members) ? live.members : [];
            const orders = Array.isArray(live?.run?.orders) ? live.run.orders : [];
            const count = members.length + 1;

            const dot = (status) => h('span', {
                style: { ...DOT, background: status === 'running' ? 'var(--dsw-alias-state-success-primary, #3fb950)' : 'var(--dsw-alias-label-tertiary, #8b8b93)' },
            });

            const memberCard = (key, name, status, detail, tag) => h(
                'div',
                { key, style: CARD },
                dot(status),
                h('span', { style: { display: 'flex', flexDirection: 'column', minWidth: '0', gap: '1px' } },
                    h('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, name),
                    h('span', { style: SMALL }, detail)),
                tag === undefined ? null : h('span', { style: TAG }, tag),
            );

            const leadDetail = live?.lead?.waiting
                ? (zh() ? '等你验收' : 'awaiting your review')
                : (live?.lead?.status === 'running'
                    ? (zh() ? '正在调度' : 'dispatching')
                    : (zh() ? '未运行' : 'not running'));

            const body = h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0' } },
                h('div', { style: SECTION_TITLE }, zh() ? '成员' : 'Members'),
                memberCard('lead', live?.lead?.name ?? (zh() ? '包工头' : 'Foreman'), live?.lead?.status, leadDetail, zh() ? '当前会话' : 'this session'),
                ...members.map(member => memberCard(
                    `m:${member.name}`,
                    member.name,
                    member.enabled === false ? 'inactive' : member.status,
                    member.model !== '' ? member.model : (member.enabled === false ? (zh() ? '已关闭' : 'disabled') : (zh() ? '跟随当前会话' : 'inherits session')),
                    member.enabled === false ? (zh() ? '关' : 'off') : undefined,
                )),
                h('div', { style: SECTION_TITLE }, zh() ? '共享任务' : 'Shared tasks',
                    orders.length === 0
                        ? null
                        : h('span', { style: { ...SMALL, marginLeft: '8px' } }, `${orders.length}`, live?.run?.status ? ` · ${runStatusText(live.run.status)}` : '')),
                orders.length === 0
                    ? h('div', { style: { ...SMALL, margin: '4px 2px 2px' } }, zh() ? '暂无共享任务，可以通过对话创建' : 'No shared tasks yet — create them by talking to the foreman')
                    : orders.map(order => h(
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
            );

            return h(
                'div',
                { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } },
                h(
                    'button',
                    {
                        type: 'button',
                        style: TRIGGER,
                        onClick: () => setOpen(value => !value),
                        'aria-haspopup': 'dialog',
                        'aria-expanded': open ? 'true' : 'false',
                        title: zh() ? '包工头成员与共享任务' : 'Foreman members and shared tasks',
                    },
                    zh() ? '成员' : 'Members',
                    h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, count),
                ),
                open ? h('div', { style: PANEL, role: 'dialog' }, body) : null,
            );
        }

'''

s = s.replace(anchor, component + anchor, 1)

old = """            ctx.effect(() => () => {
                for (const release of seats) {"""
new = """            ctx.inject(['slots'], (injected) => {
                const slots = injected.get('slots');
                if (slots === undefined || typeof slots.register !== 'function' || typeof slots.inject !== 'function')
                    return undefined;
                const release = slots.inject('conversation.session.header.actions', () => slots.register({
                    name: 'conversation.session.header.actions',
                    id: `${SEAT_ID}-members`,
                    // 排在 Agent Teams 那个按钮（-20）后面，两者可以并存。
                    order: -19,
                }, MembersAction));
                seats.push(release);
                return undefined;
            });

            ctx.effect(() => () => {
                for (const release of seats) {"""
assert old in s, 'seats anchor missing'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8').write(s)
print('client patched')
