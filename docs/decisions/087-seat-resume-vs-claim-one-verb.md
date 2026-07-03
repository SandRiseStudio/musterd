# 087 — Seat resume ≠ claim: occupy-from-binding, a resume token, and one seating verb

- Status: proposed
- Date: 2026-07-03
- Supersedes/extends: ADR 033 (pending presence), ADR 034 (live-claim resolution), ADR 081 (seat-in-binding)
- Builds on: ADR 010 (reclaim grace), ADR 017 (newest-session-wins), ADR 077 (claim handshake + request lane)

## Context

A folder's agent identity resolves through two readers that ADR 018 requires to agree: the `musterd`
CLI reads `.musterd/binding.json`, and the MCP adapter (the `team_*` tools) reads the same file. ADR
081 closed the _env-baked_ drift (`MUSTERD_CLAIM` shadowing the file). A live dogfood on 2026-07-03
surfaced a **second, unclosed** drift on the same seam.

Observed: a folder with `binding.json` = `{ claim: {seat: "izzo"}, agent_key }` **but no grant**. The
CLI resolved `izzo` correctly (`whoami` → izzo). The MCP adapter, reconnected repeatedly, stayed a
_pending presence_ and never occupied the seat. Getting seated took seven+ steps — three `team_join`
calls (each minting a fresh approval request), a `claim --for <code>` that seated the _wrong_ waiting
session, an `unbind`, a reconnect, another `claim --for <code>`, and finally falling back to driving
the seat over the CLI because the MCP channel never converged. The roster showed `izzo` offline the
whole time despite a valid binding.

### Root cause — three mechanisms, all below the approval gate

1. **The adapter boots seatless even when the binding names the seat.** On the CLI a `seat`-mode
   binding with an `agent_key` _is_ a ready standing identity (`cli/helpers.ts:57`). The MCP adapter
   reads the same file but leaves `config.member` undefined (`mcp/config.ts:20-25`); it only fills the
   seat after a live claim handshake resolves `occupied`. ADR 081 fixed _env-baked_ drift, not
   _boots-seatless-despite-a-valid-seat-binding_.

2. **Presence identity is regenerated per process.** `connId` and the 4-char code are `ulid()` minted
   once per adapter start (`mcp/config.ts:96-97`). Every reconnect = a new code (TD0E → YP4X). The
   server keys approval requests on `connId` (`server/ws.ts:344`) and `claim --for <code>` references
   that ephemeral code, so **every reconnect orphans the in-flight approval and invalidates the code
   the admin was told to approve.**

3. **No standing grant → an approval round-trip every session.** A grant is what lets a session occupy
   without the request lane (ADR 077 step 7). The first approval issued a grant server-side, but to a
   dead/wrong session, and it never landed in _this_ folder's `binding.json`. So the approval treadmill
   never ended, and the `.resolved.json` sidecar bridge (ADR 034) pointed at a stale code (2) and never
   adopted.

Crucially, ADRs 010 + 017 **already** make an _occupation_ reconnect safe (45s reclaim grace; a
same-identity reconnect displaces the zombie and reclaims). Those operate on a session that has
**already occupied**. Our session never occupied — it sat _pending, below the approval gate_ — so grace
and newest-wins never applied. The bug is that (1)+(3) made every reconnect re-enter the _claim_ gate
instead of being treated as a _resume_.

## Decision

Name the two events, and make the machinery match.

> **A seat already assigned to my agent_key is mine to _resume_. A seat I don't yet hold is a _claim_.
> Claims are gated by one blocking approval; resumes are not — they ride the existing grace and
> newest-wins. The bridge that turns a reconnect into a resume is a short-lived, folder-local resume
> token.**

| Event      | Definition                                                                              | Gate                                             |
| ---------- | --------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Claim**  | a key taking a seat it does not yet hold (or whose resume token has expired)            | **one blocking approval** (ADR 077 request lane) |
| **Resume** | a key re-presenting for a seat it holds, or held within grace, with a live resume token | **none** — ADR 010 grace + ADR 017 newest-wins   |

### Fix A — Occupy-from-binding on connect (kills root cause 1)

When the adapter boots with a `seat`-mode binding (agent_key + seat name), it **attempts to occupy at
connect** rather than sitting pending. It sends a claim frame using the binding's `agent_key` and — if
present — its resume token/grant. Only if that occupation is refused (`claim_conflict` with no grace, or
`not_found`) does it fall back to the pending-presence state. `config.member` is populated from the
`occupied` frame as today; the change is that occupation is _attempted eagerly from the binding_, so the
CLI and adapter reach the same seat in the same folder without an operator step.

### Fix B — A resume token, persisted to binding.json (kills root cause 3)

The first approval mints a **resume token** — a grant scoped to `(agent_key, team, seat)` with a
**bounded TTL** (default 24h, team-configurable) — and writes it into `binding.json` alongside
`agent_key`. It is **refreshed on every clean occupancy**, so an actively-used seat never expires. On
reconnect the adapter presents the token → server takes the grant path (ADR 077 step 7) → occupies with
**no request**. After a long absence (past TTL) the token is stale, the adapter falls back to a claim,
and the admin is back in the loop — exactly when a re-approval is meaningful.

This is deliberately **not** a forever standing grant: the TTL keeps the human in control of genuinely
new/long-idle claims while making connection blips and reloads silent. A resume token is the same class
of secret as the `agent_key` already in `binding.json` (file mode `0600`), and it is revocable
(`requests`/grant revoke, ADR 076).

### Fix C — Stable presence identity per (workspace, agent_key, surface) (kills root cause 2)

For a **seat**-mode session, derive the pending code and the request-lane `from_session` key from a
stable hash of `(workspace path, agent_key, surface)` instead of a per-process `ulid()`. Reconnects
then reuse the same code, so:

- an in-flight approval is **not** orphaned by a reconnect;
- `--for <code>` and the `.resolved.json` sidecar (ADR 034) reference a stable target;
- the admin approves a code that still exists when the decision lands.

Role-pool and bare teammate joins keep per-connection identity (there is legitimately one presence per
connection there; the named-seat collapse in `requests.ts:57` already special-cases seats).

### Fix D — `team_join` / `claim` is one blocking, idempotent call (the DX centerpiece)

The MCP `team_join` today returns _immediately_ as "pending" and each call opens another request. It
becomes a single call that: occupies via resume token if present; else opens-**or-reuses** the one
request for `(workspace, seat)`, **waits** for the decision, occupies, persists the refreshed token,
and returns seated — mirroring the CLI `claim`'s `⧖` spinner. It never mints a second request for the
same folder+seat.

### Fix E — Consolidate the self-service surface into one verb

An agent's seating lifecycle today spans `claim`, `team_join`, `whoami`, `unbind`, `reclaim`, `init
--check`/doctor, `status`. Collapse the **self-service** operations into a single intent-clear verb; do
**not** add a new `here` verb.

**`musterd claim` (≡ MCP `team_join{}`) is the one command an agent runs:**

- already seated → prints who you are _(absorbs `whoami`)_;
- unseated → occupies from the binding, blocking through at most one approval;
- drifted/stuck → self-heals: re-adopts the binding and reclaims a zombie _(absorbs the common-case of
  `doctor --fix`, `unbind`, and `reclaim`)_.

Admins keep exactly **one** verb — `requests decide` — because that is a _different actor_ and cannot be
folded away. `status` stays (a roster view — a different job). `unbind`/`reclaim` survive as hidden
escape hatches, not front-line commands. Net mental model: **one command for agents, one for admins**,
down from ~seven.

## Consequences

- The ADR 018 guarantee (CLI and adapter resolve the same seat in a folder) holds under _reconnect_,
  not just at provisioning — the gap ADR 081 left open.
- Approval becomes a **claim-time** event, not a **reconnect-time** event. Dropped connections, reloads,
  and daemon bounces resume silently; genuinely new or long-idle claims still gate on an admin.
- The seven-step recovery we lived through collapses to: open the folder → the adapter occupies from the
  binding's resume token silently; a first-ever claim is one blocking call and one approval.
- New surface: a resume-token TTL (team config), token fields in `BindingSchema` and the grant store,
  and stable-code derivation for seat sessions. All additive; role/teammate paths unchanged.
- `musterd doctor`/`init --check` gains a fourth drift check: _adapter pending while the binding names a
  seat with a live resume token_ → the fix is a single `claim`. Follow-on to ADR 081's value-coherence
  check.
- Risk: a resume token is a longer-lived secret than a one-shot grant. Mitigated by the bounded TTL,
  `0600` file mode (same as `agent_key`), and existing grant revocation (ADR 076). A stolen `binding.json`
  already leaks the `agent_key`; the token widens nothing that the key didn't.

## Observability & Evaluation

**Traces** — the claim handshake already emits audit events (`claim.pending`, `claim.occupied`, ADR
077). Add a `musterd.seat.occupy` counter dimensioned by **path** (`resume_token` | `grant` | `approved`
| `pending`) so the resume-vs-claim split is first-party, plus `musterd.seat.approval_requests` (by
`kind`) to watch the treadmill flatten. A stable-code seat session should emit **one** request per
first-claim, not one per reconnect — that ratio is the headline signal.

**Eval** — the eval this ADR exists to move: **operator steps-to-seated** (target: 1 for a bound folder,
1 blocking call + 1 approval for a first claim) and **duplicate approval requests per seat per session**
(target: →0 under reconnect). Both are measurable from the audit log against the P0 baseline (the
2026-07-03 dogfood: 3 duplicate requests, 7+ steps, never converged on the MCP channel). Secondary:
% of reconnects that resume without an approval (target: →100% within TTL).

**Experiment** — the built-in A/B is before/after this ADR on the same dogfood recipe (fresh agent seats
into a shared folder across a daemon bounce). If steps-to-seated and duplicate-requests don't drop, the
resume token isn't the lever and the stable-code/occupy-from-binding pieces are isolated next. The
cutover is itself the experiment: the current seven-step transcript is the control.
