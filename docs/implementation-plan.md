# musterd — Implementation Plan (living)

> **Living document.** This is the working plan of record: what the original plan called for, what has shipped, where we deviated on purpose, and what remains. It supersedes the original planning file (`.cursor/plans/agent_team_coordination_layer_22ae2015.plan.md`) as the thing to consult for "where are we and what's next." Deviations from *this* doc follow the same ADR protocol as everything else (`AGENTS.md`).
>
> Last reconciled: **2026-06-12** (v0.2 M3 core + tail landed via PR #1 — intent-led `init`, onboarding copy fixes §64/§65, and the adapter-shutdown fix that closes the phantom-presence bug; `pnpm -r build` + `pnpm test` green — 62/62 tests). **Only open M3 item: the `provenance`/`where`-on-attach seed.** Next milestone is **M4 — docs promotion + flagship update.**

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
2. ~~**M2 — `working` activity.**~~ ✅ **done.** Two-clocks rule in `store/activity.ts` (`resolveActivity`: liveness → offline/present; latest `status_update` → online/working) fed by `latestStatusUpdate` (prefers `meta.state`, falls back to body); HTTP roster `summarize` resolves it. CLI `render/rows.ts` renders `working: refactoring auth · 18m` (age shown only once stale ≥5m, never reverting to idle); the roster column is renamed **PRESENCE → ACTIVITY**. Tests: `resolveActivity` + `latestStatusUpdate` (store), roster-reflects-working (integration), staleness rendering with pinned `now` (CLI). 59 tests green. *Deferred to M4 docs pass:* the Figma `cmd/status` frame drifts from the CLI two ways (ADR 008 lockstep) — the PRESENCE→ACTIVITY rename **and** the column reorder to `MEMBER KIND ROLE LIFECYCLE ACTIVITY` (ACTIVITY last, free-flowing, so a long `working:` label can't collide — fixed in `ce89bf1`); `disabled`/`archived` badges were skipped (not trivial — needs schema + verbs).
3. **M3 — explicit activation in the MCP adapter.** 🟡 **core + tail done (PR #1); one item open — the `provenance`/`where`-on-attach seed.** **Done:** adapter dormant by default (`bind()` is reachability-only — no auto-presence, which also closed the ADR-010 HTTP-presence hole); `client.join()/leave()` (join resolves on `welcome`, rejects on `member_busy`); `team_join`/`team_leave` tools with collision-surfacing copy; **acting gated on join** — `team_send`/`team_inbox_check` refuse when dormant (closes the *accidental* acting-as-member exposure, finding §66); `MUSTERD_AUTOJOIN=1` opt-in (off by default); init offers auto-join + accurate copy (no more false "joins automatically"). **Dead-air mitigation:** stronger `team_join` result + `team_inbox_check` description copy, and a documented hook pattern (`docs/harness-hooks.md` — SessionStart/Stop). Tests: dormant→join→leave, `member_busy` on 2nd join (`mcp.test.ts`); Scenario C now uses explicit `join()`. 60 tests green. **Still open (M3 tail):** ~~the full intent-based `init` *menu* reframe (new agent / activate existing member / just me — finding §65)~~ ✅ **done** — `init` now opens with an intent select (*add a new agent* / *activate an existing member* / *just me, watch the team live*) after team selection; "harness" dropped from UI copy ("which tool will this agent run in?", "detecting agent tools"). The *activate-existing-member* branch is **stubbed to v0.3** (honest "coming in v0.3 — needs the seat-claim model" note + offer to add a new agent instead), because reattaching a member needs creator-authorized token reissue, which is the v0.3 security surface (no reissue endpoint today). The *just-me* branch routes to the supervising posture (`inbox --watch`/`status`, no mint). 60 tests still green. ~~the "already configured" + `-s local`-only copy fixes (finding §64)~~ ✅ **done** — the harness select hint now distinguishes set-up-vs-not and says "will be repointed"; selecting an already-configured app shows a **Heads up** note that re-running mints a *new* member (repeat names are refused by the conflict guard, so the warning is accurate) and repoints the app at it, leaving the prior member on the roster; and `ConfigureResult` gained a `scope` line — both Claude Code (`-s local`) and Cursor (`.cursor/mcp.json`) now print "wired into this folder only (<path>) — another project needs its own `musterd init`, and a second agent needs its own folder" after configuring. **Still open:** the `provenance`-on-attach seed, now including its `where` half — workspace context (folder floor, branch/subpath qualifier with most-specific-leads, sticky at join, declared override; decisions locked in `docs/design/human-agent-dynamics.md` §2) — none built yet; full close of the acting-as-member gap is the v0.3 seat model. *Needs a doc note in `05-mcp.md` (now 6 tools, dormant model) — folded into M4.*
   - **init's framing is too narrow (2026-06-12 dogfood).** It only ever *creates a new agent* and leads with jargon ("what harness is your agent in?"). Open with **intent** instead — *new agent* / *activate an existing (not-currently-live) member* / *just me, present to watch* (the supervising posture the dynamics note flags). Drop the word "harness" from UI copy → "which tool will this agent run in?". The "activate existing seat" branch is the v0.2-flavored down-payment on the v0.3 seat-claim model.
   - **M1 closed the *presence* collision but not the *acting-as-member* collision (2026-06-12 dogfood).** A 2nd session sharing a member token is refused on the WS hello (`member_busy`, no live presence/deliveries) yet its HTTP tools (`team_send`/`team_inbox_check`) still act as that member on the shared token + inbox cursor — the tail of the "N minds, one name" bug. Dormant-by-default removes the *accidental* exposure (sessions don't auto-claim); also decide whether v0.2 should *gate acting on holding the live claim* or at least warn. Full close is the v0.3 seat-claim model. Practical rule until then: **one live session per agent per project**, and distinct agents need distinct folders (claude `-s local` is one binding per folder).
   - **The adapter outlives its session → phantom "online/working" (2026-06-12 dogfood).** ✅ **fixed.** Live finding: a roster showed `Tim — working: … · 4h` (green) while the human's actual session was a *different* agent (`Ada`). Diagnosis: four orphaned `packages/mcp/dist/index.js` adapter processes from earlier in the day were still running and still holding WS presence — the background presence keepalive + auto-reconnect means closing the Claude editor session does **not** stop the stdio MCP child, and the open WS socket keeps Node's event loop alive, so the member stays attached and the reaper never reclaims it (liveness clock present, status clock frozen at last `status_update`). The `· 4h` staleness suffix rendered correctly; the bug was that presence didn't drop. **Fix:** `installShutdownHandlers` in `packages/mcp/src/index.ts` now drops presence (`client.close()`) and exits on every host-teardown path — stdin `end`/`close` (the canonical stdio-server signal), `SIGINT`/`SIGTERM`/`SIGHUP`, and `transport.onclose` (chained, not clobbered) — idempotent against signal races. Phantom presence now drops within the 45s reclaim grace instead of lingering for hours. Tests: stdin-close → `close()`+exit once + idempotent; onclose-chaining (`mcp.test.ts`, 62 green). The `docs/harness-hooks.md` Stop-hook remains a complementary belt for hosts that don't close cleanly.
   - **Team vs. folder mental-model gap (2026-06-12 dogfood; decision locked).** Running `init` in a fresh project (movetrail) offered "reuse dawn / new team," and the agent (Ada) joined **dawn** while its MCP binding lived in the movetrail folder — correct, but momentarily surprising. **Decision: a team is a *standing roster*, not a project** — it outlives any one repo; the *folder* only decides where a given member runs (folder→agent binding), the *team* is the durable, cross-project roster. So init's "reuse current team" default is right. Down-payment shipped: a one-line dim hint at the team-selection prompt ("A team is a standing roster, not a project — reuse the same team across folders to keep agents talking."). This is the same conceptual stack the `where`-on-attach provenance seed encodes (team = roster, folder = location).
4. **M4 — docs promotion + flagship update.** 🔜 **next milestone (fresh session).** Promote v0.2 deltas into `SPEC.md`; update `03/04/05` architecture docs, `examples/flagship-demo.mjs`, Scenario C (show one refused duplicate + `working` in the watch pane); README quickstart reflects explicit activation; `.gitignore`/warn on secret-bearing harness configs. **Doc debt accrued by M3 (PR #1) to fold in here:**
   - `05-mcp.md`: now **6 tools** (added `team_join`/`team_leave`) and the **dormant-by-default** model (`bind()` is reachability-only; acting gated on join; `MUSTERD_AUTOJOIN`); document the **shutdown contract** — the adapter drops presence and exits on stdin close / SIGINT/SIGTERM/SIGHUP / `transport.onclose` (`installShutdownHandlers`), so presence is self-cleaning and the `harness-hooks.md` Stop-hook is now a complementary belt, not the primary mechanism.
   - `04-cli.md`: the `init` flow description (currently step 3 "detect harnesses → pick a harness") is stale — rewrite for the **intent-led** flow (add agent / activate existing-member [v0.3 stub] / just-watch), the "where the agent runs" copy (no "harness"/"tool"), the per-folder `scope` line, and the already-configured "Heads up" note.
   - Capture the **team = standing roster, not a project** decision wherever teams are defined (it's a real conceptual commitment now surfaced in `init` copy and `human-agent-dynamics.md` §2).

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
Telemetry & observability (minimal OTel instrumentation of `@musterd/server`; `meta.otel` trace-context convention, ADR 011; the **batond** coordination-observability product — strategy in `docs/design/observability.md`, branding in `docs/design/brand-coordination-observability.md`), schedule/lifecycle enforcement, step-level streaming transport, federation, more surfaces (web dashboard — already designed in Figma — iOS, Slack), sandboxed runtime, Python SDK.

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
| 011 | W3C trace context rides in `Envelope.meta.otel` (proposed) | observability |
