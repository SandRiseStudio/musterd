# v0.2 implementation plan — minimal trust model

> **Status: plan, not started.** Scoped per **ADR 007** (the scope cut). v0.2 fixes only the real localhost bug — implicit auto-join and "N sessions = N minds wearing one name" — plus ships the launch-visible `working` status. It **keeps v0.1 per-member tokens**; no agent key, grants, requests, audit, capabilities, or notification tiers (those are the v0.3 set: `membership-model.md`, `spec-v0.3-draft.md`, `security.md`). Each milestone ends green (`pnpm -r build && pnpm test`) and updates affected docs.

## Scope (what v0.2 is)

- **Explicit activation** — adapter dormant by default; `team_join` tool; opt-in `MUSTERD_AUTOJOIN`. *(fixes consent)*
- **Single-active + refuse + 45s grace** — server-enforced per member. *(fixes the clone bug)*
- **`working: x`** — persist-while-alive + freshness staleness (two-clocks). *(roster feels alive; demo value)*
- **Maybe** (only if trivial): `disabled`/`archived` account states (one column + two CLI verbs).
- Protocol bump to **`musterd/0.2`** — small: single-active behavior + activity fields. Envelope + 7 acts unchanged.

Out of scope (v0.3, designed on paper): seats/roles, agent key + grants, approval/request lane, capabilities + visibility projection, audit log, notification tiers + `urgent`, human observers, admin governance commands.

## Milestone 1 — protocol + single-active server core
- `@musterd/protocol`: bump `PROTOCOL_VERSION` → `musterd/0.2`; add `activity` fields to the member/roster types (`offline|online|working` + `state` + `last_status_at`); keep `Hello`/`Welcome` and per-member tokens. ADR 007 already records the scope; add a short **ADR 008 — single-active + grace** for the behavior change.
- `@musterd/server`: enforce **single-active** in `ws.ts` hello — a second live presence for an already-occupied member is **refused** (new `member_busy` error) unless it's a reclaim within the **45s grace** of the prior holder's disconnect. Track `held_until` on release; reaper frees expired holds.
- Tests: 2nd hello for a live member → refused; disconnect then re-hello within grace → re-occupies; after grace → frees; existing 18 server tests stay green (adjust any that opened two presences for one member).

## Milestone 2 — `working` activity + roster/CLI
- Server: record `working` from the latest `status_update.meta.state`; roster resolves activity with the two-clocks rule (heartbeat = alive; last `status_update` = fresh; stale after 5m → `working: x · Nm`, never idle; clears on release/grace).
- CLI `render/rows.ts`: status table shows `working: refactoring auth · 18m` / `online` / `offline`; (optional) `disabled`/`archived` badges.
- Tests: activity resolution + staleness rendering; snapshot updates; persists across a long quiet period while heartbeating.

## Milestone 3 — explicit activation in the MCP adapter (+ the dead-air mitigation)
- `@musterd/mcp`: **dormant by default** — `bind()` connects/authenticates but does **not** claim presence; tools are registered. A `team_join` tool registers presence (the explicit activation); `team_leave` releases. `MUSTERD_AUTOJOIN=1` restores one-keystroke auto-join for those who want it.
- **Dead-air mitigation (ADR 007, break 4):** the `team_join` result and tool descriptions strongly instruct the agent to call `team_inbox_check` at task boundaries; document a harness-hook pattern (e.g. Claude Code hook injecting an inbox-check reminder) in `docs/`. This is the real UX cliff — design the copy/hooks deliberately, test that a joined agent that checks its inbox sees teammate messages.
- `musterd init`: keep auto-config of the harness; the "waiting to join" step waits for an explicit `team_join` (or auto-join if the user opted in). Update activation copy.
- Tests (Scenario B/C updated): two agents each `team_join` as distinct members; a 3rd session as a taken member → `member_busy`; reconnect within grace keeps presence; dormant agent exposes tools without being present until `team_join`.

## Milestone 4 — docs promotion + flagship + publish-ready
- Promote the v0.2 deltas into `SPEC.md` (`musterd/0.2`): single-active + grace, activity/`working`, explicit-activation note. Update `03-server.md`, `04-cli.md`, `05-mcp.md`.
- Update `examples/flagship-demo.mjs` + `tests/scenarios/flagship.test.ts` to the explicit-join model (agents `team_join`; show a refused duplicate once; show `working` status in the watch pane).
- README quickstart reflects explicit activation + opt-in auto-join; `.gitignore` secret-bearing harness configs; `init` warns when writing a secret to a repo file.

## Deferred to v0.3 (designed, ready when shared teams arrive)

The full governance system lives in `membership-model.md` + `spec-v0.3-draft.md` + `security.md`: seats/roles, agent key + admin-issued grants (once/ttl/standing) + approval lane, capabilities + per-seat narrowing + need-to-know visibility, audit log, notification tiers + `urgent`, human observers. It activates when the daemon stops being localhost-only. Pre-answered landmines (see ADR 007): grant expiry gates new claims but never evicts live ones; fingerprints are recognition not security; `urgent` strike-tracking needs ≥2 humans.

## Risk / sequencing
- **M1 (single-active + grace) is the load-bearing correctness fix** — cover it with explicit tests first; it's the whole reason for v0.2.
- **M3's dead-air problem is the real risk**, and it's a UX/prompt-engineering problem at the MCP boundary, not a protocol one. Budget time to get the agent-facing copy + harness-hook pattern right; it's what makes a joined agent an actual teammate vs a silent one.
- Envelope/acts unchanged → messaging tests barely move; churn is in presence/activation/roster.
