/**
 * 客户端半边的冒烟测试。
 *
 * 客户端插件是宿主用 `window.__ModuleLoader__.load()` 现加载的裸函数，没有构建
 * 步骤能替我们发现「引用了不存在的变量」这类错。这里造一个最小的 `window` 和一个
 * 假的 `react`，把 `factory` 跑一遍、把一个组件真的**调用**一次，能抓到的错误比
 * `node --check` 多得多：只注册设置页座位、组件渲染不抛、文案出现在树里。
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
function makeReact() {
    const createElement = (type, props, ...children) => ({
        type,
        props: { ...(props ?? {}), children: children.flat(Infinity) },
    });
    return {
        createElement,
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
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

/** 跑一遍 apply()，返回注册的座位列表。 */
function registeredSeats() {
    const react = makeReact();
    const module = loaded[0];
    const client = module.factory((name) => {
        if (name === 'react')
            return react;
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
    return seats;
}

test('客户端只注册设置页座位，不再往会话头塞「工地」按钮', async () => {
    await import('../lib/client.js');
    const seats = registeredSeats();
    assert.deepEqual(seats.map(seat => seat.name), ['settings.section']);
    assert.equal(seats[0].id, 'dsh-agent-foreman');
});

test('设置页组件渲染出包工头标题与名册说明', async () => {
    await import('../lib/client.js');
    const seats = registeredSeats();
    const tree = seats[0].component({});
    const text = textOf(tree).join(' ');
    assert.match(text, /包工头/);
    assert.match(text, /承包商名册|派单策略/);
});
