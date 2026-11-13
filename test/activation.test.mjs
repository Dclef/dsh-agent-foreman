import test from 'node:test';
import assert from 'node:assert/strict';
import { usesFlatActivationSpec, startCompatibleActivation } from '../lib/activation.js';
import { ForemanEngine } from '../lib/engine.js';

const namingApi = Object.freeze({
    namesOf() { assert.fail('feature detection must not call namesOf'); },
    resolveName() { assert.fail('feature detection must not resolve names'); },
    listDescendants() { assert.fail('feature detection must not list descendants'); },
});

function legacySpec() {
    return Object.freeze({
        provider: 'backend', label: 'work', childId: 'reserved-child', delivery: 'caller',
        signal: new AbortController().signal,
        request: Object.freeze({
            parent: Object.freeze({ id: 'parent', options: Object.freeze({ provider: 'parent-p', model: 'parent-m' }) }),
            prompt: Object.freeze([{ type: 'text', text: 'do the work' }]),
            agentOptions: Object.freeze({ provider: 'chosen-p', model: 'chosen-m', reasoningEffort: 'high' }),
            maxDepth: 2, name: 'worker', cwd: 'E:/work',
            outputSchema: Object.freeze({ type: 'object', properties: {} }),
        }),
    });
}

test('flat API detection requires the verified public methods without invoking them', () => {
    assert.equal(usesFlatActivationSpec(Object.create(namingApi)), true);
    for (const service of [undefined, null, {}, { version: '99.0.0' }, { listDescendants() {} }])
        assert.equal(usesFlatActivationSpec(service), false);
    for (const key of Object.keys(namingApi)) {
        for (const value of [undefined, true, 'function'])
            assert.equal(usesFlatActivationSpec({ ...namingApi, [key]: value }), false, key);
    }
});

test('legacy host receives the exact original envelope and returns its native handle', () => {
    const spec = legacySpec();
    const handle = { childId: 'child', result: Promise.resolve({}), dispose() {} };
    let calls = 0;
    const service = Object.freeze({
        startActivation(received) {
            assert.strictEqual(this, service);
            assert.strictEqual(received, spec);
            calls += 1;
            return handle;
        },
    });
    assert.strictEqual(startCompatibleActivation(service, spec), handle);
    assert.equal(calls, 1);
});

test('flat host receives strict top-level fields, exact references, and unchanged backend selection', () => {
    const spec = legacySpec();
    const nativeReturn = Promise.resolve({ childId: 'child' });
    let calls = 0;
    const service = Object.freeze({
        ...namingApi,
        startActivation(received) {
            assert.strictEqual(this, service);
            assert.equal(Object.hasOwn(received, 'request'), false);
            assert.deepEqual(Object.keys(received).sort(), [
                'provider', 'label', 'childId', 'delivery', 'signal', ...Object.keys(spec.request),
            ].sort());
            for (const [key, value] of Object.entries(spec.request))
                assert.strictEqual(received[key], value, key);
            for (const key of ['provider', 'label', 'childId', 'delivery', 'signal'])
                assert.strictEqual(received[key], spec[key], key);
            assert.equal(received.provider, 'backend');
            assert.equal(received.agentOptions.provider, 'chosen-p');
            assert.equal(received.agentOptions.reasoningEffort, 'high');
            calls += 1;
            return nativeReturn;
        },
    });
    assert.strictEqual(startCompatibleActivation(service, spec), nativeReturn);
    assert.equal(calls, 1);
    assert.equal(spec.request.parent.options.model, 'parent-m');
    assert.equal(Object.hasOwn(spec, 'parent'), false);
});

test('flat adapter preserves top-level team name and parent delivery', () => {
    const spec = legacySpec();
    startCompatibleActivation({ ...namingApi, startActivation(received) {
        assert.equal(received.name, 'team-worker');
        assert.equal(received.delivery, 'parent');
        assert.equal(received.provider, 'backend');
        assert.strictEqual(received.parent, spec.request.parent);
        assert.equal(Object.hasOwn(received, 'request'), false);
    } }, Object.freeze({ ...spec, name: 'team-worker', delivery: 'parent' }));
});

test('flat adapter preserves inherited options, zero depth and parent delivery without adding defaults', () => {
    const spec = legacySpec();
    const request = Object.freeze({ parent: spec.request.parent, prompt: spec.request.prompt, maxDepth: 0 });
    startCompatibleActivation({ ...namingApi, startActivation(received) {
        assert.deepEqual(received, { provider: 'backend', delivery: 'parent', ...request });
        assert.equal(Object.hasOwn(received, 'agentOptions'), false);
        assert.equal(Object.hasOwn(received, 'signal'), false);
    } }, Object.freeze({ provider: 'backend', delivery: 'parent', request }));
});

for (const flat of [false, true]) {
    for (const asynchronous of [false, true]) {
        test(`${flat ? 'flat' : 'legacy'} native ${asynchronous ? 'rejection' : 'throw'} propagates once without retry`, async () => {
            const error = new Error('native admission failed');
            let calls = 0;
            const service = Object.freeze({
                ...(flat ? namingApi : {}),
                startActivation() {
                    calls += 1;
                    if (asynchronous) return Promise.reject(error);
                    throw error;
                },
            });
            if (asynchronous)
                await assert.rejects(startCompatibleActivation(service, legacySpec()), value => value === error);
            else
                assert.throws(() => startCompatibleActivation(service, legacySpec()), value => value === error);
            assert.equal(calls, 1);
        });
    }
}

test('flat activation keeps live cancellation and disposal on the original handle', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    let disposed = 0;
    const handle = {
        result: new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
        dispose() { disposed += 1; },
    };
    const service = { ...namingApi, startActivation(spec) {
        assert.strictEqual(spec.signal, controller.signal);
        return handle;
    } };
    assert.strictEqual(startCompatibleActivation(service, { ...legacySpec(), signal: controller.signal }), handle);
    const rejected = assert.rejects(handle.result, error => error === reason);
    controller.abort(reason);
    await rejected;
    handle.dispose();
    assert.equal(disposed, 1);
});

const policy = Object.freeze({ concurrency: 1, timeoutSeconds: 30, maxRework: 0, maxDepth: 2, provider: 'backend', teamMode: false });
function engineHost(flat, { inherit = false, pending = false } = {}) {
    const specs = [];
    const parent = Object.freeze({ id: 'parent', options: Object.freeze({ provider: 'parent-p', model: 'parent-m' }) });
    const worker = Object.freeze({ id: 'worker', name: 'worker', enabled: true, prompt: '', maxParallel: 1,
        provider: inherit ? '' : 'chosen-p', model: inherit ? '' : 'chosen-m', reasoningEffort: inherit ? '' : 'high' });
    let disposed = 0;
    let onStart;
    const started = new Promise(resolve => { onStart = resolve; });
    const subagents = Object.freeze({
        ...(flat ? namingApi : {}),
        providers: new Map([['backend', { name: 'backend', capabilities: { agentOptions: true } }]]),
        startActivation(spec) {
            specs.push(spec);
            if (flat) {
                assert.equal(Object.hasOwn(spec, 'request'), false);
                assert.strictEqual(spec.parent, parent);
                assert.ok(Array.isArray(spec.prompt));
                assert.equal(spec.maxDepth, 2);
            } else {
                assert.strictEqual(spec.request.parent, parent);
                assert.equal(Object.hasOwn(spec, 'parent'), false);
            }
            onStart();
            return { childId: 'child',
                result: pending ? new Promise(() => {}) : Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
                dispose() { disposed += 1; },
            };
        },
    });
    const store = { members: () => [worker], policy: () => policy, writeArtifact: () => '', recordRun() {} };
    const engine = new ForemanEngine({ ctx: { get: name => name === 'subagents' ? subagents : undefined }, store });
    return { specs, parent, started, disposed: () => disposed, dispatch(signal) {
        return engine.dispatch({ parent, sessionId: parent.id, goal: 'work', policy, signal,
            orders: [{ id: 'W1', title: 'work', task: 'do the work', contractor: '', dependsOn: [] }] });
    } };
}

for (const flat of [false, true]) {
    test(`engine dispatch completes with the strict ${flat ? 'flat' : 'legacy'} API and explicit model/effort`, async () => {
        const host = engineHost(flat);
        const run = await host.dispatch();
        assert.equal(run.orders[0].status, 'done', run.orders[0].error);
        assert.equal(host.specs.length, 1);
        const spec = host.specs[0];
        const request = flat ? spec : spec.request;
        assert.deepEqual(request.agentOptions, { provider: 'chosen-p', model: 'chosen-m', reasoningEffort: 'high' });
        assert.equal(spec.provider, 'backend');
        assert.equal(spec.delivery, 'caller');
        assert.match(request.prompt[0].text, /do the work/);
        assert.equal(host.disposed(), 1);
        assert.equal(host.parent.options.model, 'parent-m');
    });
}

test('engine flat dispatch leaves inherited model selection absent', async () => {
    const host = engineHost(true, { inherit: true });
    const run = await host.dispatch();
    assert.equal(run.orders[0].status, 'done', run.orders[0].error);
    assert.equal(Object.hasOwn(host.specs[0], 'agentOptions'), false);
});

test('engine flat dispatch forwards caller abort reason and disposes exactly once', async () => {
    const host = engineHost(true, { pending: true });
    const controller = new AbortController();
    const reason = new Error('cancel this order');
    const dispatched = host.dispatch(controller.signal);
    await host.started;
    controller.abort(reason);
    const run = await dispatched;
    assert.equal(host.specs.length, 1);
    assert.equal(host.specs[0].signal.aborted, true);
    assert.strictEqual(host.specs[0].signal.reason, reason);
    assert.equal(run.orders[0].stopReason, 'aborted');
    assert.equal(host.disposed(), 1);
});
