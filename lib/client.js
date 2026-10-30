/**
 * 包工头 · 客户端半边（浏览器侧）。
 *
 * 只做一件事：把宿主半边吐的设置页放进「设置 → 包工头」这个原生座位里。
 *
 * DSH 的客户端插件不经过打包器，宿主用 `window.__ModuleLoader__.load({ id, factory })`
 * 加载它，`factory` 拿到的 `require` 只能解析宿主共享的运行时模块，所以这里
 * 手写 `react.createElement`、不写 JSX、不引第三方库。
 *
 * 面板先探测宿主路由：iframe 加载失败时浏览器不给任何信息，不如自己先探一次，
 * 把"连不上/什么状态码"直接写出来。
 *
 * @module dsh-agent-foreman/client
 */

window.__ModuleLoader__.load({
    id: 'dsh-agent-foreman',
    factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;

        const react = require('react');
        const h = react.createElement;

        /** 宿主半边挂载的页面地址。 */
        const DASHBOARD_URL = '/plugins/dsh-agent-foreman/';
        /** 探测用：state 接口同时能验证"路由在不在"和"名册读得出来"。 */
        const STATE_URL = '/plugins/dsh-agent-foreman/api/state';
        /** 座位 id。 */
        const SEAT_ID = 'dsh-agent-foreman';

        /** 语言：跟着宿主 locale 走，读不到就当中文。 */
        let localeService;
        function langOf() {
            try {
                const active = localeService?.getLocale?.()?.active;
                return typeof active === 'string' ? active : 'zh';
            }
            catch {
                return 'zh';
            }
        }
        function zh() {
            return langOf() !== 'en';
        }

        /**
         * 把设置页用的 `/api/state` 折成面板要的形状。
         *
         * 用途只有一条：宿主进程比插件旧、`/api/live` 还没注册时，至少把名册显示
         * 出来，而不是整块面板报"连不上"——但要说清共享任务为什么是空的。
         *
         * @param state - `/api/state` 的响应体。
         * @returns 与 `/api/live` 同构的对象（本轮任务为空）。
         */
        function stateToLive(state) {
            const members = Array.isArray(state?.members) ? state.members : [];
            return {
                ok: true,
                lead: { name: zh() ? '包工头' : 'Foreman', status: 'idle', waiting: false },
                members: members.map(member => ({
                    name: typeof member?.name === 'string' ? member.name : '',
                    role: typeof member?.role === 'string' ? member.role : '',
                    specialty: typeof member?.specialty === 'string' ? member.specialty : '',
                    maxParallel: Number.isFinite(member?.maxParallel) ? member.maxParallel : 1,
                    model: typeof member?.model === 'string' ? member.model : '',
                    enabled: member?.enabled !== false,
                    status: 'idle',
                })),
                run: null,
            };
        }

        const TITLE = { fontSize: '14px', fontWeight: '600', margin: '0 0 2px' };
        const SUBTITLE = { fontSize: '12px', color: 'var(--fg-muted, #6b7280)', margin: '0 0 8px' };
        const NOTE = { fontSize: '12px', color: 'var(--fg-muted, #6b7280)', lineHeight: '1.6' };

        /**
         * 探测 → 放 iframe。探测失败时把原因写出来，而不是给一块空白。
         *
         * @param props.title - iframe 标题（无障碍）。
         */
        function HostFrame({ title }) {
            const [probe, setProbe] = react.useState({ state: 'probing' });
            react.useEffect(() => {
                let cancelled = false;
                fetch(STATE_URL, { headers: { accept: 'application/json' } })
                    .then(async (res) => {
                        if (cancelled)
                            return;
                        if (!res.ok) {
                            setProbe({ state: 'failed', detail: `HTTP ${res.status}` });
                            return;
                        }
                        const body = await res.json().catch(() => undefined);
                        const members = Array.isArray(body?.members) ? body.members.length : 0;
                        setProbe({ state: 'ready', members });
                    })
                    .catch((error) => {
                        if (!cancelled)
                            setProbe({ state: 'failed', detail: String(error?.message ?? error) });
                    });
                return () => {
                    cancelled = true;
                };
            }, []);

            if (probe.state === 'probing')
                return h('div', { style: NOTE }, zh() ? '正在连接包工头…' : 'Connecting to the foreman…');
            if (probe.state === 'failed') {
                return h(
                    'div',
                    { style: NOTE },
                    zh() ? '包工头面板加载失败：' : 'The Foreman panel could not load: ',
                    String(probe.detail ?? ''),
                    h('br'),
                    zh()
                        ? '确认插件 dsh-agent-foreman 已启用，然后刷新页面。'
                        : 'Check that the dsh-agent-foreman plugin is enabled, then reload.',
                );
            }
            return h('iframe', {
                src: DASHBOARD_URL,
                title,
                style: {
                    width: '100%',
                    height: '100%',
                    border: '0',
                    display: 'block',
                    background: 'transparent',
                },
            });
        }

        /** 设置页里的那一节。 */
        function ForemanSettings() {
            return h(
                'div',
                {
                    style: {
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        height: '100%',
                        minHeight: '0',
                        padding: '2px',
                    },
                },
                h('div', { style: TITLE }, zh() ? '包工头' : 'Foreman'),
                h(
                    'div',
                    { style: SUBTITLE },
                    zh()
                        ? '承包商名册、派单策略与最近派单记录。聊天里派单和验收的结果会同步到这里。'
                        : 'Contractor roster, dispatch policy, and recent runs. Dispatch and review results from the chat show up here too.',
                ),
                h(
                    'div',
                    // 宿主把这一节包在自动高度的盒子里，百分比高度解析不出来；用
                    // 视口尺寸的固定高度，overflow 交给宿主的滚动容器。
                    { style: { flex: '1 1 auto', height: 'min(78vh, 720px)', minHeight: '340px', overflow: 'hidden' } },
                    h(HostFrame, { title: zh() ? '包工头' : 'Foreman' }),
                ),
            );
        }


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

        /** 工地面板：轮询 /api/live，显示包工头与承包商的实时状态。 */
        function worksiteGeometry(rect, viewport) {
            const margin = 12;
            const width = Math.min(380, Math.max(0, viewport.width - margin * 2));
            const left = Math.min(Math.max(margin, rect.left - viewport.left), Math.max(margin, viewport.width - width - margin));
            const top = Math.min(Math.max(margin, rect.bottom - viewport.top + 8), Math.max(margin, viewport.height - 180));
            return { left: left + viewport.left, top: top + viewport.top, width, maxHeight: Math.max(0, viewport.height - top - margin) };
        }

        function WorksitePanel({ onClose, anchor, sessionId }) {
            const [live, setLive] = react.useState(null);
            const panelRef = react.useRef(null);
            react.useEffect(() => {
                const node = panelRef.current;
                const trigger = anchor.current;
                if (!node || !trigger) return undefined;
                const place = () => {
                    const vv = window.visualViewport;
                    const geometry = worksiteGeometry(trigger.getBoundingClientRect(), {
                        width: vv?.width ?? window.innerWidth, height: vv?.height ?? window.innerHeight,
                        left: vv?.offsetLeft ?? 0, top: vv?.offsetTop ?? 0,
                    });
                    Object.assign(node.style, { left: geometry.left + 'px', top: geometry.top + 'px',
                        width: geometry.width + 'px', maxHeight: geometry.maxHeight + 'px' });
                };
                const closeOnToggle = event => { if (event.newState === 'closed') onClose(); };
                const onKey = event => { if (event.key === 'Escape') onClose(); };
                const onOutside = event => {
                    if (!node.contains(event.target) && !trigger.contains(event.target)) onClose();
                };
                node.addEventListener('toggle', closeOnToggle);
                if (typeof node.showPopover === 'function') node.showPopover();
                place();
                window.addEventListener('resize', place);
                window.addEventListener('scroll', place, true);
                window.visualViewport?.addEventListener('resize', place);
                window.visualViewport?.addEventListener('scroll', place);
                document.addEventListener('keydown', onKey);
                document.addEventListener('pointerdown', onOutside);
                return () => {
                    node.removeEventListener('toggle', closeOnToggle);
                    window.removeEventListener('resize', place);
                    window.removeEventListener('scroll', place, true);
                    window.visualViewport?.removeEventListener('resize', place);
                    window.visualViewport?.removeEventListener('scroll', place);
                    document.removeEventListener('keydown', onKey);
                    document.removeEventListener('pointerdown', onOutside);
                    if (node.matches?.(':popover-open')) node.hidePopover();
                };
            }, [anchor, onClose]);
            react.useEffect(() => {
                let cancelled = false;
                const tick = () => {
                    const url = sessionId ? LIVE_URL + '?session=' + encodeURIComponent(sessionId) : LIVE_URL;
                    fetch(url, { headers: { accept: 'application/json' } })
                        .then(res => res.json())
                        .then(body => { if (!cancelled) setLive(body); })
                        .catch(() => {});
                };
                tick();
                const timer = setInterval(() => { if (!document.hidden) tick(); }, 2500);
                return () => { cancelled = true; clearInterval(timer); };
            }, [sessionId]);
            const t = s => (zh() ? s : s);
            return h('div', {
                ref: panelRef, popover: 'auto', role: 'dialog', 'aria-label': zh() ? '工地看板' : 'Job Site',
                style: {
                    position: 'fixed', inset: 'auto', margin: '0', zIndex: 2147483647,
                    boxSizing: 'border-box', width: 'min(380px, calc(100vw - 24px))', maxHeight: 'calc(100vh - 24px)', overflowY: 'auto', overflowX: 'hidden',
                    textAlign: 'left', overflowWrap: 'anywhere',
                    background: 'var(--dsw-alias-bg-layer-1, #232327)', color: 'var(--dsw-alias-label-primary, #e8e8ea)',
                    border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
                    borderRadius: '10px', padding: '12px', fontSize: '12px',
                    boxShadow: '0 16px 40px rgba(0,0,0,.45)',
                },
            },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
                    h('strong', null, zh() ? '工地' : 'Job Site'),
                    h('button', { onClick: onClose, style: { background: 'none', border: 'none', color: 'var(--dsw-alias-label-tertiary, #9a9aa2)', cursor: 'pointer', fontSize: '14px' } }, '✕'),
                ),
                live === null
                    ? h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #9a9aa2)' } }, zh() ? '加载中…' : 'Loading…')
                    : h(WorksiteBoard, { live }),
            );
        }

        /** 工地看板本体：包工头 + 承包商 + 本轮工单。 */
        function WorksiteBoard({ live }) {
            const lead = live.lead || {};
            const members = live.members || [];
            const run = live.run;
            const t = s => (zh() ? s : s);
            return h('div', null,
                h('div', { style: { fontSize: '11px', marginBottom: '8px', lineHeight: '1.6', color: live.runtime?.execution === 'native-roster' ? 'var(--dsw-alias-label-tertiary, #9a9aa2)' : '#e8ad66' } },
                    live.runtime?.execution === 'native-roster'
                        ? '原生编队 · ' + live.runtime.build
                        : '宿主仍运行旧版或版本未确认；重启 DSH 后再验收原生多模型编队。'),
                // 包工头状态
                h('div', { style: { marginBottom: '8px', padding: '6px 8px', borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1))' } },
                    h('span', { style: { fontWeight: '600' } }, '👷 ' + (lead.name || t('包工头'))),
                    h('span', { style: { marginLeft: '6px', color: lead.status === 'running' ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary, #9a9aa2)' } },
                        lead.status === 'running' ? (zh() ? '· 干活中' : '· working')
                            : lead.waiting ? (zh() ? '· 待验收' : '· awaiting review')
                            : (zh() ? '· 空闲' : '· idle')),
                ),
                // 承包商网格
                h('div', { style: { fontWeight: '600', margin: '8px 0 4px' } }, zh() ? '承包商' : 'Contractors'),
                members.map(m => h('div', {
                    key: m.id || m.name,
                    style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 0', borderBottom: '1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.15))' },
                },
                    h('span', { style: { width: '7px', height: '7px', borderRadius: '50%', flex: 'none', background: m.status === 'running' ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.3))' } }),
                    h('span', { style: { fontWeight: '600' } }, m.name || ''),
                    h('span', { title: (m.actualModel ? '实际：' + m.actualModel + '；' : '尚未验证；') + '配置：' + (m.model || '跟随父会话'), style: { color: 'var(--dsw-alias-label-tertiary, #9a9aa2)', flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (m.actualModel ? '实际 ' + m.actualModel : '配置 ' + (m.model || (zh() ? '跟随父会话' : 'inherit')))),
                    h('span', { style: { color: 'var(--dsw-alias-label-tertiary, #9a9aa2)' } }, (m.orders || 0) + ' 单'),
                )),
                // 本轮工单
                run ? h('div', null,
                    h('div', { style: { fontWeight: '600', margin: '8px 0 4px' } }, zh() ? '本轮工单' : 'Current orders'),
                    (run.orders || []).map(o => h('div', {
                        key: o.id,
                        style: { padding: '3px 0', borderBottom: '1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.15))' },
                    },
                        h('span', { style: { fontFamily: 'monospace', color: 'var(--dsw-alias-label-tertiary, #9a9aa2)' } },
                            o.status === 'done' ? '✔ ' : o.status === 'skipped' ? '⊘ ' : (o.status === 'failed' || o.status === 'timeout') ? '✖ ' : '· '),
                        h('span', null, o.id + ' ' + (o.title || '')),
                        h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #9a9aa2)', fontSize: '11px', marginLeft: '14px' } },
                            (o.contractor || '') + (o.route ? ' · ' + o.route : '')),
                        o.error ? h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #9a9aa2)', fontSize: '11px', marginLeft: '14px' } }, o.error) : null,
                    )),
                ) : h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #9a9aa2)', margin: '8px 0' } }, zh() ? '还没有派单' : 'No orders yet'),
            );
        }

        /** 会话头的「工地」按钮 + 点开面板。 */
        function WorksiteAction(props = {}) {
            const [open, setOpen] = react.useState(false);
            const anchor = react.useRef(null);
            const sessionId = props.sessionId ?? props.session?.id ?? props.agent?.session?.id ?? '';
            const close = react.useCallback(() => setOpen(false), []);
            return h('div', { style: { position: 'relative', display: 'inline-block' } },
                h('button', {
                    ref: anchor, 'aria-haspopup': 'dialog', 'aria-expanded': open,
                    onClick: () => setOpen(o => !o),
                    title: zh() ? '工地看板' : 'Job Site',
                    style: { display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '3px 8px', minHeight: '28px', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28))', borderRadius: '6px', background: 'transparent', color: 'var(--dsw-alias-label-secondary, #b9b9c0)', cursor: 'pointer', fontSize: '12px' },
                }, '🏗 ' + (zh() ? '工地' : 'Job Site')),
                open ? h(WorksitePanel, { onClose: close, anchor, sessionId }) : null,
            );
        }

        /**
         * 挂载客户端半边。
         * @param ctx - 客户端 cordis 上下文。
         */
        function apply(ctx) {
            ctx.inject(['locale'], (injected) => {
                localeService = injected.get('locale');
                return undefined;
            });

            const seats = [];
            ctx.inject(['slots'], (injected) => {
                const slots = injected.get('slots');
                if (slots === undefined || typeof slots.register !== 'function' || typeof slots.inject !== 'function') {
                    console.warn('[dsh-agent-foreman] slots 服务不可用，设置页不会被注册。');
                    return undefined;
                }
                // 设置页：名册编辑 + 策略 + 历史。
                const release = slots.inject('settings.section', () => slots.register({
                    name: 'settings.section',
                    id: SEAT_ID,
                    // 紧跟在 Cursor 那一节（62）之后，同属"子智能体为什么这么跑"的说明区。
                    order: 63,
                    label: () => (zh() ? '包工头' : 'Foreman'),
                }, ForemanSettings));
                seats.push(release);
                // 会话头：「工地」按钮 + 实时看板（主面板，不藏在设置里）。
                const releaseWorksite = slots.inject('conversation.session.header.actions', () => slots.register({
                    name: 'conversation.session.header.actions',
                    id: SEAT_ID + '-worksite',
                    order: -19,
                    label: () => (zh() ? '工地' : 'Job Site'),
                }, WorksiteAction));
                seats.push(releaseWorksite);
                return undefined;
            });

            ctx.effect(() => () => {
                for (const release of seats) {
                    try {
                        release?.();
                    }
                    catch (error) {
                        console.warn('[dsh-agent-foreman] 释放座位失败：', error);
                    }
                }
                seats.length = 0;
            });
        }

        exports.name = 'dsh-agent-foreman-client';
        exports.apply = apply;
        exports.inject = [];
        return module.exports;
    },
});
