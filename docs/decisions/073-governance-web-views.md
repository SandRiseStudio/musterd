# 073 — v0.3 governance web views (roster rail + audit-log view)

- Status: accepted — 2026-06-29 (web surface for ADR 069, on the 070/071 substrate)
- Date: 2026-06-29

## Context

ADR 070 (P1) made every seat carry a resolved `account_status` + effective `Capabilities`, and the daemon
already projects both onto the public `Member`/`MemberSummary` (`GET /teams/:slug`). ADR 071 (P2) turned the
substrate on and added the **append-only audit log** behind an admin-only `GET /teams/:slug/audit`. Both are
now observable facts the daemon serves — but nothing on the **web** surfaced them. The live dashboard (ADR 061) showed only presence + the message firehose: a constellation (decorative, `aria-hidden`) and the team
stream. Governance was invisible to a human watching a team.

Per ADR 069's lane split, the observable web surfaces are disjoint from P2's server enforcement and were
handed to this lane explicitly, so they could land in parallel without touching `packages/server` /
`packages/protocol`.

## Problem

Surface the v0.3 governance state on the web **without** re-implementing any policy (enforcement is
server-side; the web is a read-only projection) and without crowding the calm-at-rest live dashboard. Two
distinct needs:

1. **Per-seat governance at a glance** — who is an admin, who is muted/urgent-gated/admin-viewer, and each
   seat's `account_status` — on the roster, where you already look to see who's on the team.
2. **The governance audit trail** — the admin-only, append-only decision log, paginated and legible, with
   its admin-only access surfaced as a first-class (not error-y) state.

A fully-generalist team (today's default) must read **calm**: if surfacing capabilities painted a badge on
every seat, the surface would be noise on day one and only meaningful once governance is configured.

## Decision

### 1. Roster rail — `RosterPanel` on the live dashboard

A semantic, accessible roster panel docked in `.lc__canvas` (constellation shrinks 42%→38%), the read-only
counterpart to the decorative constellation. Per seat: presence dot, kind (always shown) + role (an
_additional_ tag when set), the `account_status` pill, and capability badges. Two projection rules keep it
honest and calm, both pure functions in `live/format.ts`:

- **`account_status`** renders always, but `active` (the healthy norm) is **quiet** (faint, bordered, no
  fill); only exceptions (`provisioned`/`disabled`/`banned`/`archived`) take a tone. A pre-v0.3 daemon that
  projects no status reads `unknown` rather than a fabricated `active`.
- **Capability badges show only _deviations from the generalist default_** (`admin`, `admin view`, `muted`,
  `no urgent`, `no observe`) plus the positive `admin` marker. A generalist seat shows no badge, so the rail
  is calm today and lights up exactly as governance is configured. Universe-2 (tool/resource scopes) is
  declared-only and intentionally not badged.

### 2. Audit-log view — the `/audit` route

A dedicated admin route (not folded into the observer dashboard, which authenticates as a non-admin observer
seat that the endpoint correctly refuses). The operator supplies an admin seat + token; `fetchAudit` calls
`GET /teams/:slug/audit` and `AuditLog` renders a newest-first table (ts / actor / action / target / result
/ detail) with allow/deny left accents, action-tone badges, and `before`-cursor "load older" paging.

- **`action` is treated as an open string** (`auditActionMeta` maps the known v0.3 verbs; unknown verbs
  render verbatim), so P3's `grant.*`/`claim.*`/`account_status.change` rows appear the day the server emits
  them — no web change required.
- **Admin-only is a first-class state, not an error.** A 403 reads "that seat is not an admin — admin-only",
  a 401 "enter the token for an admin seat", a 404 "this daemon predates the v0.3 P2 build" — via a typed
  `AuditFetchError` carrying the daemon's code/status.

The view stays strictly presentational over the server's projection — no caps math, no policy — so the web
can never disagree with enforcement.

## Observability & Evaluation

**Traces** — the audit-log view is the human read-end of the ADR 071 trace: the same `{ ts, actor, action,
target, result, detail }` records the batond flywheel (ADR 051) consumes are rendered for a person, with the
allow/deny outcome and the `detail` context (`{ fallback: "no-admin" }`, `{ can_message: "none" }`) legible
inline. The roster rail is the read-end of the P1 capability projection. The web adds no new spans; it only
projects what the daemon already records.

**Eval** — success = **the web faithfully mirrors the daemon's projection, and reads calm by default**. Bar:
a fully-generalist team shows zero capability badges and only quiet `active` pills (no day-one noise); a
non-generalist seat shows exactly its deviations (verified via fixtures: an `admin`/`admin view` seat and a
`provisioned` + `muted` + `no urgent` seat); the audit table renders every contract field incl. unknown
actions and null actor/target, and the admin-only gate surfaces as tailored copy on 401/403/404. **Baseline**:
the screenshot set (roster rail with synthetic non-generalist seats; audit table with allow/deny + known +
unknown fixtures; the live `403 admin-only` against the deployed P2 endpoint) is the "before" the next web
change is diffed against. Verification is headless-Chrome `--screenshot` on the deep-links, matching the live
UI's established practice (no test runner in `packages/web`).

**Experiment** — for batond (ADR 069): does surfacing `account_status` + capability badges on the roster
change operator behavior on seeded governance tasks (e.g. faster recognition that a seat is muted/disabled vs
reading it from the audit log), and does the audit view's admin-only friction (a separate token) suggest a
need for an embedded admin mode in the dashboard? The audit log itself is the measurement substrate.

## Consequences

- Governance becomes visible on the web the moment it is configured, with zero policy duplicated — the web is
  a pure projection, so it cannot drift from server enforcement.
- The deviations-only badge rule means the surface scales from "calm, all-generalist" to "richly annotated"
  with no redesign — the same code that shows nothing today shows everything under P3 roles/grants.
- The `/audit` route needs an admin token; until P3's claim/grant handshake there is no in-dashboard way to
  obtain one, so the view is operator-driven. An embedded admin mode is deferred to P3's web follow-up.
- `AuditEntry` is currently a web-local type (`live/client.ts`); when the audit CLI reader (ADR 074) adds a
  shared `AuditEntry` to `@musterd/protocol`, this view should import it so there is one source of truth.
