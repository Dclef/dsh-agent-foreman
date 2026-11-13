<p align="right">
  <strong>English</strong> · <a href="./README.zh.md">简体中文</a>
</p>

# Foreman · dsh-agent-foreman

> The parent splits the work; contractors do it; the parent signs off each order against a checklist.
> No preset roles, no scripted phases: **you decide who works, and with which model**.

**Version compatibility (0.5.0):** includes the **DSH 0.2.2-rc.2 compatibility fix**, retaining the existing **0.2.2-rc.1** / **0.2.1-rc.5** paths. The host is still an RC; no real-model end-to-end verification has been performed. Declared `engines.dsh`: `>=0.2.1-rc.2 <0.3.0-0 || >=0.2.2-0 <0.3.0-0`; Node.js `^22.19.0 || >=24.0.0`. Older UI/install notes apply only to the package they shipped with.

**Positioning change (important):** DSH now ships a **native multi-agent team** (durable named teammates, peer messages, shared task board, Web panel). Foreman **no longer claims to fill a "missing team" gap** — it is a thin orchestration layer on top of native capabilities: **model-based dispatch + per-order independent review + rework loop**. The two coexist and complement each other. Native teams handle "how a crew collaborates"; Foreman handles "which model runs each order, and who signs each one off". If you only need named teammates, use the native team directly.

**Install:** [GitHub / npm](#install-and-choose-versions) · [prompt for an AI assistant](#let-an-ai-install-it-for-you).

---

## One prompt. A crew with its own models.

DSH `0.2.2-rc.2` supports choosing a model when creating a native named subagent. Foreman saves provider, model, reasoning effort and prompt in a contractor roster, distributes orders by live load, reviews each delivery, and sends rework to the same member.

`dsh-agent-foreman` turns the current session into a **foreman**. You keep a roster of contractors in the settings page, each with its own provider / model / reasoning effort and its own prompt. Type `/foreman`, describe the work, and the foreman splits it into orders, dispatches them to isolated child sessions, and reviews each result — passing or sending it back with feedback. Four coordination tools and one shared board are all it needs; no separate workflow engine, no standing system prompt.

![Settings → 包工头: responsive contractor groups with readable models and Edit prompt controls](docs/settings-roster.png)

## Why Foreman (0.5.0)

| Capability | What it changes |
| --- | --- |
| **Per-contractor model** | Save provider, model and reasoning effort in the roster, pass them at creation (`agentOptions`), and verify the actual route at delivery. |
| **Model whitelist, one source** | Enabled contractors with an explicit route are synced into the host's subagent-model whitelist automatically. The roster is the only list you maintain. |
| **Load-aware dispatch** | Omit `contractor` and the engine picks the least-loaded contractor with spare capacity, cross-session, with a persisted rotation cursor breaking ties. |
| **Self-contained orders + checklist** | Each order carries task, acceptance criteria and a `checklist`; the child cannot see the parent's context. The board puts the checklist in front of the parent for per-item sign-off. |
| **Write-scope hints (new)** | Orders may declare `writeScopes` (workspace-relative prefixes, same shape as native task board). Overlaps between parallel orders raise a **soft board warning**; this is a hint only — **no file isolation, no write permission, no blocking**. |
| **Independent review (new)** | `foreman_review` passes/fails each order; **the maker never signs off its own work**, every pass/fail records `reviewedBy=foreman`. A fail requires concrete `feedback` or is rejected. |
| **Real route echo** | The board shows both the **declared** model (roster) and the **actual** model read back from the child session, and flags the row when they differ. |
| **Rework loop** | A fail re-dispatches to the same session with feedback, up to `maxRework`. |
| **Failure blocks downstream** | A failed / timed-out / cancelled order marks its dependents `skipped`; a skipped dependency blocks the rest of its chain. |
| **Settings + live board** | Responsive roster editor, policy panel, run history, and a live board (**Settings → 包工头 → 实时工地**) polling `/api/live`. |

The settings page and runtime skill follow the host's official locale service: English / Simplified Chinese switch live without a page reload.

## Verification scope (honest)

- Offline regression covers strict old/new host doubles, full-chain dispatch, model isolation, cancellation cleanup, pure functions and snapshot recovery. Actual host ASAR contracts and headless Chrome tests require their configured paths and explicitly skip otherwise. **No real model was called; native teamwork was not enabled.**
- 0.5.0 additions are covered by `test/optimization.test.mjs`: scope normalization, overlap detection, checklist injection, feedback-required fails, independent sign-off marker, board output.
- **Not done:** real multi-session concurrent dispatch, real browser responsive interaction, end-to-end with native team actually enabled, future DSH version compatibility. The `0.2.2-rc.2` path uses public named-subagent APIs; older hosts retain the guarded per-call internal adapter. Arbitrary future host versions are **not** guaranteed compatible.
- No promise of token savings, fixed speed-up, or that model selection always reaches the child session (the board echoes declared vs actual so you can check).

## Install and choose versions

**Version 0.5.0 includes the DSH `0.2.2-rc.2` compatibility path; the host is still an RC. Fully restart DSH after installing.**

| Use case | DeepSeek Harness | Foreman |
| --- | --- | --- |
| Current release compatibility | `0.2.2-rc.2` | `0.5.0` |
| Existing supported range | `0.2.1-rc.2` | `0.5.0` |
| Re-verified preview host | `0.2.2-rc.1` | `0.5.0` |
| Older verified bridge host | `0.2.1-rc.5` | `0.5.0` |
| Minimum installable host | `>=0.2.1-rc.2 <0.3.0-0` | `0.5.0` |

The declared `engines.dsh` range also covers the `0.2.2` prerelease line; CI verifies the specific hosts above, the installer accepts other hosts at or above the minimum.

### From GitHub

```bash
dsh plugin add Dclef/dsh-agent-foreman
```

Install it, then **fully restart DSH** — a browser refresh alone does not reload the host plugin.

### From npm (exact version)

In the active DSH profile directory:

```bash
npm install --save-exact dsh-agent-foreman@0.5.0
# or, if the profile uses pnpm:
pnpm add --save-exact dsh-agent-foreman@0.5.0
```

A first manual install also needs `"dsh-agent-foreman"` in `dsh.profile.bundles` of the profile's `package.json` (merge it, do not overwrite other plugins). GitHub Release also ships a matching `.tgz` plus `SHA256SUMS.txt`. See [docs/INSTALL.md](docs/INSTALL.md) for the offline tarball, `file:` dev install, and the pnpm hard-link re-link caveat.

## Making it take effect

- **After install/update, fully quit and restart DSH**: the host half `lib/index.js` and the settings plugin are assembled only at startup.
- Then **open a new session**: whitelist sync applies to new sessions only.
- Open **Settings → 包工头** to maintain the roster; the 「实时工地」 live board shows the current round.
- The panel renders in the browser and must be checked in a real session after restart. The screenshot above records one settings-page state; it does not prove cross-version compatibility or real team interaction.

## Let an AI install it for you

```text
Install the DeepSeek Harness plugin dsh-agent-foreman@0.5.0 for me:

1. Confirm my DSH version is >=0.2.1-rc.2 <0.3.0-0 and identify the target profile.
2. Prefer dsh plugin add Dclef/dsh-agent-foreman, or in that profile run
   npm install --save-exact dsh-agent-foreman@0.5.0 (pnpm: pnpm add).
   On a first manual install merge "dsh-agent-foreman" into dsh.profile.bundles,
   without overwriting other plugins.
3. Verify the installed version is 0.5.0; do not claim success unless you read the version.
4. Remind me to fully quit and restart DSH and open a new session; a browser refresh
   alone does not reload the host plugin.
5. Do not modify the host ASAR, switch global models, or invent CLI commands.
   On failure, report the raw error.
```

## Use it

Type `/foreman` (native command when available, otherwise `ctx.skills.register`) followed by the work:

```
/foreman extract GraphBlocked into shared logic; add regression tests
```

Semicolons or newlines split orders. The skill body walks the parent through roster → split (background / files / acceptance / `writeScopes` / `checklist`) → one dispatch → per-order review; it is injected once, not kept as a standing system prompt. You can also just ask in natural language.

| Tool | Purpose |
| --- | --- |
| `foreman_roster` | List contractors with route, prompt length, concurrency cap, busy/idle state and the current policy |
| `foreman_dispatch` | Dispatch a batch of orders, wait for all of them, return the shared board |
| `foreman_review` | Pass / fail each order; a failed one is re-dispatched with feedback |
| `foreman_status` | Re-read a board; omit `runId` for the latest one in this session |

Members also report through `foreman_report`, the self-report recovery tool.

### The roster

A contractor is a name, an optional role (a lightweight trade label for routing, not a fixed persona), an optional prompt, a provider, a model, an effort level and a concurrency cap. **Leave the provider on "follow the current session" and the child simply runs on whatever model the parent session is using.** The minimal setup is a single 力工 (laborer); add more instances for specialties, and optionally a 安全员 (safety officer) to review and reject. The foreman (parent agent) is never in the roster.

### Dispatch notes

- `orders[].task` **must be self-contained** — the child cannot see the parent's context.
- `orders[].writeScopes` (new) workspace-relative prefixes, hint only; parallel overlaps raise a soft board warning, never isolation or blocking.
- `orders[].checklist` (new) acceptance items; the parent checks each one, **the maker never signs off its own work**.
- `orders[].contractor` accepts a name / id / role; **omit it by default** for load-aware pick. Writing `contractor: "力工"` on every order bypasses load balancing and serializes work — do that only with a single enabled contractor.
- `orders[].dependsOn` references orders in the same batch only. Failure, timeout or cancellation blocks downstream work as `skipped`; `waitSeconds` caps the whole batch and unfinished orders are aborted rather than reported done.
- Global concurrency defaults to **4** (max **8**); each contractor has its own cap (default 1).

## How it works

1. `/foreman` activates the skill. The parent reads `foreman_roster` and splits the goal into self-contained orders with acceptance criteria, write scopes and a checklist.
2. One `foreman_dispatch` call sends the batch. The engine assigns contractors by live load, resolves dependencies, and starts each order in an isolated child session on that contractor's locked model route.
3. In optional team mode, a handshake verifies the **actual** request configuration; declared vs actual models are echoed on the board.
4. Children return a `foreman_report` with run/attempt tokens; the parent gets one shared board with checklist items and scope-overlap warnings.
5. `foreman_review` passes or fails each order; **the parent signs off independently against the checklist**, a fail re-dispatches with concrete feedback up to `maxRework`, reusing the same session.
6. Run snapshots are written atomically under `runs/`. After a restart they can be queried and reviewed, but interrupted work is **never** auto-resumed or silently re-dispatched.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `concurrency` | 4 | Contractors working at once (1–8); the per-instance cap lives in the roster |
| `timeoutSeconds` | 900 | Wall-clock cap per order |
| `maxRework` | 1 | How many times an order may be sent back |
| `maxDepth` | 1 | Whether a child may dispatch further children |
| `provider` | `spawn` | Which subagents provider to use |
| `teamMode` | on for new policies | Create real Agent Teams members; saved policies are preserved. The host session toggle must also be on |
| `teamFallback` | off | Explicitly fall back to ordinary child sessions when the team service is missing or the host session toggle is off; member dispatch failures remain strict |

**Whitelist sync**: every enabled contractor with an explicit provider+model is collected into the host whitelist at startup, after saving the roster, and on demand via `POST /api/whitelist/sync`. When no contractor declares an explicit route the host configuration is left untouched. It applies to **new sessions only**. A failed sync only logs, never blocks dispatch.

## Boundaries

- One foreman leads one dispatch round at a time; a batch is capped by `waitSeconds`.
- State is file-backed under `%LOCALAPPDATA%/dsh-agent-foreman/` (Windows) or `<baseDir>/data/dsh-agent-foreman/` elsewhere. `roster.json` stores contractors and policy; snapshots live in `runs/`, full delivery text in `artifacts/`. A corrupt roster is treated as empty and logged, never blocking startup.
- Every HTTP route accepts same-origin, loopback requests only; cross-site calls get 403. The roster stores provider/model/effort names — never credentials. Contractors run in their own child sessions and inherit DSH's effective sandbox.
- **writeScopes is a hint only**: Bash, formatters, code generators and direct external writes can bypass it; the Lead must review the final diff.
- Native team mode uses the host's named-subagent and task-board APIs. It is re-verified against the real DSH `0.2.2-rc.2` ASAR contract, never modifies the host ASAR or global model, and fails visibly on incompatible hosts. Arbitrary future host versions are not guaranteed compatible.

## Compared to

| | Native multi-agent team | Cabinet Mode | 文渊阁 dsh-ai-team | Foreman |
| --- | --- | --- | --- | --- |
| Positioning | Host built-in: durable teammates / messages / task board | persona preset + right-panel UI | standalone 3-pane workbench + append-only ledger | thin **model dispatch + per-order review** layer over teams |
| Per-member model | no (`spawn_teammate` has no model) | yes (official model picker) | yes (member model dropdown) | **yes** — `agentOptions` locked at creation |
| Independent review | no | 大理寺卿 / 左都御史 (persona) | **yes** — maker never accepts + QA hard gate | **yes** — parent signs off against checklist |
| Write-scope hints | yes `writeScopes` (hint only) | — | — | yes — same shape, soft warning (hint only) |
| Rework loop | no | — | request changes | yes — auto re-dispatch with feedback |
| Real route echo | no | — | — | **yes** — declared vs actual model |
| Tool count | 9 Team tools | standard-mode tools | own command set | 4 + self-report |

**Key difference**: native teams solve "how a crew collaborates"; Foreman adds only the two things they do not — **model-based dispatch** and **per-order independent review + rework**. Cabinet Mode leans on persona and visualization, 文渊阁 on a full persistent task system; both are heavier than Foreman. Pick by project size, do not stack them on the same work.

## Changelog

### 0.5.0 (2026-11-13)

- **Repositioned**: DSH now ships a native multi-agent team; README / skill / tool descriptions no longer claim to "fill a missing team gap", and instead state coexistence and complementarity.
- **Write-scope hints**: added `writeScopes` (same shape as the native task board), normalization, parallel-overlap detection, soft board warning; explicitly no file isolation, no write permission.
- **Independent review**: added `checklist`, `reviewedBy=foreman` sign-off marker, feedback-required fails; the board lays the checklist and overlap warnings in front of the parent. Inspired by 文渊阁's "maker never accepts", but kept as a hint layer, not a QA hard role.
- **Visible team toggle**: the settings page identifies the host-native team interface and the current-session switch requirement, so the DSH switch is not confused with Foreman's own team mode.
- **Explicit fallback**: added `teamFallback`; it falls back to ordinary child sessions only when the team service is missing or the host session toggle is off, while member dispatch failures remain strict.
- **DSH 0.2.2-rc.2 compatibility**: ordinary activation uses the flat request shape; named members and task ownership use the new public APIs; cancellation isolates only the selected member.
- **Honest docs**: version compatibility at the top, verification scope and non-promises, effect notes, an AI-install prompt, and a comparison against native teams / Cabinet Mode / 文渊阁. Style references: [dsh-cabinet-mode](https://github.com/luodaoyi/dsh-cabinet-mode) and [dsh-ai-team](https://github.com/suifei/dsh-ai-team).
- **201 tests: 198 passed, 0 failed, 3 skipped**: the offline suite covers the compatibility path, explicit team fallback, host capability probe, and existing ASAR/browser-gated contracts. No real model was called.

### 0.4.2 (2026-11-09)
- Removed the session-header 「工地」 button and its popup panel; READMEs restructured after dsh-agent-teams.

### 0.4.1 (2026-11-07)
- DSH 0.2.2-rc.1 compatibility audit; public provider discovery; stronger `engines.dsh`.

### 0.4.0 (2026-10-31)
- Real native mixed-model teammates, verified routing, per-member serialization, responsive settings.

### 0.3.0 (2026-10-29)
- Load-aware cross-session dispatch, persisted rotation cursor, busy/idle in `foreman_roster`, rework reuses the session.

### 0.2.0 (2026-10-28)
- Self-member system, cross-round memory, `foreman_report`, real route echo, whitelist sync, dependency-ready scheduling, snapshot recovery.

### 0.1.0
- Initial release: roster management, dispatch engine, board, settings page.

## Development

```bash
npm install --ignore-scripts
npm test
```

`test/harness.test.mjs` runs the real host half against a fake host, so no DSH instance is needed. Set `DSH_HOST_ASAR` for installed-host contract tests and `DSH_BROWSER_EXE` for Chrome responsive roster/save tests.

## License

[MIT](./LICENSE)
