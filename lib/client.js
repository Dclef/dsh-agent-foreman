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
                const release = slots.inject('settings.section', () => slots.register({
                    name: 'settings.section',
                    id: SEAT_ID,
                    // 紧跟在 Cursor 那一节（62）之后，同属"子智能体为什么这么跑"的说明区。
                    order: 63,
                    label: () => (zh() ? '包工头' : 'Foreman'),
                }, ForemanSettings));
                seats.push(release);
                return undefined;
            });

            ctx.effect(() => () => {
                for (const release of seats) {
                    try {
                        release?.();
                    }
                    catch (error) {
                        console.warn('[dsh-agent-foreman] 释放设置页座位失败：', error);
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
