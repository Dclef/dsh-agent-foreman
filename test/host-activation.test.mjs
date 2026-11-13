import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { usesFlatActivationSpec, startCompatibleActivation } from '../lib/activation.js';

const archive = process.env.DSH_HOST_ASAR;
const modulePath = 'dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js';

// Read archive bytes even under Electron's virtual .asar filesystem. No host
// module is imported or initialized, and no installed file is changed.
function readHost() {
    const previousNoAsar = process.noAsar;
    if (process.versions.electron) process.noAsar = true;
    let fd;
    try {
        fd = fs.openSync(archive, 'r');
        const readAt = (length, position) => {
            const bytes = Buffer.alloc(length);
            assert.equal(fs.readSync(fd, bytes, 0, length, position), length, 'complete ASAR entry');
            return bytes;
        };
        const prefix = readAt(16, 0);
        const header = JSON.parse(readAt(prefix.readUInt32LE(12), 16).toString('utf8'));
        const readEntry = path => {
            let entry = header;
            for (const key of path.split('/')) entry = entry?.files?.[key];
            assert.ok(entry, `installed host entry exists: ${path}`);
            assert.equal(entry.unpacked, undefined, `expected packed host entry: ${path}`);
            return readAt(entry.size, 8 + prefix.readUInt32LE(4) + Number(entry.offset)).toString('utf8');
        };
        return { source: readEntry(modulePath).replace(/\r\n/g, '\n'), version: JSON.parse(readEntry('dsh/package.json')).version };
    } finally {
        try { if (fd !== undefined) fs.closeSync(fd); }
        finally {
            if (process.versions.electron) {
                if (previousNoAsar === undefined) delete process.noAsar;
                else process.noAsar = previousNoAsar;
            }
        }
    }
}

function hostMethods(source) {
    // The published bundle's service methods have two-tab indentation. Fail
    // explicitly on a changed layout instead of silently testing a local stub.
    const method = name => {
        const start = [source.indexOf('\n\t\t' + name + '('), source.indexOf('\n\t\tasync ' + name + '(')].find(index => index >= 0);
        assert.notEqual(start, undefined, `installed service method exists: ${name}`);
        const end = source.indexOf('\n\t\t}', start);
        assert.ok(end > start, `installed service method ends: ${name}`);
        return source.slice(start, end + 4);
    };
    const validatorStart = source.indexOf('function assertSubagentMaxDepth(maxDepth) {');
    const validatorEnd = source.indexOf('\n}', validatorStart);
    assert.ok(validatorStart >= 0 && validatorEnd > validatorStart, 'installed depth validator exists');
    const validator = source.slice(validatorStart, validatorEnd + 2);
    const methods = ['startActivation', 'namesOf', 'resolveName', 'listDescendants',
        'expectProvider', 'requireManager', 'assertCapabilities', 'assertProviderCurrent'].map(method).join('\n');
    // Admission and provider checks are the exact installed methods. Only the
    // error class and the execution/persistence seams are isolated doubles.
    class SubagentError extends Error {
        constructor(message, code) { super(message); this.code = code; }
    }
    return vm.runInNewContext(validator + '\n(class HostService {\n' + methods + '\n})', {
        SubagentError, TypeError,
        assertObjectJsonSchema() { assert.fail('this contract fixture does not request structured output'); },
    }, { filename: modulePath });
}

test('installed host activation contract (isolated providers/manager; no model calls)', { skip: !archive }, async t => {
    const { source, version } = readHost();
    const HostService = hostMethods(source);
    t.diagnostic(`DSH ${version}; test runtime ${process.version}; ${modulePath}`);

    function fixture({ local = true, capabilities = {}, beforeDispatch } = {}) {
        const parent = Object.freeze({ id: 'parent', options: Object.freeze({ provider: 'parent-p', model: 'parent-m' }) });
        const calls = { local: [], external: [], provider: [] };
        const handle = Object.freeze({ childId: 'child', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose() {} });
        const provider = Object.freeze({
            name: 'backend', capabilities: Object.freeze({ agentOptions: true, depthLimit: true, ...capabilities }),
            [local ? 'prepareContinuable' : 'start'](request) {
                assert.strictEqual(this, provider);
                calls.provider.push(request);
                return { isolated: true };
            },
        });
        const providers = new Map([[provider.name, provider]]);
        const admitted = kind => async (spec, dispatch) => {
            calls[kind].push(spec);
            assert.equal(Object.hasOwn(spec, 'request'), false);
            await beforeDispatch?.({ spec, providers });
            spec.signal.throwIfAborted();
            await dispatch(spec);
            return handle;
        };
        const service = Object.freeze(Object.assign(new HostService(), {
            providers,
            ctx: { get: name => name === 'agents' ? new Map([[parent.id, parent]]) : undefined },
            manager: Object.freeze({ startLocal: admitted('local'), startExternal: admitted('external') }),
        }));
        const spec = Object.freeze({
            provider: 'backend', label: 'host contract', name: 'worker', delivery: 'caller',
            ...(local ? { childId: 'reserved-child' } : {}), signal: new AbortController().signal,
            request: Object.freeze({ parent, prompt: Object.freeze([{ type: 'text', text: 'contract check' }]), maxDepth: 2,
                agentOptions: Object.freeze({ provider: 'chosen-p', model: 'chosen-m', reasoningEffort: 'high' }) }),
        });
        return { service, spec, handle, calls, parent };
    }

    await t.test('installed public naming API identifies the flat contract', () => {
        assert.equal(usesFlatActivationSpec(fixture().service), true);
    });

    await t.test('raw nested envelope reproduces the upgraded host failure before dispatch', async () => {
        const host = fixture();
        await assert.rejects(host.service.startActivation(host.spec), { name: 'TypeError' });
        assert.equal(host.calls.local.length + host.calls.external.length, 0);
        assert.equal(host.calls.provider.length, 0);
    });

    for (const local of [true, false]) {
        await t.test(`${local ? 'local' : 'external'} host dispatch preserves route, effort, depth, signal and parent identity`, async () => {
            const host = fixture({ local });
            const originalMethod = host.service.startActivation;
            assert.strictEqual(await startCompatibleActivation(host.service, host.spec), host.handle);
            const calls = host.calls[local ? 'local' : 'external'];
            assert.equal(calls.length, 1);
            assert.equal(host.calls[local ? 'external' : 'local'].length, 0);
            assert.equal(host.calls.provider.length, 1);
            const received = calls[0];
            assert.strictEqual(host.calls.provider[0], received);
            for (const [key, value] of Object.entries(host.spec.request))
                assert.strictEqual(received[key], value, key);
            for (const key of Object.keys(host.spec).filter(key => key !== 'request'))
                assert.strictEqual(received[key], host.spec[key], key);
            assert.equal(received.agentOptions.reasoningEffort, 'high');
            assert.equal(host.parent.options.model, 'parent-m');
            assert.strictEqual(host.service.startActivation, originalMethod);
        });
    }

    await t.test('installed depth validator receives the requested flat maxDepth', async () => {
        const host = fixture();
        const spec = { ...host.spec, request: { ...host.spec.request, maxDepth: -1 } };
        await assert.rejects(startCompatibleActivation(host.service, spec), /maxDepth must be a non-negative safe integer/);
        assert.equal(host.calls.local.length, 0);
        assert.equal(host.calls.provider.length, 0);
    });

    await t.test('installed capability checks reject unsupported model and depth overrides', async () => {
        for (const capability of ['agentOptions', 'depthLimit']) {
            const host = fixture({ capabilities: { [capability]: false } });
            await assert.rejects(startCompatibleActivation(host.service, host.spec), error =>
                error.code === 'UNSUPPORTED_CAPABILITY' && error.message.includes(capability));
            assert.equal(host.calls.local.length, 0);
            assert.equal(host.calls.provider.length, 0);
        }
    });

    await t.test('installed admission rejects a copied parent instead of the exact live Agent', async () => {
        const host = fixture();
        const spec = { ...host.spec, request: { ...host.spec.request, parent: { ...host.parent } } };
        await assert.rejects(startCompatibleActivation(host.service, spec), { code: 'UNAUTHORIZED' });
        assert.equal(host.calls.local.length, 0);
        assert.equal(host.calls.provider.length, 0);
    });

    await t.test('installed provider replacement error propagates without a second start', async () => {
        const host = fixture({ beforeDispatch: ({ providers }) => providers.delete('backend') });
        await assert.rejects(startCompatibleActivation(host.service, host.spec), { code: 'PROVIDER_CHANGED' });
        assert.equal(host.calls.local.length, 1);
        assert.equal(host.calls.provider.length, 0);
    });

    await t.test('manager failure propagates by identity without retry', async () => {
        const error = new Error('isolated manager rejects');
        const host = fixture({ beforeDispatch() { throw error; } });
        await assert.rejects(startCompatibleActivation(host.service, host.spec), value => value === error);
        assert.equal(host.calls.local.length, 1);
        assert.equal(host.calls.provider.length, 0);
    });

    await t.test('caller cancellation and its reason reach the isolated manager unchanged', async () => {
        const host = fixture();
        const controller = new AbortController();
        const reason = new Error('cancel host admission');
        controller.abort(reason);
        const spec = { ...host.spec, signal: controller.signal };
        await assert.rejects(startCompatibleActivation(host.service, spec), error => error === reason);
        assert.equal(host.calls.local.length, 1);
        assert.strictEqual(host.calls.local[0].signal, controller.signal);
        assert.equal(host.calls.provider.length, 0);
    });
});
