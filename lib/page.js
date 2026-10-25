/**
 * 包工头 · 设置页。
 *
 * 这个页面由宿主半边自己吐纯 HTML，客户端半边只用 iframe 把它塞进
 * 「设置 → 包工头」。这样做的代价是不能用宿主的设计系统，好处是不需要打包、
 * 不需要 React、插件装上去就能用——与 dsh-cursor-dev 的面板同一套路子。
 *
 * 页面只做三件事：编名册、调策略、看台账。看板正文在聊天里，不在这里。
 *
 * 名册刻意只有"名字 + 模型"两个必填项：模型留空就是**跟随当前会话**（宿主直接
 * 继承父会话的 provider/模型/思考等级，不需要用户再填一遍 provider）。只有
 * 确实想换人换模型时才从一个下拉里挑——provider 由所选模型自带，不单独成列。
 *
 * 所有字符串都是字面量拼接而不是内层模板字符串，避免和外面这层模板的
 * `${}` 互相干扰。
 *
 * @module dsh-agent-foreman/page
 */

/** 页面的静态部分：样式。 */
const STYLE = String.raw`
:root {
    color-scheme: light dark;
    --fg: #1f2328;
    --dim: #6b7280;
    --line: #d8dce3;
    --bg: #ffffff;
    --soft: #f6f7f9;
    --accent: #d97706;
    --accent-soft: #fef3c7;
    --ok: #15803d;
    --bad: #b91c1c;
}
@media (prefers-color-scheme: dark) {
    :root {
        --fg: #e6e8eb;
        --dim: #9aa4b2;
        --line: #333a45;
        --bg: #16191d;
        --soft: #1d2126;
        --accent: #fbbf24;
        --accent-soft: #3a2f14;
        --ok: #4ade80;
        --bad: #f87171;
    }
}
* { box-sizing: border-box; }
body {
    margin: 0;
    padding: 16px;
    font: 13px/1.55 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: var(--fg);
    background: var(--bg);
}
h1 { font-size: 16px; margin: 0 0 2px; display: flex; align-items: center; gap: 8px; }
h1 .hat { font-size: 18px; }
.sub { color: var(--dim); margin: 0 0 14px; }
h2 { font-size: 13px; margin: 0 0 8px; }
section { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 14px; background: var(--soft); }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-weight: 600; font-size: 11px; color: var(--dim); padding: 4px 6px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 4px 6px; border-bottom: 1px dashed var(--line); vertical-align: middle; }
tr:last-child td { border-bottom: none; }
input[type="text"], input[type="number"], select {
    width: 100%;
    font: inherit;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 4px 6px;
}
input:focus, select:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }
select:disabled { opacity: .55; }
button {
    font: inherit;
    white-space: nowrap;
    border-radius: 6px;
    border: 1px solid var(--line);
    background: var(--bg);
    color: var(--fg);
    padding: 4px 10px;
    cursor: pointer;
}
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: #1a1206; font-weight: 600; }
button.ghost { border-style: dashed; color: var(--dim); }
button:disabled { opacity: .5; cursor: default; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
.field { display: grid; grid-template-columns: 1fr 110px; gap: 8px; align-items: center; margin-bottom: 6px; }
.field label { color: var(--dim); }
.field input { text-align: right; }
.hint { color: var(--dim); font-size: 11px; margin-top: 6px; }
.status { min-height: 18px; font-size: 12px; margin-top: 8px; }
.status.ok { color: var(--ok); }
.status.bad { color: var(--bad); }
.run { border-bottom: 1px dashed var(--line); padding: 6px 0; font-size: 12px; }
.run:last-child { border-bottom: none; }
.run .id { font-family: ui-monospace, Consolas, monospace; color: var(--accent); }
.run .meta { color: var(--dim); }
.order { margin-left: 10px; color: var(--dim); }
.empty { color: var(--dim); font-size: 12px; }
details { margin-top: 4px; }
summary { cursor: pointer; color: var(--dim); font-size: 12px; }
td.actions { display: flex; gap: 6px; align-items: center; }
td.actions button { padding: 4px 6px; }
td.actions button.icon { line-height: 1; }
.modal[hidden] { display: none; }
.modal {
    position: fixed; inset: 0; z-index: 40;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.45);
}
.modal-card {
    width: min(640px, 92vw);
    background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 10px;
    padding: 14px 16px; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.4);
}
.modal-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.modal textarea {
    width: 100%; box-sizing: border-box; resize: vertical;
    font: inherit; line-height: 1.6; padding: 8px 10px;
    background: var(--input-bg, transparent); color: var(--fg);
    border: 1px solid var(--line); border-radius: 6px;
}
details[open] summary { margin-bottom: 8px; }
`;

/**
 * 渲染设置页。
 * @returns 完整 HTML 文档。
 */
export function renderPage() {
    const body = String.raw`
<h1><span class="hat">👷</span>包工头</h1>
<p class="sub">这里只填你雇来干活的人；拆单出方案的包工头就是父智能体自己，不占名册。想按专长分工就多雇几个实例，各起各的名字、各用各的模型（例如「力工·前端」「力工·渲染」）。每个承包商的提示词点名字后面的眼睛随时改。</p>

<section>
  <h2>承包商名册</h2>
  <table>
    <thead>
      <tr><th style="width:20%">名字</th><th style="width:20%">provider</th><th style="width:20%">模型</th><th style="width:13%">思考等级</th><th style="width:7%">并发</th><th style="width:5%">启用</th><th style="width:11%"></th></tr>
    </thead>
    <tbody id="roster"></tbody>
  </table>
  <div class="toolbar">
    <button id="add">＋ 添加承包商</button>
    <button class="primary" id="save">保存名册</button>
    <button class="ghost" id="refresh">刷新模型目录</button>
    <span id="roster-status" class="status"></span>
  </div>
  <div class="hint">名字是派单时填的 <code>contractor</code>；并发是同一个承包商同时能接几张单（默认 1，串行）；启用的才参与派单。先选 provider，模型下拉只列这个 provider 自己的模型；provider 选「跟随当前会话」就用父会话当前的模型。眼睛按钮打开该承包商的提示词——写清它擅长什么、该怎么干，派单时会塞进它的工单里。聊天里父模型用 <code>foreman_dispatch</code> 派单、<code>foreman_review</code> 验收。</div>
</section>

<section>
  <h2>最近派单</h2>
  <div id="runs"></div>
</section>

<section>
  <details>
    <summary>派单策略（并发 / 超时 / 返工次数）</summary>
    <div class="field"><label>同时在场承包商</label><input type="number" id="concurrency" min="1" max="8" step="1"></div>
    <div class="field"><label>单张工单超时（秒）</label><input type="number" id="timeoutSeconds" min="10" max="3600" step="10"></div>
    <div class="field"><label>打回后返工次数</label><input type="number" id="maxRework" min="0" max="3" step="1"></div>
    <div class="field"><label>子智能体再派深度</label><input type="number" id="maxDepth" min="0" max="2" step="1"></div>
    <div class="field"><label>subagents provider</label><input type="text" id="provider" placeholder="spawn"></div>
    <div class="field"><label>团队模式</label><label class="check"><input type="checkbox" id="teamMode"> 承包商作为「智能体团队」成员干活（可换模型，走不通自动退回普通模式）</label></div>
    <div class="toolbar">
      <button class="primary" id="save-policy">保存策略</button>
      <span id="policy-status" class="status"></span>
    </div>
    <div class="hint" id="providers-hint"></div>
  </details>
</section>

<div class="modal" id="prompt-modal" hidden>
  <div class="modal-card">
    <div class="modal-head"><strong id="prompt-title">提示词</strong><span class="hint" id="prompt-count"></span></div>
    <textarea id="prompt-text" rows="12" placeholder="写给它一个人的说明：擅长什么、按什么标准干、有哪些禁忌。派单时这段会塞进它的工单提示词里，派单任务本身优先。"></textarea>
    <div class="toolbar">
      <button class="primary" id="prompt-save">保存</button>
      <button class="ghost" id="prompt-cancel">取消</button>
      <span id="prompt-status" class="status"></span>
    </div>
  </div>
</div>
`;

    const script = String.raw`
(function () {
    var P = '/plugins/dsh-agent-foreman';
    var state = { members: [], policy: {}, runs: [], providers: [], subagentProviders: [] };
    var draft = [];
    var catalog = { providers: [] };
    var seq = 0;

    function el(id) { return document.getElementById(id); }
    function status(id, text, bad) {
        var node = el(id);
        node.textContent = text;
        node.className = 'status ' + (bad ? 'bad' : 'ok');
        if (text !== '') setTimeout(function () { if (node.textContent === text) { node.textContent = ''; node.className = 'status'; } }, 6000);
    }
    function request(path, options) {
        return fetch(P + path, Object.assign({ headers: { 'content-type': 'application/json' } }, options || {}))
            .then(function (res) { return res.json().then(function (body) { return { ok: res.ok, body: body }; }); });
    }

    var editing = null;
    function openPrompt(member) {
        editing = member;
        el('prompt-title').textContent = '提示词 · ' + ((member.name || '').trim() || '未命名');
        el('prompt-text').value = member.prompt || '';
        el('prompt-count').textContent = [...(member.prompt || '')].length + ' 字';
        el('prompt-status').textContent = '';
        el('prompt-modal').hidden = false;
        el('prompt-text').focus();
    }
    function closePrompt() { el('prompt-modal').hidden = true; editing = null; }
    el('prompt-text').oninput = function () {
        el('prompt-count').textContent = [...el('prompt-text').value].length + ' 字';
    };
    el('prompt-save').onclick = function () {
        if (!editing) { closePrompt(); return; }
        editing.prompt = el('prompt-text').value;
        var title = (editing.name || '').trim() || '未命名';
        closePrompt();
        renderRoster();
        status('roster-status', '已改「' + title + '」的提示词，点「保存名册」生效');
    };
    el('prompt-cancel').onclick = closePrompt;
    el('prompt-modal').onclick = function (event) {
        if (event.target === el('prompt-modal')) closePrompt();
    };

    function option(value, label, selected) {
        var node = document.createElement('option');
        node.value = value;
        node.textContent = label;
        if (selected) node.selected = true;
        return node;
    }

    function renderRoster() {
        var host = el('roster');
        host.innerHTML = '';
        if (draft.length === 0) {
            var tr = document.createElement('tr');
            var td = document.createElement('td');
            td.colSpan = 7;
            td.className = 'empty';
            td.textContent = '还没有承包商。点「添加承包商」，起个名字就行——模型默认跟当前会话一样。';
            tr.appendChild(td);
            host.appendChild(tr);
            return;
        }
        draft.forEach(function (member, index) {
            var tr = document.createElement('tr');

            var nameTd = document.createElement('td');
            var name = document.createElement('input');
            name.type = 'text';
            name.value = member.name || '';
            name.placeholder = '例如 力工';
            name.oninput = function () { member.name = name.value; };
            nameTd.appendChild(name);
            tr.appendChild(nameTd);

            var providerTd = document.createElement('td');
            var provider = document.createElement('select');
            var providers = catalog.providers || [];
            provider.appendChild(option('', '跟随当前会话', (member.provider || '') === ''));
            var knownProvider = (member.provider || '') === '';
            providers.forEach(function (entry) {
                // 没有模型的 provider 不进下拉：选了也挑不到模型，只会添乱。
                if ((entry.models || []).length === 0) return;
                if (entry.id === member.provider) knownProvider = true;
                provider.appendChild(option(entry.id, entry.name, member.provider === entry.id));
            });
            if (!knownProvider) provider.appendChild(option(member.provider, member.provider + '（目录里已找不到）', true));
            providerTd.appendChild(provider);
            tr.appendChild(providerTd);

            var modelTd = document.createElement('td');
            var model = document.createElement('select');
            modelTd.appendChild(model);
            tr.appendChild(modelTd);

            var effortTd = document.createElement('td');
            var effort = document.createElement('select');
            effortTd.appendChild(effort);
            tr.appendChild(effortTd);

            var parallelTd = document.createElement('td');
            var parallel = document.createElement('input');
            parallel.type = 'number';
            parallel.min = '1';
            parallel.max = '8';
            parallel.step = '1';
            parallel.value = String(member.maxParallel || 1);
            parallel.title = '同一个承包商同时能接几张单';
            parallel.oninput = function () { member.maxParallel = Number(parallel.value) || 1; };
            parallelTd.appendChild(parallel);
            tr.appendChild(parallelTd);

            var enabledTd = document.createElement('td');
            var enabled = document.createElement('input');
            enabled.type = 'checkbox';
            enabled.checked = member.enabled !== false;
            enabled.onchange = function () { member.enabled = enabled.checked; };
            enabledTd.appendChild(enabled);
            tr.appendChild(enabledTd);

            var actionsTd = document.createElement('td');
            actionsTd.className = 'actions';
            var eye = document.createElement('button');
            eye.className = 'ghost icon';
            eye.textContent = '👁';
            eye.title = '编辑这个承包商的提示词';
            eye.onclick = function () { openPrompt(member); };
            actionsTd.appendChild(eye);
            var remove = document.createElement('button');
            remove.textContent = '移除';
            remove.title = '从名册移除（保存后生效）';
            remove.style.padding = '4px 6px';
            remove.onclick = function () { draft.splice(index, 1); renderRoster(); };
            actionsTd.appendChild(remove);
            tr.appendChild(actionsTd);

            /** 模型由 provider 推出：只列这个 provider 自己的模型。 */
            function fillModels() {
                model.innerHTML = '';
                if ((member.provider || '') === '') {
                    model.appendChild(option('', '跟父会话一致', true));
                    model.disabled = true;
                    return;
                }
                model.disabled = false;
                var list = [];
                providers.forEach(function (entry) { if (entry.id === member.provider) list = entry.models || []; });
                model.appendChild(option('', '默认', (member.model || '') === ''));
                var found = (member.model || '') === '';
                list.forEach(function (entry) {
                    if (entry.id === member.model) found = true;
                    model.appendChild(option(entry.id, entry.name, member.model === entry.id));
                });
                // 之前配过但目录里已经没有的模型仍然显示，避免看起来被悄悄清空。
                if (!found) model.appendChild(option(member.model, member.model + '（已不在目录里）', true));
            }

            function fillEfforts(efforts, defaultEffort) {
                effort.innerHTML = '';
                effort.appendChild(option('', defaultEffort ? '默认（' + defaultEffort + '）' : '默认', (member.reasoningEffort || '') === ''));
                (efforts || []).forEach(function (entry) { effort.appendChild(option(entry.id, entry.name, member.reasoningEffort === entry.id)); });
                effort.disabled = (member.provider || '') === '';
            }

            function loadEfforts() {
                if (!member.provider || !member.model) { fillEfforts([], ''); return; }
                request('/api/efforts?provider=' + encodeURIComponent(member.provider) + '&model=' + encodeURIComponent(member.model))
                    .then(function (result) {
                        var body = result.body || {};
                        fillEfforts(body.efforts || [], body.defaultEffort);
                    })
                    .catch(function () { fillEfforts([], ''); });
            }

            provider.onchange = function () {
                member.provider = provider.value;
                // provider 换了，旧模型/旧等级必然失效，必须清掉。
                member.model = '';
                member.reasoningEffort = '';
                fillModels();
                fillEfforts([], '');
            };
            model.onchange = function () {
                member.model = model.value;
                member.reasoningEffort = '';
                loadEfforts();
            };
            effort.onchange = function () { member.reasoningEffort = effort.value; };

            fillModels();
            fillEfforts([], '');
            loadEfforts();
            host.appendChild(tr);
        });
    }

    function renderPolicy() {
        var policy = state.policy || {};
        el('concurrency').value = policy.concurrency;
        el('timeoutSeconds').value = policy.timeoutSeconds;
        el('maxRework').value = policy.maxRework;
        el('maxDepth').value = policy.maxDepth;
        el('provider').value = policy.provider || '';
        el('teamMode').checked = policy.teamMode === true;
        var hint = el('providers-hint');
        hint.textContent = state.subagentProviders && state.subagentProviders.length
            ? '当前宿主注册的 subagents provider：' + state.subagentProviders.join('、')
            : '读不到 subagents provider 列表（未启动或不可用）。';
    }

    function renderRuns() {
        var host = el('runs');
        host.innerHTML = '';
        var runs = state.runs || [];
        if (runs.length === 0) {
            host.innerHTML = '<div class="empty">还没有派过单。在聊天里让父智能体派一轮之后，每轮都会记在这里。</div>';
            return;
        }
        runs.slice(0, 8).forEach(function (run) {
            var div = document.createElement('div');
            div.className = 'run';
            var head = document.createElement('div');
            head.innerHTML = '<span class="id"></span> <span class="meta"></span>';
            head.querySelector('.id').textContent = run.id;
            var when = run.at ? new Date(run.at).toLocaleString() : '';
            head.querySelector('.meta').textContent = ' · ' + (run.goal || '（无目标）') + ' · ' + when + ' · ' + (run.status || '');
            div.appendChild(head);
            (run.orders || []).forEach(function (order) {
                var line = document.createElement('div');
                line.className = 'order';
                var verdict = order.verdict === 'pass' ? ' ✔已验收' : order.verdict === 'fail' ? ' ✖打回' : '';
                line.textContent = order.id + ' ' + order.title + ' · ' + (order.contractor || '未分配')
                    + (order.route ? ' / ' + order.route : '') + ' · ' + Math.round((order.durationMs || 0) / 100) / 10 + 's'
                    + verdict;
                div.appendChild(line);
            });
            host.appendChild(div);
        });
    }

    function loadCatalog() {
        return request('/api/catalog').then(function (result) {
            if (result.ok && result.body && result.body.providers) catalog = result.body;
        });
    }

    function loadState() {
        return request('/api/state').then(function (result) {
            if (!result.ok) throw new Error((result.body && result.body.error) || '读取状态失败');
            state = result.body;
            draft = (state.members || []).map(function (member) { return Object.assign({}, member); });
            renderRoster();
            renderPolicy();
            renderRuns();
        });
    }

    el('add').onclick = function () {
        draft.push({ id: 'member-' + (++seq) + '-' + Date.now().toString(36), name: '', prompt: '', provider: '', model: '', reasoningEffort: '', maxParallel: 1, enabled: true });
        renderRoster();
    };

    el('save').onclick = function () {
        var rows = draft.map(function (member) {
            return {
                id: member.id,
                name: (member.name || '').trim(),
                prompt: member.prompt || '',
                provider: (member.provider || '').trim(),
                model: (member.model || '').trim(),
                reasoningEffort: (member.reasoningEffort || '').trim(),
                maxParallel: Number(member.maxParallel) || 1,
                enabled: member.enabled !== false,
            };
        }).filter(function (member) { return member.name !== ''; });
        request('/api/members', { method: 'POST', body: JSON.stringify({ members: rows }) })
            .then(function (result) {
                if (!result.ok) { status('roster-status', (result.body && result.body.error) || '保存失败', true); return; }
                draft = (result.body.members || []).map(function (member) { return Object.assign({}, member); });
                renderRoster();
                status('roster-status', '已保存 ' + draft.length + ' 个承包商');
                return loadState();
            })
            .catch(function (error) { status('roster-status', String(error.message || error), true); });
    };

    el('refresh').onclick = function () {
        loadCatalog().then(function () { renderRoster(); status('roster-status', '模型目录已刷新'); });
    };

    el('save-policy').onclick = function () {
        var patch = {
            concurrency: Number(el('concurrency').value),
            timeoutSeconds: Number(el('timeoutSeconds').value),
            maxRework: Number(el('maxRework').value),
            maxDepth: Number(el('maxDepth').value),
            provider: el('provider').value,
            teamMode: el('teamMode').checked,
        };
        request('/api/policy', { method: 'POST', body: JSON.stringify(patch) })
            .then(function (result) {
                if (!result.ok) { status('policy-status', (result.body && result.body.error) || '保存失败', true); return; }
                state.policy = result.body.policy;
                renderPolicy();
                status('policy-status', '策略已保存');
            })
            .catch(function (error) { status('policy-status', String(error.message || error), true); });
    };

    loadCatalog().then(loadState).catch(function (error) {
        el('roster').innerHTML = '<tr><td class="empty">加载失败：' + String(error.message || error) + '</td></tr>';
    });
})();
`;

    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>包工头</title>
<style>${STYLE}</style>
</head>
<body>
${body}
<script>${script}</script>
</body>
</html>
`;
}
