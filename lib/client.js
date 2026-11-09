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
