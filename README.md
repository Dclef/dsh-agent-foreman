# Foreman · dsh-agent-foreman

> Parent agent dispatches, sub-agents do the work, the parent reviews.
> No preset roles, no scripted phases: **you decide who works and with which model**.

Chinese docs: [README.zh.md](README.zh.md)

## The problem

DSH's built-in Agent Team lets you give each teammate a name and a prompt — but **not a model**.
Real work is mixed: some of it needs an expensive model, some of it is a two-line edit.
Inheriting the parent's model for every pair of hands is both slow and expensive.

Foreman splits it in two:

- **Contractors** — the crew you define in the settings page, named by trade like a real
  construction site: 力工 (laborer — does the business work) and, optionally, 安全员 (safety officer
  — reviews and rejects). The foreman itself is the parent agent: it splits the work and signs off,
  and is never in the roster. Want specialties? **Hire several instances** (力工 · frontend,
  力工 · render), each with its own model and **its own prompt** (the 👁 button next to the name),
  and its own concurrency cap: default 1, so one instance never works two orders at once; set it to
  2 and it can. That prompt is prepended to every order the contractor receives. **The minimal setup
  is a single 力工.**
- **Orders** — the work the parent agent splits out. Each order carries a task and acceptance
  criteria, and may name a contractor or rotate automatically.

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

![Settings → 包工头: the contractor roster, with a per-contractor prompt behind the eye button](docs/settings-roster.png)

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
- Settings page collapses policy behind "派单策略"; the roster table keeps name / provider / model /
  effort / concurrency / enabled, and 👁 opens that contractor's prompt editor.

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
  matching takes precedence over role matching. Multiple instances with that role rotate among
  themselves, an omitted contractor rotates through the whole roster, and an unknown selector
  reports an error instead of silently reassigning the work.
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

Off by default. Tick **团队模式** under Settings → 包工头 → 派单策略 and each
contractor becomes a real member of the host's **agent team**: the plugin spawns
it with `agentTeams.spawnTeammate`, switches its session model with
`sessionController.selectModel`, sends the work order as a team message, then reads the
delivery back from the member's session events.

Members therefore show up in the team area and can change model in their own
session. Every step depends on host team services, so **any failure falls back to
the plain activation path** and the board's `teamMode` field says which one ran.

**Why delivery waits for `active`**: the host's `sendMessage` throws
`active teammate "worker" not found` until the member leaves `provisioning` and becomes
`active`. The plugin therefore polls `listMembers()` before delivering; if the member never
gets there (or reports `failed`), it falls back to the plain path instead of surfacing an error.
Known trade-offs:

- Member names must be ASCII (`lower-kebab-case`), so Chinese contractor names all
  become `worker`, `worker-2`, … — the Chinese name and model live in the member
  description, which the team area shows.
- A member's first turn runs on the parent's model (`spawnTeammate` accepts no model field —
  hence the one-line handshake).
- The member's **actual** model is echoed by `listMembers()`, written into the board's
  `teamMode` note; if the roster model differs it is shown side by side.
- Switching is bounded by the host's per-subagent model allow-list; values outside
  it are refused and the board shows `model switch: failed · reason`.
- Members stay in the team after the round.


## Changelog

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
