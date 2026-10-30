import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { renderPage } from '../lib/page.js';

const executable = process.env.DSH_BROWSER_EXE;
const clone = value => JSON.parse(JSON.stringify(value));
const fixture = { ok: true, members: [
    { id: 'w1', name: '力工', provider: 'trae', model: 'flash', reasoningEffort: '', prompt: '保持提示词', maxParallel: 1, enabled: true },
    { id: 'w2', name: '力工2', provider: 'workbuddy', model: 'deepseek', reasoningEffort: 'max', prompt: '', maxParallel: 2, enabled: true },
    { id: 'w3', name: '力工3', provider: 'workbuddy-global', model: 'deepseek', reasoningEffort: 'max', prompt: '', maxParallel: 1, enabled: true },
    { id: 'w4', name: '力工4', provider: 'qoder', model: 'qfmodel', reasoningEffort: '', prompt: '', maxParallel: 1, enabled: true },
    { id: 'w5', name: '力工5', provider: 'qoder-global', model: 'gfmodel', reasoningEffort: '', prompt: '', maxParallel: 1, enabled: true },
    { id: 'w6', name: '力工6', provider: '', model: '', reasoningEffort: '', prompt: '', maxParallel: 1, enabled: false },
], policy: { concurrency: 6, timeoutSeconds: 120, maxRework: 1, maxDepth: 1, provider: 'spawn', teamMode: true }, runs: [], subagentProviders: ['spawn'] };
const catalog = { providers: [
    { id: 'trae', name: 'TRAE (字节)', models: [{ id: 'flash', name: 'DeepSeek-V4-Flash · x0.2' }] },
    { id: 'workbuddy', name: 'WorkBuddy', models: [{ id: 'deepseek', name: 'DeepSeek-V4.1-Flash · x0.11' }] },
    { id: 'workbuddy-global', name: 'WorkBuddy Global', models: [{ id: 'deepseek', name: 'DeepSeek-V4.1-Flash · x0.00' }] },
    { id: 'qoder', name: 'Qoder', models: [{ id: 'qfmodel', name: 'Qwen3.8-Flash · x0.00' }] },
    { id: 'qoder-global', name: 'Qoder Global', models: [{ id: 'gfmodel', name: 'GLM-5.3-Flash · x0.10' }] },
] };

test('browser: responsive roster preserves models, prompts, enabled flags and save behavior', { skip: !executable, timeout: 60000 }, async () => {
    let state = clone(fixture);
    const saves = [];
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        res.setHeader('cache-control', 'no-store');
        if (url.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(renderPage()); return; }
        let data;
        if (url.pathname.endsWith('/api/catalog')) data = catalog;
        else if (url.pathname.endsWith('/api/state')) data = state;
        else if (url.pathname.endsWith('/api/efforts')) data = { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' };
        else if (url.pathname.endsWith('/api/live')) data = { ok: true, members: [], run: null };
        else if (url.pathname.endsWith('/api/members') && req.method === 'POST') {
            let body = ''; for await (const chunk of req) body += chunk;
            const input = JSON.parse(body); saves.push(input.members); state = { ...state, members: input.members }; data = { ok: true, members: state.members };
        } else { res.statusCode = 404; res.end(); return; }
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-browser-'));
    const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let socket; let serial = 0; const pending = new Map(); const errors = [];
    let call;
    try {
        const endpoint = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('Chrome startup timed out')), 15000); let text = '';
            browser.once('error', error => { clearTimeout(timer); reject(error); });
            browser.stderr.on('data', chunk => { text += chunk; const line = text.split(String.fromCharCode(10)).find(value => value.includes('DevTools listening on ')); if (line) { clearTimeout(timer); resolve(line.slice(line.indexOf('ws://')).trim()); } });
        });
        socket = new WebSocket(endpoint); await once(socket, 'open');
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
            if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params);
            if (message.id) { const handler = pending.get(message.id); pending.delete(message.id); if (message.error) handler.reject(Error(JSON.stringify(message.error))); else handler.resolve(message.result); }
        });
        call = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
        const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
        await call('Page.enable', {}, sessionId); await call('Runtime.enable', {}, sessionId);
        await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, sessionId);
        const evaluate = async expression => { const value = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId); if (value.exceptionDetails) throw Error(JSON.stringify(value.exceptionDetails)); return value.result.value; };
        const waitFor = expression => evaluate('(async()=>{for(let i=0;i<100;i++){if(' + expression + ')return true;await new Promise(r=>setTimeout(r,30));}throw Error("condition timed out");})()');
        for (const width of [744, 620, 442, 320, 1100]) {
            await call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
            await call('Page.navigate', { url }, sessionId);
            await waitFor('document.querySelectorAll(".contractor").length===6 && document.querySelectorAll(".roster-effort select option").length>12');
            const result = await evaluate('(()=>{const cards=[...document.querySelectorAll(".contractor")];const controls=cards.flatMap(card=>[...card.querySelectorAll("input,select,button")]);return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,count:cards.length,minParallelWidth:Math.min(...cards.map(card=>card.querySelector(".roster-parallel input").getBoundingClientRect().width)),allControlsInside:controls.every(node=>{const r=node.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;}),w4:cards[3].querySelector(".contractor-route").textContent,w5:cards[4].querySelector(".contractor-route").textContent,effort:cards[1].querySelector(".roster-effort select").value};})()');
            assert.equal(result.count, 6); assert.ok(result.scrollWidth <= width + 1, JSON.stringify(result)); assert.ok(result.minParallelWidth >= 64); assert.equal(result.allControlsInside, true); assert.ok(result.w4.includes('Qwen3.8-Flash')); assert.ok(result.w5.includes('GLM-5.3-Flash')); assert.equal(result.effort, 'max');
            console.log(JSON.stringify(result));
            if (process.env.DSH_BROWSER_EVIDENCE_DIR) { fs.mkdirSync(process.env.DSH_BROWSER_EVIDENCE_DIR, { recursive: true }); const image = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId); fs.writeFileSync(path.join(process.env.DSH_BROWSER_EVIDENCE_DIR, 'roster-' + width + '.png'), Buffer.from(image.data, 'base64')); }
        }
        await evaluate('document.getElementById("save").click()'); await waitFor('document.getElementById("roster-status").textContent.includes("已保存")');
        assert.deepEqual(saves[0], fixture.members, 'saving without edits must preserve every saved field');
        await evaluate('(()=>{const row=document.querySelectorAll(".contractor")[3];row.querySelector(".contractor-actions button").click();document.getElementById("prompt-text").value="浏览器编辑提示词";document.getElementById("prompt-save").click();const parallel=document.querySelectorAll(".contractor")[3].querySelector(".roster-parallel input");parallel.value="3";parallel.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("save").click();})()');
        await waitFor('document.querySelectorAll(".contractor")[3].querySelector(".roster-parallel input").value==="3" && document.getElementById("roster-status").textContent.includes("已保存")');
        assert.equal(saves[1][3].prompt, '浏览器编辑提示词'); assert.equal(saves[1][3].maxParallel, 3); assert.equal(saves[1][3].model, 'qfmodel');
        await evaluate('(()=>{const row=document.querySelectorAll(".contractor")[3],provider=row.querySelector(".roster-provider select");provider.value="qoder-global";provider.dispatchEvent(new Event("change",{bubbles:true}));const model=row.querySelector(".roster-model select");model.value="gfmodel";model.dispatchEvent(new Event("change",{bubbles:true}));})()');
        await waitFor('document.querySelectorAll(".contractor")[3].querySelector(".contractor-route").textContent.includes("qoder-global/gfmodel")');
        await evaluate('document.getElementById("save").click()');
        await waitFor('document.getElementById("roster-status").textContent.includes("已保存")');
        assert.equal(saves[2][3].provider, 'qoder-global'); assert.equal(saves[2][3].model, 'gfmodel'); assert.equal(saves[2][3].reasoningEffort, ''); assert.equal(saves[2][1].reasoningEffort, 'max'); assert.equal(saves[2][5].enabled, false);
        assert.deepEqual(errors, [], 'no browser console or execution errors');
    } finally {
        if (call && socket?.readyState === WebSocket.OPEN) await call('Browser.close').catch(() => {});
        socket?.close(); if (browser.exitCode === null) browser.kill();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    }
});
