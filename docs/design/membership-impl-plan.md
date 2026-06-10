# Membership model — implementation plan (for SPEC v0.2)

> **Status: plan, not started.** Implements `membership-model.md` + `spec-v0.2-draft.md`. Build behind the existing living-doc/ADR discipline. Each milestone ends green (`pnpm -r build && pnpm test`) and updates the affected docs + promotes the relevant part of the draft spec into `SPEC.md`.

## Guiding constraints

- One breaking bump: `PROTOCOL_VERSION` → `musterd/0.2`, in one ADR.
- Keep the envelope + 7 acts unchanged. All change is in **identity/credentials/state**.
- Server stays the single source of truth; clients (CLI, MCP) only change how they authenticate + claim.
- Ship milestones so the tree is always green; the flagship Scenario C is updated to the claim model and must stay passing.

## Milestone 1 — protocol + schema foundation

- `@musterd/protocol`: bump version; add `Credential` notions, `JoinFrame`/`GrantedFrame`/`RefusedFrame` (replace `Hello`/`Welcome`), `AccountStatus` enum, `Activity`/`Availability` types, `claim_conflict` error code. Keep `Envelope`/acts intact.
- `@musterd/server` schema **v2 migration**: drop `members.token_hash`; add `members.account_status` (`provisioned|active|disabled|banned|archived`); add `teams.agent_key_hash`; add `members.credential_hash` (humans); add a `claims` notion (which presence holds which member) — likely a `claimed_by_presence` column on `members` + the existing `presence` row, with a `grace_until` timestamp.
- Tests: schema migrates; new frames parse; version pinned. ADR: **007 — v0.2 identity/credentials (breaking)**.

## Milestone 2 — server: credentials, claim, single-active, grace

- `store/credentials.ts`: mint/verify agent key (team-level) + human credential (per human member); `authAgentKey`, `authHuman`.
- `store/members.ts`: `account_status` transitions (admin-gated); `provisioned`→`active` on first claim.
- `store/claims.ts`: `claim(member, presence)` enforcing single-active + grace; `release(presence)` starting the grace window; reaper promotes expired grace → `claimable` and emits offline.
- `protocol/route.ts`: sending requires the sender to **hold the claim** on `from` (replaces token==member check).
- `transport/ws.ts`: `hello`→`join`; emit `granted`/`refused`; honor claim + grace on reconnect.
- `transport/http.ts`: `POST /claim`, governance routes (`/members/:name/status`, `/agent-key/rotate`), creator bootstrap returns `{human_credential, agent_key}`.
- Tests: claim grants; second claim → `claim_conflict` with `claimable` + hint; disconnect → reclaim within grace keeps seat, after grace frees it; banned credential rejected; disabled not claimable.

## Milestone 3 — state model + roster

- Resolve the three axes into the roster payload (`account`, `availability`, `activity`) + a `watching` list.
- Activity `working`/`talking`: `working` from latest `status_update.meta.state` of the claimed member; `talking` optional thread-derived display.
- CLI `render/rows.ts`: status table shows the resolved badge (`created · waiting to join`, `off until 9am`, `working: x`, `observing`, etc.) per the resolution table.
- Tests: display resolution precedence; provisioned/never-claimed shows correctly; snapshot updates.

## Milestone 4 — CLI to the new model

- `team create` → store + print the **agent key** + your **human credential**; set config.
- `team add` (admin) → create a `provisioned` member; print the **claim name** + the agent key reminder (no per-member token).
- `join` → `claim`: `musterd join <team> --as <member>` for humans (human credential); agents claim via MCP env. Add `musterd watch`/`inbox --watch` as **observer** when no member is claimed (human credential, role-gated).
- Governance commands: `musterd member disable|enable|ban|archive <name>` (admin), `musterd agent-key rotate`.
- Config shape: `{ server, current, agentKey, identities: { <team>: { member, humanCredential, role } } }`.
- Tests: Scenario A updated to credentials; governance happy-paths; observer read-only.

## Milestone 5 — MCP adapter to claim-at-join

- Env: `MUSTERD_TOKEN` → `MUSTERD_AGENT_KEY` + `MUSTERD_CLAIM` (the member to claim) + optional `MUSTERD_AUTOCLAIM=1`.
- `bind.ts`: connect with the agent key; **do not auto-claim** unless `MUSTERD_AUTOCLAIM`. Expose a `team_join` tool (claim `MUSTERD_CLAIM` or a named member) and `team_leave`. Default = dormant: tools available, no claim until `team_join` (the explicit-activation default).
- Refusal surfaces as a clear tool result (member taken → "ask an admin to add a teammate").
- Tests (Scenario B/C updated): two agents claim two distinct members; a 3rd session claiming a taken member is refused; explicit `team_join` activates; reconnect within grace keeps the claim.

## Milestone 6 — onboarding (`musterd init`)

- New step: **optional** "create teammates" loop (zero/one/many `provisioned` agent members).
- Configure harness with the **agent key** (+ optional default `MUSTERD_CLAIM` + opt-in `MUSTERD_AUTOCLAIM`, default off).
- "Waiting to join" only when a harness + default claim were set; it waits for a **claim** (account → `active`).
- Update `onboard/harnesses/*` to write the new env; update `printManual`.
- Tests: env-building for the new vars; cursor/claude entry shape.

## Milestone 7 — docs promotion + flagship

- Promote `spec-v0.2-draft.md` into `SPEC.md` (version `musterd/0.2`); update `01-data-model.md`, `02-protocol.md`, `03-server.md`, `04-cli.md`, `05-mcp.md`; fold `membership-model.md` decisions in; ADRs finalized.
- Update `examples/flagship-demo.mjs` + `tests/scenarios/flagship.test.ts` to the claim model (each agent claims a distinct named member; show a refused 3rd claim once).
- README quickstart reflects agent key + claim + explicit activation (with opt-in auto-claim).

## Risk / sequencing notes

- M1–M2 are the load-bearing breaking changes; everything else is adapting surfaces. Land them behind ADR 007 first, keep the suite green by updating server tests in the same milestone.
- The envelope/act stability means the *messaging* tests barely move; the churn is concentrated in join/auth/roster.
- Keep `single-active + grace` covered by explicit tests early — it's the subtle correctness core and the whole reason for the change.
