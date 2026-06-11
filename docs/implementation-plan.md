# musterd — Implementation Plan (living)

> **Living document.** This is the working plan of record: what the original plan called for, what has shipped, where we deviated on purpose, and what remains. It supersedes the original planning file (`.cursor/plans/agent_team_coordination_layer_22ae2015.plan.md`) as the thing to consult for "where are we and what's next." Deviations from *this* doc follow the same ADR protocol as everything else (`AGENTS.md`).
>
> Last reconciled: **2026-06-11** (v0.2 M1 landed — ADR 010 single-active + grace; `pnpm -r build` + `pnpm test` green — 55/55 tests).

---

## 1. The original plan (recap)

Build an open-source coordination layer — **named, persistent teams of agents and humans, across any harness, with a shared protocol** — as a pnpm/TypeScript monorepo (`protocol` / `server` / `cli` / `mcp`), designed in the open with prescriptive docs that a less-capable agent could execute. Milestones:

0. Planning docs — `docs/design/` (brand + 3 Figma briefs), `docs/architecture/` (00–07), `AGENTS.md`
1. Scaffold + SPEC v0.1 + **reserve `musterd` on npm early**
2. Server core (SQLite, WS+HTTP, presence, inbox)
3. CLI (two humans on one team works)
4. MCP adapter (Claude Code joins, then Codex)
5. Flagship 3-pane demo, recorded (~90s)
6. Launch polish (README + positioning + ROADMAP)

## 2. What has been implemented

Everything below is on `init-musterd`, builds clean, and is covered by the test suite (`pnpm test`: 10 files, 50 tests, all green).

| Plan item | Status | Evidence |
|---|---|---|
| **M0 planning docs** | ✅ done | `docs/architecture/00–07`, `docs/design/brand.md` + 3 Figma briefs, `AGENTS.md`, `SPEC.md` (commit `8971acc`) |
| **M0 Figma execution** (the briefs *executed*, originally for a separate agent) | ✅ done (late — see §3) | ADR 008; 3 Figma files; exported assets in `docs/design/assets/` |
| **M1 scaffold + SPEC v0.1** | ✅ done | `598080d`, `381abd8`; `SPEC.md` is `musterd/0.1` |
| **M1 reserve npm name** | ✅ done (as `@musterd/cli`, ADR 009) | Unscoped `musterd` is permanently rejected by npm (too similar to `multer`), so pivoted to the `@musterd` scope. The `musterd` org is created and **`@musterd/cli@0.0.0`** is published (placeholder in [`npm-reserve/musterd-cli/`](../npm-reserve/musterd-cli/)); the org reserves the whole `@musterd/*` scope |
| **M2 server** | ✅ done | `@musterd/server` (`5f75030`): SQLite (schema v1 incl. ADR 001/003/006), one `routeEnvelope` path shared by WS+HTTP, presence + reaper (15s/45s), cursor-based at-least-once inbox, sha256 token auth |
| **M3 CLI** | ✅ done | `musterd` (`14b6b1f`): `serve/team create/team add/join/send/inbox[--watch]/status`, brand ANSI theme, exit-code table, `--json`/`NO_COLOR`; Scenario A passes (`cli.e2e.test.ts`) |
| **M4 MCP adapter** | ✅ done | `@musterd/mcp` (`d596a06`): 4 tools, env binding, background WS presence + buffer + reconnect; Scenario-B-equivalent tests pass (`mcp.test.ts`) |
| **M5 flagship demo (automated + script)** | ✅ done | `tests/scenarios/flagship.test.ts` (Scenario C, green) + runnable `examples/flagship-demo.mjs` + `docs/demo.md` |
| **M5 flagship demo (recording)** | ❌ **not done** | `docs/assets/flagship.gif` is referenced by `README.md` but does not exist — the README has a broken image today |
| **M6 launch polish** | 🟡 mostly | `README.md` (principles, positioning table, quickstart), `ROADMAP.md`, MIT `LICENSE` exist. Remaining: the GIF, npm publish, the actual launch post |
| **Beyond plan: `musterd init`** | ✅ done (unplanned) | Interactive onboarding (`01ddfb9`, `abf318b`): daemon check, team create, harness detect/configure (Claude Code CLI + extension, Cursor), live wait-for-join. ADR 005/006 |

## 3. Deviations — intentional evolution from the original plan

Each is recorded in an ADR; this is the consolidated narrative.

**Implementation simplifications (ADRs 001–004, 006)** — all small, all in the spirit of the docs' own escape hatches: members table folds memberships (001); no web framework, hand-rolled arg parser, CLI imports server *only* in `serve.ts` (002); DDL as a TS constant instead of a `.sql` asset (003); ESLint deferred, strict `tsc` is the v0.1 static gate (004); `cursor` added to the Surface enum (006).

**The onboarding detour (ADR 005)** — `musterd init` was not in the original plan. Demo enthusiasm produced a polished first-run flow (`@clack/prompts`, harness detection, MCP auto-config). Net positive: it *is* the quickstart now, but it's also what surfaced the auto-join identity bug below.

**The governance brainstorm and the scope cut (ADR 007 — the big one).** Using the demo revealed a real bug: the MCP adapter auto-joins every session as a fixed member, so 3 Claude Code sessions = 3 minds wearing one name. Fixing it ballooned into a full shared-teams governance design (seats/roles, agent key + grants, approval lane, capabilities, visibility projection, audit, notification tiers). ADR 007 cut that back: **v0.2 ships only the minimal trust model** (explicit activation, single-active + 45s grace, `working` status, keep per-member tokens); the governance system is **fully designed on paper as the v0.3 set** (`membership-model.md`, `spec-v0.3-draft.md`, `security.md`) and activates when the daemon stops being localhost-only. Side effects of the brainstorm that are already live: **Principle 7 — secure by default** was added to the README (7 principles now, vs the plan's 6).

**UI/UX executed against reality (ADR 008).** The Figma execution (skipped in the rush to build) was completed for all three briefs — but with the direction flipped where code already existed: the CLI is the source of truth for terminal output and the ASCII banner, and the frames mirror it (MCP env block on `team add`, `cli` default surface). The Dashboard file is *designed, not built* (v0.3), and its data-model pressure-test passed with zero schema gaps. Launch assets (README header, social card, avatar, badge) are exported into `docs/design/assets/`.

**Smaller drifts worth knowing (no ADR needed, recorded here):**
- Scenario A lives in `packages/cli/src/cli.e2e.test.ts` and Scenario B's behavior in `packages/mcp/src/mcp.test.ts`, not in `tests/scenarios/` as `06-testing.md` sketched — only Scenario C is there. Functionally covered; file placement differs.
- The coverage gates in `06-testing.md` (≥95/85/75%) are **not wired** into the vitest configs — tests pass but coverage is unmeasured.
- "Codex joins" (plan M4) was validated via the harness-agnostic env path (Scenario C binds Lin with `surface: codex`); there is no Codex-specific onboarding adapter in `musterd init` (only Claude Code + Cursor).
- ADR numbering: `membership-impl-plan.md` M1 says to write "ADR 008 — single-active + grace"; 008 turned out to be the Figma execution and 009 the npm scope decision, so single-active + grace landed as **ADR 010** (v0.2 M1, done).

## 4. What is left

In priority order. The governing sequence (per ADR 007) is: **v0.2 minimal trust model → record the demo → publish/launch**, because the demo should show explicit join + `working` status, not the auto-join behavior v0.2 deletes.

### A. v0.2 — minimal trust model (in progress; plan: `docs/design/membership-impl-plan.md`)
1. ~~**M1 — protocol `musterd/0.2` + single-active server core.**~~ ✅ **done** (ADR 010). `PROTOCOL_VERSION` → `musterd/0.2`; `member_busy` error (CLI exit 10); roster `activity`/`state`/`last_status_at` fields (populated `offline|online` in M1, `working` lands in M2); presence schema v2 (`held_until`); server refuses a second active presence and keeps a 45s reclaim hold the reaper sweeps. Tests: single-active refuse + reclaim (`integration.test.ts`), release/grace/reaper (`store.test.ts`). `pnpm -r build` + `pnpm test` green (55 tests).
2. ~~**M2 — `working` activity.**~~ ✅ **done.** Two-clocks rule in `store/activity.ts` (`resolveActivity`: liveness → offline/present; latest `status_update` → online/working) fed by `latestStatusUpdate` (prefers `meta.state`, falls back to body); HTTP roster `summarize` resolves it. CLI `render/rows.ts` renders `working: refactoring auth · 18m` (age shown only once stale ≥5m, never reverting to idle); the roster column is renamed **PRESENCE → ACTIVITY**. Tests: `resolveActivity` + `latestStatusUpdate` (store), roster-reflects-working (integration), staleness rendering with pinned `now` (CLI). 59 tests green. *Deferred to M4 docs pass:* the Figma `cmd/status` frame still says PRESENCE (ADR 008 lockstep) and `disabled`/`archived` badges were skipped (not trivial — needs schema + verbs).
3. **M3 — explicit activation in the MCP adapter.** Dormant by default; `team_join`/`team_leave` tools; `MUSTERD_AUTOJOIN=1` opt-in; `init` waits for explicit join. **Includes the dead-air mitigation** (ADR 007 break 4): join-result/tool-description copy that drives `team_inbox_check` at task boundaries + a documented harness-hook pattern. This is the riskiest part — it's prompt/UX engineering, not protocol work. *Also fold in the 2026-06-11 dogfood findings:* init's join-wait gives up before the (inherently async) join lands; contradictory "already configured" + "write it for you?" copy; `claude mcp add` is `-s local` only (add an opt-in user-scope write for cross-project agents). *And decide the `provenance`-on-attach seed* (`docs/design/human-agent-dynamics.md` §2) while the adapter is open.
4. **M4 — docs promotion + flagship update.** Promote v0.2 deltas into `SPEC.md`; update `03/04/05` architecture docs, `examples/flagship-demo.mjs`, Scenario C (show one refused duplicate + `working` in the watch pane); README quickstart reflects explicit activation; `.gitignore`/warn on secret-bearing harness configs.

### B. Launch tail (after v0.2)
- ~~**Reserve the npm name**~~ ✅ **done** — `@musterd/cli@0.0.0` published under the `musterd` org (2026-06-11); the org reserves the whole `@musterd/*` scope. Unscoped `musterd` was blocked by `multer` (ADR 009). The *real* CLI still can't publish until its `@musterd/*` workspace deps are published (a v0.2/launch task); when it does, it supersedes the `0.0.0` placeholder.
- **Record the flagship demo** (`docs/demo.md` form 2 or 3) → `docs/assets/flagship.gif`; fixes the README's currently-broken image.
- **Publish** the four packages; **launch post** (positioning vs MCP/A2A/Fleet/CrewAI is already written in the README).

### C. Hygiene (non-blocking, schedule opportunistically)
- Wire vitest coverage and either enforce or amend the `06-testing.md` gates.
- ESLint/Prettier setup (ADR 004 said deferred, not dropped).
- Move/alias Scenario A/B into `tests/scenarios/` or amend `06-testing.md` to match reality (one-line doc fix).

### D. v0.3 — shared-teams governance (designed, deliberately not built)
The full set in `membership-model.md` + `spec-v0.3-draft.md` + `security.md`: seats/roles, agent key + grants (once/TTL/standing) + approval lane, capabilities + need-to-know visibility projection, audit log, notification tiers + scarce `urgent`, human observers. **Trigger condition: the daemon stops being localhost-only.** Do not build ahead of that; the designs pre-answer the known landmines (grant expiry never evicts a live claim; fingerprints are recognition, not security; `urgent` strike-tracking needs ≥2 humans).

### E. Roadmap (post-launch, `ROADMAP.md`)
Schedule/lifecycle enforcement, step-level streaming transport, federation, more surfaces (web dashboard — already designed in Figma — iOS, Slack), sandboxed runtime, Python SDK.

## 5. Decision log index

| ADR | What | Bucket |
|---|---|---|
| 001 | members folds memberships | simplification |
| 002 | runtime deps; CLI→server import only in `serve.ts` | simplification |
| 003 | DDL as TS constant | simplification |
| 004 | ESLint deferred; strict tsc is the gate | simplification |
| 005 | `@clack/prompts` onboarding; CLI depends on `@musterd/mcp` | unplanned feature |
| 006 | `cursor` surface | unplanned feature |
| 007 | **v0.2 scope cut; governance → v0.3** | course correction |
| 008 | Figma execution + brief/CLI reconciliation | catch-up + course correction |
| 009 | CLI ships as `@musterd/cli` (unscoped `musterd` blocked by `multer`) | course correction |
| 010 | single-active members + 45s reclaim grace | v0.2 M1 |
