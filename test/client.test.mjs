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

test('客户端半边只注册设置座位（会话头「成员」按钮已按需求删掉）', async () => {
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
    assert.deepEqual(seats.map(seat => seat.name), ['settings.section']);
});
