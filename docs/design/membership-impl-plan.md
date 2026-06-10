# Membership model — implementation plan (SPEC v0.2: seats + grants)

> **Status: plan, not started.** Implements `membership-model.md` + `spec-v0.2-draft.md` + `security.md`. Built behind the living-doc/ADR discipline. Each milestone ends green (`pnpm -r build && pnpm test`), updates affected docs, and promotes the relevant part of the draft spec into `SPEC.md`.

## Guiding constraints

- One breaking bump: `PROTOCOL_VERSION` → `musterd/0.2`, in **ADR 007**.
- Envelope + 7 acts unchanged. All change is identity/credentials/grants/state/governance.
- Server stays the single source of truth; clients change how they authenticate, claim, and govern.
- **Security is a gate, not a milestone:** every milestone that touches credentials/grants also lands its audit records + least-privilege checks (`security.md`), not "later."
- Keep the suite green; update the flagship Scenario C to the claim/grant model and keep it passing.

## Milestone 1 — protocol + schema foundation
- `@musterd/protocol`: bump version; add `Role`, `Seat`, `Grant`, `Request`, `AccountStatus`, `Activity`/`Availability` types; new `ClaimFrame`/`OccupiedFrame`/`RefusedFrame`/`PendingFrame` (replace hello/welcome); `claim_conflict`/`expired_grant` codes. Envelope/acts intact.
- `@musterd/server` schema **v2**: `members`→`seats` (+`role`,`account_status`; drop `token_hash`); add `roles`, `grants`, `requests`, `audit`; team `policy` (+`agent_key_hash`), per-human `credential_hash`; seat `occupied_by_presence` + `grace_until`.
- Tests: migration; frame parsing; version pin. **ADR 007 — v0.2 seats/grants/governance (breaking).**

## Milestone 2 — credentials, grants, claim, single-active, grace (security core)
- `store/credentials.ts`: agent key (team) + human credential (per human seat); hash/verify; rotate.
- `store/grants.ts`: issue (scoped, expiring, single-use?), verify, revoke; **every op audited**.
- `store/seats.ts`: account-status transitions (admin-gated); `provisioned→active` on first occupy.
- `store/occupancy.ts`: single-active occupy/release with grace; reaper frees expired grace → emits offline.
- `store/audit.ts`: append-only audit records `{ts, actor, action, target, result}`.
- `protocol/route.ts`: sending requires holding the occupancy of `from`.
- `transport/ws.ts`: `hello`→`claim`; emit `occupied`/`refused`/`pending`; honor grant + grace.
- Tests: grant-gated occupy; missing grant → `pending`; expired/revoked grant refused; second claim → `claim_conflict`; reconnect within grace keeps the seat; banned/disabled refused; audit rows written. **Least-privilege tests: agent key cannot govern; grant scope enforced.**

## Milestone 3 — governance lane (own surface)
- `store/requests.ts`: create/decide claim & teammate requests; route to admins.
- `transport/http.ts`: roles, seats, seat status, grants (issue/revoke), agent-key rotate, team policy (`allow_pre_issued_grants`), requests list/decide, audit read. All admin-gated.
- Local-admin fast path: an admin-co-present session's no-grant claim can be approved inline.
- Tests: request lifecycle (pending→approved issues grant→occupy; deny; expire); policy toggles pre-issued grants; admin-only enforcement on every governance route; audit coverage.

## Milestone 3b — capabilities & need-to-know visibility
- Add the fixed capability set to roles (defaults) + per-seat **narrowing** (never widen); store `charter` on role/seat.
- Enforce capabilities on every in-band op (message/notify/observe/govern); **declare** external scopes (repo/dir/tool) without claiming to enforce them.
- **Viewer-scoped projection**: roster/info/audit endpoints filter by the caller's `visibility_level` (admins all; non-admins see teammate handles/presence/their own acts only).
- `claim`/`occupied` returns the seat's `charter`; `memory` field present but always `null` (reserved seam).
- Tests: per-seat narrowing can't widen; non-admin projection hides credentials/grants/audit/policy/other charters; capability enforcement (e.g. `can_message` scope) rejects out-of-scope sends.

## Milestone 4 — state model, roster, notifications
- Resolve three axes into the roster payload (`account`, `availability`, `activity`) + `watching` list.
- Activity: `working` from latest `status_update.meta.state`, **persist-while-alive + freshness timestamp** (stale after 5m → `working: x · Nm`, never idle), clear on release; `talking` optional.
- **Human availability**: implicit presence; explicit `away`/`dnd`/`away_until` via `POST /availability`; `inbox` holds + digests while away/dnd.
- **Notification tiers** (loud directed/governance · quiet ambient · held when away) + **breakthrough**: `away` passes only `urgent`; `dnd` passes directed + `urgent`.
- **`urgent`** = `meta.urgent` + required `meta.urgent_reason`, gated by `can_flag_urgent`, audited; recipient `wasnt_urgent` feedback recorded.
- CLI `render/rows.ts`: status table shows resolved badges (`created · waiting to join`, `off until 9am`, `working: x · 18m`, `observing`, account states); `inbox --watch` marks loud vs quiet and surfaces approval cards.
- Tests: display-resolution precedence; staleness rendering; away holds/urgent-breakthrough; `urgent` rejected without capability; provisioned/never-occupied; snapshots.

## Milestone 5 — CLI to seats + grants + governance
- `team create` → store + print **agent key** + your **human credential**; set config; creator = admin.
- `team add` (admin) → provision a `provisioned` seat (role, name?); no token printed.
- `join` → claim: humans claim their named seat (human credential); `musterd watch`/`inbox --watch` with no claim = **observer** (role-gated).
- Governance: `musterd role add` (+capabilities/charter), `musterd seat add|disable|enable|ban|archive`, `musterd seat caps <id>` (narrow), `musterd grant issue|revoke` (lifetime: once|ttl <h>|standing), `musterd agent-key rotate`, `musterd policy set allow-pre-issued-grants <bool>`, `musterd requests [approve|deny <id>]`, `musterd availability <available|away|dnd|until ...>`, `musterd audit`.
- Admin-co-present approval prompt (one-keystroke **approval card** w/ surface + seat + fingerprint + batching) for incoming requests during `inbox --watch`; approval picks grant lifetime (once / N-hours / until-revoke).
- Config: `{ server, current, agentKey, grants?: {...}, identities: { <team>: { seat, humanCredential, role, admin } } }`.
- Tests: Scenario A on credentials; governance happy-paths; observer read-only; refusal copy.

## Milestone 6 — MCP adapter to claim + request
- Env: `MUSTERD_TOKEN` → `MUSTERD_AGENT_KEY` + `MUSTERD_CLAIM` (seat or role) + optional pre-issued `MUSTERD_GRANT` + optional `MUSTERD_AUTOCLAIM`.
- `bind.ts`: connect with the agent key; **dormant by default** (tools available, no claim) unless `MUSTERD_AUTOCLAIM`. `team_join` tool claims (uses `MUSTERD_GRANT` if present, else triggers a `pending` request); `team_leave` releases.
- Refusal/pending surfaces as clear tool results; the **"ask an admin to add a teammate"** path emits a `teammate` request when there's no free seat — and, if an admin human is co-present, asks them directly.
- Tests (Scenario B/C updated): two agents occupy two distinct seats; a 3rd claim on a taken seat → `claim_conflict`; no-grant claim → `pending` then admin-approved occupy; reconnect-within-grace keeps the seat.

## Milestone 7 — onboarding (`musterd init`)
- Optional "create teammates" loop → provision `provisioned` agent seats (role + optional name; zero/one/many).
- Configure harness with the **agent key** (+ optional default `MUSTERD_CLAIM`).
- Admin opt-in prompts: *"Allow pre-issued grants for this team?"* (default No) → if yes, *"Pre-grant <seat> to this harness?"* (writes `MUSTERD_GRANT`).
- "Waiting to join" waits for **occupy** (post-approval under the default flow).
- Update `onboard/harnesses/*` env writing + `printManual`; tests for env shape.

## Milestone 8 — docs promotion + flagship + security
- Promote `spec-v0.2-draft.md` → `SPEC.md` (`musterd/0.2`); update `01`–`05` architecture docs; fold `membership-model.md`; finalize ADR 007 (+ any sub-ADRs for grants/audit).
- Land `security.md` as the normative security doc; ensure audit + least-privilege are covered by tests; add `.gitignore` for any secret-bearing config (`.cursor/mcp.json`, pre-issued grants) and an `init`-time secret warning.
- Update `examples/flagship-demo.mjs` + `tests/scenarios/flagship.test.ts`: agents occupy distinct seats; show a refused 3rd claim and a no-grant request→approve once.
- README quickstart + Principle 7 reflect agent key + grant + explicit activation.

## Risk / sequencing
- **M1–M3 are the load-bearing breaking + security work**; land them behind ADR 007 with tests in the same milestones. Everything after adapts surfaces.
- Envelope/act stability means messaging tests barely move; churn is in claim/auth/grants/governance/roster.
- Cover **single-active + grace** and **grant scope/expiry/revoke + audit** with explicit tests early — they are the correctness + security core and the whole reason for the change.
