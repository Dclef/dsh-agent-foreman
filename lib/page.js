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
.order-sub { margin-left: 24px; color: var(--dim); font-size: 11px; }
.order-sub.warn { color: var(--bad); }
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
.live-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; font-size: 12px; }
.live-head .who { font-weight: 600; }
.live-head .meta { color: var(--dim); }
.pill {
    display: inline-block; border: 1px solid var(--line); border-radius: 999px;
    padding: 0 8px; font-size: 11px; line-height: 18px; background: var(--bg); color: var(--dim);
}
.pill.live { border-color: var(--accent); color: var(--accent); }
.pill.wait { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
.pill.done { border-color: var(--ok); color: var(--ok); }
.pill.off { color: var(--dim); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 8px; margin-top: 10px; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--bg); font-size: 12px; }
.card .row { display: flex; gap: 6px; justify-content: space-between; align-items: baseline; }
.card .row + .row { margin-top: 4px; }
.card .who { font-weight: 600; }
.card .meta { color: var(--dim); }
.mono { font-family: ui-monospace, Consolas, monospace; }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--line); vertical-align: middle; }
.dot.on { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.warn { color: var(--bad); font-weight: 600; font-size: 11px; }
.live-order { font-size: 12px; padding: 5px 0; border-bottom: 1px dashed var(--line); }
.live-order:last-child { border-bottom: none; }
.live-order .mark { font-family: ui-monospace, Consolas, monospace; color: var(--accent); }
.live-order .id { font-family: ui-monospace, Consolas, monospace; }
.live-order .meta { color: var(--dim); }
.live-order .sub { color: var(--dim); margin-left: 14px; font-size: 11px; }
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
      <tr><th style="width:20%">名字</th><th style="width:20%">provider</th><th style="width:22%">模型</th><th style="width:13%">思考等级</th><th style="width:7%">并发</th><th style="width:5%">启用</th><th style="width:13%"></th></tr>
    </thead>
    <tbody id="roster"></tbody>
  </table>
  <div class="toolbar">
    <button id="add">＋ 添加承包商</button>
    <button class="primary" id="save">保存名册</button>
    <button class="ghost" id="refresh">刷新模型目录</button>
    <span id="roster-status" class="status"></span>
  </div>
  <div class="hint">名字是派单时填的 <code>contractor</code>（精确点名到这个人）；想按专长分工就多雇几个实例、各起各的名字，例如「力工-前端」「力工-后端」。并发是同一个承包商同时能接几张单（默认 1，串行）；启用的才参与派单。先选 provider，模型下拉只列这个 provider 自己的模型；provider 选「跟随当前会话」就用父会话当前的模型。眼睛按钮打开该承包商的提示词，写清它擅长什么、该怎么干，派单时会塞进它的工单里。聊天里父模型用 <code>foreman_dispatch</code> 派单、<code>foreman_review</code> 验收。</div>
</section>

<section>
  <h2>实时工地 <span class="hint" id="live-tick"></span></h2>
  <div class="live-head" id="live-lead"></div>
  <div class="grid" id="live-members"></div>
  <div style="margin-top:12px">
    <div class="hint" style="margin:0 0 4px">本轮工单</div>
    <div id="live-orders"></div>
  </div>
  <div class="hint">每 2.5 秒问一次 <code>/api/live</code>；页面切到后台时暂停，切回来立刻刷新。「声明」是你在这个页面里给这个承包商配的 provider/模型，「真实」是本轮它实际跑出来的路由——两者不一致就说明选模型没落到子会话上。</div>
</section>

<section>
  <h2>最近派单</h2>
  <div class="toolbar" style="margin-top:6px">
    <label for="run-picker" class="hint" style="margin:0">查看轮次</label>
    <select id="run-picker" style="width:auto;min-width:280px;max-width:100%"></select>
    <span id="run-picker-hint" class="hint" style="margin:0"></span>
  </div>
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
            name.placeholder = '例如 力工-前端';
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

    /**
     * 「最近派单」：下拉框选一轮，下面只渲染那一轮。
     *
     * state.runs 是倒序的（新在前）。默认选第一项（也就是最近一轮）；用户手动选过
     * 之后记住选择，但若那个 runId 已经不在列表里（例如被台账裁剪）就回退到最近一轮，
     * 避免下拉框和下面内容对不上。
     */
    var selectedRunId = '';

    function statusText(status) {
        var zh = {
            running: '干活中', rework: '返工中', 'waiting-review': '待验收',
            accepted: '已验收', closed: '已结案',
        };
        return zh[status] || status || '';
    }

    function renderPickers() {
        var runs = state.runs || [];
        var picker = el('run-picker');
        var hint = el('run-picker-hint');
        picker.innerHTML = '';
        if (runs.length === 0) {
            picker.disabled = true;
            picker.appendChild(option('', '（还没有派过单）', true));
            if (hint) hint.textContent = '';
            selectedRunId = '';
            return;
        }
        picker.disabled = false;
        if (!runs.some(function (run) { return run.id === selectedRunId; }))
            selectedRunId = runs[0].id;
        runs.forEach(function (run, index) {
            var when = run.at ? new Date(run.at).toLocaleString() : '';
            var goal = (run.goal || '（无目标）');
            if (goal.length > 24) goal = goal.slice(0, 24) + '…';
            var orderCount = (run.orders || []).length;
            var label = run.id + ' · ' + goal + ' · ' + statusText(run.status)
                + ' · ' + orderCount + ' 单' + (when ? ' · ' + when : '');
            if (index === 0) label = '【最近】' + label;
            picker.appendChild(option(run.id, label, run.id === selectedRunId));
        });
        if (hint)
            hint.textContent = '共 ' + runs.length + ' 轮';
        picker.onchange = function () {
            selectedRunId = picker.value;
            renderRuns();
        };
    }

    function renderRuns() {
        var host = el('runs');
        host.innerHTML = '';
        var runs = state.runs || [];
        if (runs.length === 0) {
            host.innerHTML = '<div class="empty">还没有派过单。在聊天里让父智能体派一轮之后，每轮都会记在这里。</div>';
            return;
        }
        var run = null;
        for (var i = 0; i < runs.length; i += 1) {
            if (runs[i].id === selectedRunId) { run = runs[i]; break; }
        }
        if (run === null) run = runs[0];

        var div = document.createElement('div');
        div.className = 'run';
        var head = document.createElement('div');
        head.innerHTML = '<span class="id"></span> <span class="meta"></span>';
        head.querySelector('.id').textContent = run.id;
        var when = run.at ? new Date(run.at).toLocaleString() : '';
        head.querySelector('.meta').textContent = ' · ' + (run.goal || '（无目标）')
            + ' · ' + when + ' · ' + statusText(run.status);
        div.appendChild(head);

        var orders = run.orders || [];
        if (orders.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '这一轮没有工单记录。';
            div.appendChild(empty);
        }
        orders.forEach(function (order) {
            var line = document.createElement('div');
            line.className = 'order';
            var verdict = order.verdict === 'pass' ? ' ✔已验收' : order.verdict === 'fail' ? ' ✖打回' : '';
            var mark = order.status === 'done' ? '✔'
                : order.status === 'skipped' ? '⊘'
                : (order.status === 'failed' || order.status === 'timeout') ? '✖'
                : order.status === 'running' ? '…' : '·';
            // 真实路由优先显示：声明对不代表子会话真的跑在那档模型上。
            var route = order.actualRoute || order.route || '';
            var label = (order.actualRoute ? '真实 ' : '声明 ') + route;
            line.textContent = mark + ' ' + order.id + ' ' + order.title
                + ' · ' + (order.contractor || '未分配')
                + (route ? ' / ' + label : '')
                + ' · ' + Math.round((order.durationMs || 0) / 100) / 10 + 's'
                + verdict;
            div.appendChild(line);
            var extra = [];
            if (order.routeMismatch === true) extra.push('⚠ 真实模型与名册不一致');
            if (order.error) extra.push(order.error);
            if (extra.length > 0) {
                var sub = document.createElement('div');
                sub.className = 'order-sub' + (order.routeMismatch === true ? ' warn' : '');
                sub.textContent = extra.join(' · ');
                div.appendChild(sub);
            }
        });
        host.appendChild(div);
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
            renderPickers();
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

    /** 实时工地：轮询 /api/live，页面隐藏时停表。 */
    var liveTimer = null;
    var liveFailures = 0;

    var RUN_LABEL = { running: '干活中', rework: '返工中', 'waiting-review': '待验收', accepted: '已验收', closed: '已结案' };
    var RUN_CLASS = { running: 'live', rework: 'live', 'waiting-review': 'wait', accepted: 'done', closed: 'done' };
    var ORDER_MARK = { queued: '·', running: '…', done: '✔', failed: '✖', timeout: '✖', skipped: '⊘' };

    function text(value) { return value === undefined || value === null ? '' : String(value); }

    function pill(label, cls) {
        var node = document.createElement('span');
        node.className = 'pill' + (cls ? ' ' + cls : '');
        node.textContent = label;
        return node;
    }

    function renderLead(run) {
        var host = el('live-lead');
        host.innerHTML = '';
        if (!run) {
            host.appendChild(pill('待命', 'off'));
            var empty = document.createElement('span');
            empty.className = 'meta';
            empty.textContent = '还没有派过单';
            host.appendChild(empty);
            return;
        }
        var who = document.createElement('span');
        who.className = 'who';
        who.textContent = '包工头';
        host.appendChild(who);
        host.appendChild(pill(RUN_LABEL[run.status] || text(run.status) || '未知', RUN_CLASS[run.status] || ''));
        var id = document.createElement('span');
        id.className = 'meta mono';
        id.textContent = '轮次 ' + (text(run.id) || '—');
        host.appendChild(id);
        var goal = document.createElement('span');
        goal.className = 'meta';
        goal.textContent = '目标：' + (text(run.goal) || '（无目标）');
        host.appendChild(goal);
        if (run.matched === false) host.appendChild(pill('不是本会话', 'off'));
        if (run.recovered === true) host.appendChild(pill('已恢复', 'off'));
        if (run.interrupted === true) host.appendChild(pill('中断过', 'wait'));
        if (text(run.updatedAt) !== '') {
            var when = document.createElement('span');
            when.className = 'meta';
            when.textContent = '更新于 ' + new Date(run.updatedAt).toLocaleTimeString();
            host.appendChild(when);
        }
    }

    function renderLiveMembers(members) {
        var host = el('live-members');
        host.innerHTML = '';
        var list = members || [];
        if (list.length === 0) {
            host.innerHTML = '<div class="empty">名册还是空的，先去下面「承包商名册」雇人。</div>';
            return;
        }
        list.forEach(function (member) {
            var card = document.createElement('div');
            card.className = 'card';

            var head = document.createElement('div');
            head.className = 'row';
            var who = document.createElement('span');
            who.className = 'who';
            who.textContent = text(member.name) || '未命名';
            head.appendChild(who);
            var dot = document.createElement('span');
            dot.className = 'dot' + (member.status === 'running' ? ' on' : '');
            dot.title = member.status === 'running' ? '在跑' : '空闲';
            head.appendChild(dot);
            card.appendChild(head);

            var busyRow = document.createElement('div');
            busyRow.className = 'row';
            var busy = document.createElement('span');
            busy.className = 'meta';
            busy.textContent = '在跑 ' + (Number(member.orders) || 0) + ' 单';
            busyRow.appendChild(busy);
            card.appendChild(busyRow);

            var declared = document.createElement('div');
            declared.className = 'row';
            var declaredLabel = document.createElement('span');
            declaredLabel.className = 'meta';
            declaredLabel.textContent = '声明 provider/model';
            declared.appendChild(declaredLabel);
            var declaredValue = document.createElement('span');
            declaredValue.className = 'mono';
            declaredValue.textContent = text(member.model) || '跟随当前会话';
            declared.appendChild(declaredValue);
            card.appendChild(declared);

            var actual = document.createElement('div');
            actual.className = 'row';
            var actualLabel = document.createElement('span');
            actualLabel.className = 'meta';
            actualLabel.textContent = '真实 provider/model';
            actual.appendChild(actualLabel);
            var actualValue = document.createElement('span');
            actualValue.className = 'mono';
            actualValue.textContent = text(member.actualModel) || '还没跑过';
            actual.appendChild(actualValue);
            card.appendChild(actual);

            // 声明与真实不一致：给一行醒目文字，别让人以为选模型生效了。
            if (text(member.actualModel) !== '' && text(member.model) !== '' && text(member.actualModel) !== text(member.model)) {
                var warn = document.createElement('div');
                warn.className = 'warn';
                warn.textContent = '真实模型与名册不一致';
                card.appendChild(warn);
            }
            if (member.enabled === false) {
                var off = document.createElement('div');
                off.className = 'meta';
                off.textContent = '（已停用）';
                card.appendChild(off);
            }
            host.appendChild(card);
        });
    }

    function renderLiveOrders(run) {
        var host = el('live-orders');
        host.innerHTML = '';
        var orders = (run && run.orders) || [];
        if (!run) {
            host.innerHTML = '<div class="empty">还没有派过单。父智能体一开派，工单会实时出现在这里。</div>';
            return;
        }
        if (orders.length === 0) {
            host.innerHTML = '<div class="empty">本轮没有工单。</div>';
            return;
        }
        orders.forEach(function (order) {
            var line = document.createElement('div');
            line.className = 'live-order';

            var head = document.createElement('div');
            var mark = document.createElement('span');
            mark.className = 'mark';
            mark.textContent = ORDER_MARK[order.status] || '?';
            head.appendChild(mark);
            head.appendChild(document.createTextNode(' '));
            var id = document.createElement('span');
            id.className = 'id';
            id.textContent = text(order.id);
            head.appendChild(id);
            head.appendChild(document.createTextNode(' '));
            var title = document.createElement('span');
            title.textContent = text(order.title);
            head.appendChild(title);
            var meta = document.createElement('span');
            meta.className = 'meta';
            var seconds = order.durationMs === undefined ? '' : ' · ' + (Math.round((Number(order.durationMs) || 0) / 100) / 10) + 's';
            var depends = (order.dependsOn || []).length ? ' · 依赖 ' + order.dependsOn.join('、') : '';
            var verdict = order.verdict === 'pass' ? ' · 已验收' : order.verdict === 'fail' ? ' · 打回' : '';
            meta.textContent = ' · ' + (text(order.contractor) || '未分配') + seconds + depends + verdict;
            head.appendChild(meta);
            line.appendChild(head);

            var extra = '';
            if (order.status === 'skipped' || order.status === 'failed' || order.status === 'timeout')
                extra = text(order.error);
            if (text(order.routeNote) !== '')
                extra = extra === '' ? text(order.routeNote) : extra + ' · ' + text(order.routeNote);
            if (order.routeMismatch === true && text(order.actualRoute) !== '')
                extra = extra === '' ? '真实路由 ' + text(order.actualRoute) : extra + ' · 真实路由 ' + text(order.actualRoute);
            if (extra !== '') {
                var err = document.createElement('div');
                err.className = 'sub' + (order.routeMismatch === true ? ' warn' : '');
                err.textContent = (order.status === 'skipped' ? '⊘ ' : '') + extra;
                line.appendChild(err);
            }
            if (text(order.artifactPath) !== '') {
                var artifact = document.createElement('div');
                artifact.className = 'sub mono';
                artifact.textContent = '产物 ' + text(order.artifactPath);
                line.appendChild(artifact);
            }
            host.appendChild(line);
        });
    }

    function renderLive(body) {
        var live = body || {};
        renderLead(live.run || null);
        renderLiveMembers(live.members || []);
        renderLiveOrders(live.run || null);
    }

    function liveTick() {
        if (document.hidden) return;
        fetch(P + '/api/live')
            .then(function (res) { return res.json(); })
            .then(function (body) {
                if (!body || body.ok !== true) throw new Error('live 读取失败');
                liveFailures = 0;
                el('live-tick').textContent = '';
                el('live-tick').className = 'hint';
                renderLive(body);
            })
            .catch(function () {
                liveFailures += 1;
                el('live-tick').textContent = '连接中断，重试中（第 ' + liveFailures + ' 次）';
                el('live-tick').className = 'hint warn';
            });
    }

    function startLive() {
        if (liveTimer !== null) return;
        liveTick();
        liveTimer = setInterval(liveTick, 2500);
    }

    function stopLive() {
        if (liveTimer === null) return;
        clearInterval(liveTimer);
        liveTimer = null;
    }

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) stopLive();
        else startLive();
    });

    loadCatalog().then(loadState).then(startLive).catch(function (error) {
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
