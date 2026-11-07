# Foreman · dsh-agent-foreman

> Parent agent dispatches, sub-agents do the work, the parent reviews.
> No preset roles, no scripted phases: **you decide who works and with which model**.

Chinese docs: [README.zh.md](README.zh.md) · [Install / upgrade](docs/INSTALL.md)

**Latest release: v0.4.1 (2026-11-07)** — re-verified against DSH 0.2.2-rc.1 with forward-compatible provider discovery.

## The problem

DSH's built-in Agent Team lets you give each teammate a name and a prompt — but **not a model**.
Real work is mixed: some of it needs an expensive model, some of it is a two-line edit.
Inheriting the parent's model for every pair of hands is both slow and expensive.

Foreman splits it in two:

- **Contractors** — the crew you define in the settings page, named by trade like a real
  construction site: 力工 (laborer — does the business work) and, optionally, 安全员 (safety officer
  — reviews and rejects). The foreman itself is the parent agent: it splits the work and signs off,
  and is never in the roster. Want specialties? **Hire several instances** (力工 · frontend,
  力工 · render), each with its own model and **its own prompt** (the Edit prompt button),
  and its own ordinary-mode concurrency cap (default 1). Native team mode always serializes
  one member’s inbox; use additional members for independent parallel work. That prompt is prepended to every order the contractor receives. **The minimal setup
  is a single 力工.**
- **Orders** — the work the parent agent splits out. Each order carries a task and acceptance
  criteria, and may name a contractor or leave it out to be picked by live load (busy contractors
  are skipped, the least loaded one wins, and a rotation cursor breaks ties — cross-session).

The parent only splits work and reviews results. Everything in between happens in isolated child
sessions, and the products come back as one shared board.

## Install

```bash
dsh plugin add E:/path/to/dsh-agent-foreman
```

Manual (dev) install:

1. Copy the whole directory to `<profile>/node_modules/dsh-agent-foreman`
2. Add `"dsh-agent-foreman"` to `dsh.profile.bundles` in `<profile>/package.json`
3. Restart DSH

Then open **Settings → 包工头** and add contractors.

## Usage

![Settings → 包工头: responsive contractor groups with readable models and Edit prompt controls](docs/settings-roster.png)

Type `/foreman` (registered at runtime through `ctx.skills.register()`) followed by the work:
`/foreman extract GraphBlocked into shared logic; add regression tests`. Semicolons or newlines
split orders. The skill body walks the parent through roster → split → one dispatch → review, so no
standing system prompt is needed.

| Tool | Purpose |
| --- | --- |
| `foreman_roster` | List contractors with route, prompt length, concurrency cap, and the current policy |
| `foreman_dispatch` | Dispatch a batch of orders, wait for all of them, return the board |
| `foreman_review` | Pass / fail each order; a failed one is re-dispatched with feedback |
| `foreman_status` | Re-read a board; omit `runId` for the latest one in this session |

### Where members show up

**Settings → 包工头 → 实时工地** is a polling board over `api/live`: whether the foreman is
working, each contractor's role and model, and every order's status / dependencies / error /
artifact path for the current round. It pauses itself while the page is hidden.

The important part: the board shows both the **declared model** (what the roster says) and the
**actual model** (read back from the child session's header). When they differ the row is
flagged — that is the direct answer to "which model is actually running this order". In team
mode the actual model comes from the host's `listMembers()` model field.

In team mode a contractor **is** a real Agent Teams member, so the native `Agent Teams` button in
the session header lists them too. The settings page keeps the full roster editor.

Roster notes:

- A contractor is a name, an optional role (a lightweight trade label for routing, not a fixed
  persona), an optional prompt, a provider, a model, an effort level and a concurrency cap.
  **Leave the provider on "follow the current session" and the child simply runs on whatever model
  the parent session is using.**
- To use a different model: pick the provider first — **the model dropdown is derived from it** and
  only lists that provider's models (providers with no models never show up).
- Settings page collapses policy behind "派单策略". Each contractor has a responsive group with
  readable model/effort controls, a full configured-route summary and an Edit prompt button.
  The header popover stays inside the viewport and distinguishes configured from observed models.

### The roster *is* the whitelist

The host keeps its own **subagent model whitelist** (`subagent-model-selection`), which decides
which provider/model routes child agents may use. That list and the roster are configured
separately, so when they drift apart the roster says `trae` while the children quietly run
something else — with no error anywhere.

This plugin folds that into one place: **every enabled contractor with an explicit provider+model
is collected into the host whitelist automatically.** You only maintain the roster.

- Synced once at plugin startup, again after saving the roster, and on demand via
  `POST /api/whitelist/sync`.
- If no contractor declares an explicit route (all "follow the current session"), the host
  configuration is left untouched — an empty list makes the host throw.
- Applies to **new sessions only**. The host snapshots the whitelist into a session when that
  session is first created, so existing sessions keep the old list; open a new session after
  changing the roster.
- A failed sync never blocks dispatch — it only logs. `/api/state` exposes the live `whitelist`
  field.

Dispatch notes:

- `orders[].task` **must be self-contained** — the child cannot see the parent's context.
- `orders[].contractor` accepts a contractor **name or id**, or a `role` trade label; name/id
  matching takes precedence over role matching. An unknown selector reports an error instead of
  silently reassigning the work.
- **Omitting `contractor` picks by live load, not roster order.** Candidates with spare capacity
  (running orders < that contractor's `maxParallel`) come first, then the least loaded one; a
  rotation cursor only breaks ties. Load is **cross-session**: if another session already has
  the first contractor busy, this session's orders go elsewhere instead of piling onto it. The
  cursor persists in `<data dir>/rotate-cursors.json`, so restarting DSH continues where it left
  off rather than snapping back to the first name.
  So **omit `contractor` by default**; name someone only when that specific contractor must do
  the work. Writing `contractor: "力工"` on every order bypasses load balancing, leaves the rest
  of the roster idle and serializes the work — do that only when the roster really has a single
  enabled contractor.
- `foreman_roster` reports each contractor's **idle / running** state (cross-session), so you can
  decide whether naming someone is worth it.
- `orders[].dependsOn` only references orders in the same batch. An order becomes ready as soon
  as **all its dependencies complete successfully**; it does not wait for an entire dependency
  layer. Unrelated work still runs concurrently, up to the global default of **4** (maximum 8)
  and each contractor's own concurrency cap.
- Failure, timeout or cancellation of an order marks its downstream orders **skipped**, and a
  skipped dependency blocks the rest of its chain. The board records the blocking error rather
  than executing downstream work with missing inputs.
- `waitSeconds` caps the whole batch; unfinished orders are aborted rather than silently reported done.
- Live status exposes dependency relationships, errors and artifact paths alongside progress;
  it is a status view, not a separate real-time DAG editor.

## Policy

| Field | Default | Meaning |
| --- | --- | --- |
| `concurrency` | 4 | Contractors working at once (1–8); the per-instance cap lives in the roster |
| `timeoutSeconds` | 900 | Wall-clock cap per order |
| `maxRework` | 1 | How many times an order may be sent back |
| `maxDepth` | 1 | Whether a child may dispatch further children |
| `provider` | `spawn` | Which subagents provider to use (`spawn` / `fork` / `cursor`) |

## Data

- Windows: `%LOCALAPPDATA%/dsh-agent-foreman/`
- Elsewhere: `<baseDir>/data/dsh-agent-foreman/`

`roster.json` stores contractors (including roles) and policy. Run snapshots live under `runs/`.
After restarting, you can query and review a **settled** board from its saved snapshot; work that
was interrupted is not automatically re-dispatched or resumed. Recovery restores explicit status
for inspection and review, not a background execution engine. Full delivery text, when available,
is stored separately under `artifacts/` and linked from the board by its path.

A corrupt roster never blocks startup — it is treated as empty and logged.

## Security

- Every HTTP route accepts same-origin, loopback requests only; cross-site calls get 403.
- The roster stores provider/model/effort names — never credentials.
- Contractors run in their own child sessions and inherit DSH's effective sandbox.

## Development

```bash
npm install --ignore-scripts
npm test
```

Install development dependencies first: the schema package is both a runtime peer dependency and
a development dependency used by the test suite. `test/harness.test.mjs` runs the real host half
against a fake host, so no DSH instance is needed. The suite covers tools, engine, routes, CSRF,
ledger and compatibility regressions.

## Compared to

| | Agent Team (built-in) | dsh-agent-teams | Foreman |
| --- | --- | --- | --- |
| Per-member model | no | no | **yes** — `agentOptions` locked at creation |
| Cross-round memory | no | yes — previousResult | yes — history in prompt |
| Native team tab | yes | yes | yes — shared tasks |
| Self-report recovery | no | yes — update_task | yes — `foreman_report` |
| Real route echo | no | no | **yes** — declared vs actual model |
| Whitelist sync | no | no | **yes** — roster is the single source |
| Job site panel | no | yes — activity panel | **yes** — header button + real model |
| Dep scheduling + failure block | no | yes — DAG | yes — ready scheduling + skipped |
| Rework loop | no | manual | yes — auto with feedback |
| Settings page | yes | no | yes — roster + model catalog |

**Key difference**: Foreman's **per-member model selection + real route echo** is unique.
dsh-agent-teams excels at full task DAG (claim/attempt/quality gates) for complex multi-phase
projects; Foreman focuses on **model-based dispatch and per-order review** with fewer tools
(5 vs 14) and faster onboarding.

## Team mode (experimental)

Enabled for new configurations; saved policies are preserved. Enable **团队模式** in
Settings → 包工头 → 派单策略, then select each contractor's own provider, model and
optional reasoning effort. Members are created through native `agentTeams.spawnTeammate`,
not standalone activations presented as team members.

The current host does not publicly forward model options. A guarded **per-call** service
adapter adds `request.agentOptions` to the native reserved-child activation. This preserves
real roster membership and creation-time routing, including the first request and durable
child descriptor. It never replaces a global method, changes the parent/default model, or
modifies the host ASAR. An offline contract test runs against the installed DSH
`0.2.1-rc.5` TeamService/TeamRoster source, and the bridge was re-verified against
`0.2.2-rc.1` (the `roster.spawn` / `startActivation` spec is unchanged; the host still
does not forward `agentOptions`). Internal shape changes fail visibly; arbitrary
future host versions are not guaranteed compatible.

Before work is sent, the handshake completes and actual request configuration is verified.
Work and rework use native team messages and the same member Session. Reports carry
run/attempt tokens; session-text recovery waits for the member turn to stop.

- Different members run in parallel; work for **one** native member is serialized, even if
  its ordinary-mode maxParallel is higher. Add roster members for independent parallel work.
- Names contain stable contractor-and-route fingerprints. Original names remain in descriptions.
- No silent fallback to parent models or standalone children. Disable team mode explicitly
  if ordinary subagents are desired.
- Timeouts settle promptly; unconfirmed cleanup quarantines the member instead of reusing it.
- Dormant native roster labels may fall back to the parent's model; request records, not
  those display labels, are the authoritative route evidence.
- Restart DSH after updating the locally installed host plugin; refreshing the page is insufficient.

## Changelog

### 0.4.1 (2026-11-07)

- **DSH 0.2.2-rc.1 compatibility audit**: no breaking change found in the host APIs this
  plugin uses (`commands`, `skills`, `tools.register`, `subagentModelSelection` volatile refs,
  cosmokit's volatile write symbol, `startActivation`'s `request.agentOptions`,
  `subagents.providers`, `llm.resolveModelInfo`, and the native-team `roster.spawn` bridge).
  The internal bridge is re-verified against 0.2.2-rc.1.
- **Forward-compatible provider discovery**: `readSubagentProviders` now prefers the public
  `subagents.list()` added in 0.2.2-rc.1, so custom provider names are found without poking
  the internal `providers` Map; older hosts still fall back to the Map / `getProvider`.
- **Stronger `engines.dsh`**: the range now explicitly covers the `0.2.2` prerelease line, so
  it passes under both standard semver and the host's `includePrerelease: true` check. Previously
  `0.2.2-rc.1` only passed with the host's relaxed semantics.
- **Loaded-runtime marker bumped** to `native-team-v3-20261107` so the worksite panel can tell
  the reloaded plugin code from a stale copy. Minor cleanup of the blank-`orderId` report message.
- **157 tests pass** (155 pass, 2 optional host/browser contract tests skipped without env vars).

### 0.4.0 (2026-10-31)

- **Real native mixed-model teammates**: a guarded per-call TeamService/TeamRoster adapter
  registers real teammates and assigns provider/model/effort at creation. No global model changes.
- **Verified routing**: check actual request configuration before delivering work; host incompatibility
  or model mismatch fails visibly instead of falling back to the parent or a substitute session.
  The internal bridge is verified against DSH 0.2.1-rc.5, not guaranteed for arbitrary host versions.
- **Safer delivery**: per-member serialization, completed-turn text recovery, attempt-scoped report
  tokens, stable route fingerprints and timeout quarantine protect against stale or mixed output.
- **Responsive settings**: contractor groups replace cramped table columns, with full configured
  routes and readable model, concurrency and prompt controls from 320 to 1100 pixels.
- **Worksite panel**: top-layer placement avoids sidebar clipping; loaded-runtime markers and
  configured/observed model labels make stale host code visible.
- **Validation**: 151 tests pass with installed-host contracts and Chrome browser checks enabled.
  Live native calls verified TRAE, WorkBuddy and Qoder; Qoder Global/gfmodel returned an upstream
  RESOURCE_LIMIT queue error and did not produce a successful model response.
- **Upgrade**: fully restart DSH after installation; a browser refresh alone is insufficient.

### 0.3.0 (2026-10-29)

- **Load-aware dispatch**: omitting `contractor` no longer walks the roster in order. Candidates
  with spare capacity (running orders < that contractor's `maxParallel`) come first, then the
  least loaded one; a rotation cursor only breaks ties. Load is **cross-session** — when another
  session already has a contractor busy, this session's orders go elsewhere instead of piling
  onto the first name in the roster.
- **Persisted rotation cursor**: the cursor moved out of `assignContractors`' local scope into
  the engine instance and onto disk (`<data dir>/rotate-cursors.json`), fixing "every dispatch
  starts at the first contractor" and surviving DSH restarts.
- **`foreman_roster` shows busy/idle**: each contractor is labelled 「空闲 / 在跑 N 单」 from the
  real cross-session state.
- **Corrected tool and skill wording**: "omit `contractor` by default; name someone only when
  that specific contractor must do the work." The old `foreman_dispatch` description pushed the
  model to write `contractor: "力工"` explicitly, which bypassed load balancing entirely.
- **Rework reuses the session**: a rework order continues in the existing contractor session
  (`steer`/`submitPrompt` when the host exposes them, otherwise re-activating the same
  `childId`) instead of spawning a fresh subagent and losing the member's context.
- **Rework prompt carries the round number**: a sent-back order says 「本单第 N 轮提交」 so a
  resumed session knows not to start over.

### 0.2.0 (2026-10-28)

- **Self-member system**: `subagents.startActivation` + `agentOptions` locks model at creation,
  no longer relying on `spawnTeammate` (which cannot specify models)
- **Cross-round memory**: history concatenated into prompt (like agent-teams' previousResult)
- **`foreman_report` self-report tool**: product recovery without reading member sessions
- **Real route echo**: `actualRoute` / `routeMismatch` — declared vs actual model comparison
- **Whitelist sync**: roster auto-syncs to host subagent model whitelist
- **Job site panel**: "🏗 工地" button in session header with live model and order status
- **Dependency-ready scheduling**: no layer barriers, failure blocks downstream as `skipped`
- **Snapshot recovery**: `runs/` atomic snapshots, queryable after restart, never auto-reruns
- **Roster roles**: `role` field supports role-based order rotation

### 0.1.0

- Initial release: roster management, dispatch engine, board, settings page

## License

MIT
