/**
 * 客户端半边的冒烟测试。
 *
 * 客户端插件是宿主用 `window.__ModuleLoader__.load()` 现加载的裸函数，没有构建
 * 步骤能替我们发现「引用了不存在的变量」这类错。这里造一个最小的 `window` 和一个
 * 假的 `react`，把 `factory` 跑一遍、把一个组件真的**调用**一次，能抓到的错误比
 * `node --check` 多得多：两个座位都注册、组件渲染不抛、文案出现在树里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** 收集 `window.__ModuleLoader__.load()` 的实参。 */
const loaded = [];
globalThis.window = {
    innerWidth: 1280,
    innerHeight: 860,
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: {
        load(definition) {
            loaded.push(definition);
        },
    },
};

/** 最小 react：只要能让组件函数跑一次。 */
function makeReact({ open = false, live = undefined, trouble = undefined } = {}) {
    const createElement = (type, props, ...children) => ({
        type,
        props: { ...(props ?? {}), children: children.flat(Infinity) },
    });
    // 组件里两次 useState：先 open，再 live。按顺序喂进去，就能直接渲染出浮层。
    const queue = [open, live, trouble];
    return {
        createElement,
        useState: (initial) => [queue.length > 0 ? queue.shift() : (typeof initial === 'function' ? initial() : initial), () => {}],
        // 浮层要靠触发器量位置才渲染；给个假节点，让 measure() 能算出锚点。
        useRef: () => ({ current: { getBoundingClientRect: () => ({ right: 900, bottom: 40, left: 820, top: 12 }) } }),
        useEffect: () => {},
        useCallback: fn => fn,
    };
}

/** 把元素树里的文字全抓出来。 */
function textOf(node, into = []) {
    if (node === null || node === undefined || node === false)
        return into;
    if (typeof node === 'string' || typeof node === 'number') {
        into.push(String(node));
        return into;
    }
    if (Array.isArray(node)) {
        for (const child of node)
            textOf(child, into);
        return into;
    }
    if (typeof node === 'object' && node.props !== undefined)
        textOf(node.props.children, into);
    return into;
}

test('客户端注册设置座位与会话头「工地」按钮', async () => {
    await import('../lib/client.js');
    const module = loaded[0];
    const client = module.factory((name) => {
        if (name === 'react')
            return makeReact({});
        throw new Error(`unexpected require: ${name}`);
    });
    const seats = [];
    const slots = {
        inject: (_name, callback) => callback(),
        register: (seat, component) => {
            seats.push({ ...seat, component });
            return () => {};
        },
    };
    client.apply({
        inject: (names, callback) => {
            if (names.includes('slots'))
                return callback({ get: () => slots });
            return callback({ get: () => ({ getLocale: () => ({ active: 'zh' }) }) });
        },
        effect: (setup) => setup(),
    });
    assert.deepEqual(seats.map(seat => seat.name).sort(), ['conversation.session.header.actions', 'settings.section']);
});

async function worksiteTree(live, sessionId = 'session-current') {
    await import('../lib/client.js');
    const react = makeReact({ open: true, live });
    const client = loaded[0].factory(() => react);
    const seats = [];
    const slots = { inject: (_name, callback) => callback(), register: (seat, component) => { seats.push({ ...seat, component }); return () => {}; } };
    client.apply({ inject: (names, callback) => callback({ get: () => names.includes('slots') ? slots : { getLocale: () => ({ active: 'zh' }) } }), effect: setup => setup() });
    const tree = seats.find(seat => seat.name === 'conversation.session.header.actions').component({ sessionId });
    const panelElement = tree.props.children[1];
    const panel = panelElement.type(panelElement.props);
    const boardElement = panel.props.children[1];
    return { tree, panelElement, panel, board: boardElement.type(boardElement.props) };
}

test('工地弹层处于 top layer、按当前会话查询并明确区分配置与实际模型', async () => {
    const { tree, panelElement, panel, board } = await worksiteTree({
        runtime: { execution: 'native-roster', build: 'native-team-v2-20261030' },
        members: [{ name: '力工', model: 'configured/model', actualModel: 'observed/model' }],
    });
    assert.equal(tree.props.children[0].props['aria-expanded'], true);
    assert.equal(panelElement.props.sessionId, 'session-current');
    assert.equal(panel.props.popover, 'auto');
    assert.equal(panel.props.style.position, 'fixed');
    assert.equal(panel.props.style.right, undefined);
    assert.equal(panel.props.style.boxSizing, 'border-box');
    assert.match(textOf(board).join(' '), /原生编队/);
    assert.match(textOf(board).join(' '), /实际 observed\/model/);
});

test('旧宿主未加载新代码时，工地明确提示不能把名册配置视为实际验证', async () => {
    const { board } = await worksiteTree({ members: [{ name: 'worker', model: 'configured/model' }] });
    assert.match(textOf(board).join(' '), /宿主仍运行旧版/);
    assert.match(textOf(board).join(' '), /配置 configured\/model/);
});
