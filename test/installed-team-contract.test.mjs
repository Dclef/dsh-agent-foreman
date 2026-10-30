import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { spawnNativeTeammate } from '../lib/native-team.js';

// Optional, read-only compatibility check against the actual installed ASAR.
// Storage/activation are isolated doubles; no real model is called by this test.
const archive = process.env.DSH_HOST_ASAR;
test('installed TeamService -> TeamRoster -> native reserved-child activation preserves distinct models', { skip: !archive }, async () => {
    // Electron virtualizes .asar paths; this fixture needs the archive bytes.
    const previousNoAsar = process.noAsar;
    if (process.versions.electron) process.noAsar = true;
    let fd;
    let source;
    try {
        fd = fs.openSync(archive, 'r');
        const prefix = Buffer.alloc(16); fs.readSync(fd, prefix, 0, 16, 0);
        const bytes = Buffer.alloc(prefix.readUInt32LE(12)); fs.readSync(fd, bytes, 0, bytes.length, 16);
        let entry = JSON.parse(bytes);
        const path = 'dsh/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js';
        for (const key of path.split('/')) entry = entry.files[key];
        assert.equal(entry.unpacked, undefined);
        const body = Buffer.alloc(entry.size);
        fs.readSync(fd, body, 0, body.length, 8 + prefix.readUInt32LE(4) + Number(entry.offset));
        source = body.toString('utf8');
    } finally {
        try { if (fd !== undefined) fs.closeSync(fd); }
        finally {
            if (process.versions.electron) {
                if (previousNoAsar === undefined) delete process.noAsar;
                else process.noAsar = previousNoAsar;
            }
        }
    }
    const start = source.indexOf('var TeamRoster = class {');
    const end = source.indexOf(String.fromCharCode(10) + '};', start);
    assert.ok(start > 0 && end > start, 'installed native class layout must match the supported host');
    const classCode = source.slice(start, end + 3);
    const TeamRoster = vm.runInNewContext(classCode + ';TeamRoster', {
        randomUUID, AbortSignal,
        MEMBER_NAME: /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
        TeamId: x => x, brandString: x => x,
        TeamError: Error, errorMessage: x => x.message,
        requiredText: value => value, availability: agent => agent?.status === 'running' ? 'running' : 'inactive',
        foldSubagentDescriptor: () => undefined,
    });
    const states = new Map();
    const agents = new Map();
    const specs = [];
    const subagents = { async startActivation(spec) {
        await Promise.resolve();
        specs.push(spec);
        agents.set(spec.childId, { id: spec.childId, options: spec.request.agentOptions, status: 'inactive', session: { header: { parentSession: spec.request.parent.id } } });
        return { childId: spec.childId, messageId: 'accepted-' + spec.childId };
    } };
    const parent = { id: 'lead', options: {}, session: { header: {}, snapshotEvents: () => [] } };
    agents.set(parent.id, parent);
    const ctx = { agents: { get: id => agents.get(id) }, subagents };
    const journal = {
        state(root) { if (!states.has(root.id)) states.set(root.id, { members: [] }); return states.get(root.id); },
        async transact(_id, fn) { return fn(); },
        async appendAndFlush(root, _kind, event) {
            const rows = this.state(root).members; const i = rows.findIndex(x => x.id === event.member.id);
            if (i < 0) rows.push(event.member); else rows[i] = event.member;
        },
    };
    const lifecycle = { disposed: false, signal: new AbortController().signal, track: promise => promise };
    const roster = new TeamRoster(ctx, journal, lifecycle, 16);
    // Model execution/persistence is not the adapter under test. The installed
    // spawn/spawnAdmitted/settleProvisioning/membership/memberView remain exact.
    roster.checkpointInitialPrompt = async id => assert.ok(agents.has(id));
    const methodStart = source.indexOf('async spawnTeammate(caller, request) {');
    assert.ok(methodStart > 0);
    const bodyStart = source.indexOf('{', methodStart) + 1;
    const bodyEnd = source.indexOf('}', bodyStart);
    const methodBody = source.slice(bodyStart, bodyEnd);
    const teams = { roster, spawnTeammate: new Function('caller', 'request', 'return (async () => {' + methodBody + '})()') };
    const original = subagents.startActivation;
    const output = await Promise.all(['alpha', 'beta'].map(name => spawnNativeTeammate({
        teams, parent, request: { name, description: name, provider: 'spawn', context: 'fresh', prompt: [{ type: 'text', text: 'ready' }], signal: new AbortController().signal },
        agentOptions: { provider: 'provider-' + name, model: 'model-' + name, reasoningEffort: 'high' },
        maxDepth: 1,
    })));
    assert.equal(specs.length, 2);
    for (let i = 0; i < 2; i++) {
        const name = ['alpha', 'beta'][i];
        assert.equal(output[i].member.model, 'model-' + name);
        assert.equal(specs[i].delivery, 'parent');
        assert.strictEqual(specs[i].request.parent, parent);
        const registered = states.get(parent.id).members.find(x => x.name === name);
        assert.equal(registered.phase, 'active');
        assert.equal(roster.membership(agents.get(registered.id)).role, 'teammate');
    }
    assert.strictEqual(subagents.startActivation, original);
    assert.strictEqual(roster.ctx, ctx);
});
