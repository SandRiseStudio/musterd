# 063 — Read-only observer seat (watch without joining)

- Status: accepted
- Date: 2026-06-26

## Context

The live dashboard (ADR 061/062) connects to the firehose as a normal member seat. That works, but it
makes the *watcher* a *teammate*: connect the dashboard as `lens` and `lens` shows up on everyone's
roster as an online human, counts toward the live-session count, and emits online/offline presence
events as you open and close the tab. A monitoring view — a wall display, an audit tool, a glance from
your phone — should be able to watch all of a team's communication **without appearing to participate**.

## Decision

Add an **observer**: a seat flagged `observer` that authenticates and rides the *exact* same firehose
path (hello → `subscribe team-all`, `GET /messages`) as today — the verified dashboard client is
unchanged — but is invisible as a participant and cannot speak.

An observer member is hidden and inert:

- **Hidden from the roster** (`listPresence`) and the **live-session count** (`countLivePresences`),
  so `status` and the roster header never show it.
- **No presence events** — connecting/disconnecting an observer emits no online/offline frame, and an
  observer's ambient HTTP touch (ADR 057) is suppressed. It never flips "present."
- **Read-only** — `routeEnvelope` refuses a send from an observer (`forbidden`); it is also excluded
  from team-broadcast recipient resolution (it receives everything via the firehose regardless).
- **Fans out, never displaces** — exempt from agent single-active (ADR 042), so several dashboards can
  observe the same seat at once.

Provisioning: `POST /teams/:slug/members` accepts `observer: true` (and the CLI `musterd team observe
<name>` wraps it), minting a normal token. Observers are added directly to the db even on a file-backed
team (ADR 058) — they are runtime watchers, not durable roster seats — and reconcile does **not**
tombstone them for being absent from the seat files.

Why a flagged member rather than a separate credential type: it reuses the whole verified auth + hub +
firehose path and the dashboard client as-is; the only new surface is "filter it out of the
participant-facing views." A member-less observer-token scheme is cleaner in theory but would touch the
protocol frames, the hub's member-keyed model, and the client — more risk for the same user-visible
result. The flag is the smaller, safer cut.

## Consequences

- The dashboard provisions an observer seat and connects to it exactly as before; the team's roster,
  counts, and presence stream are untouched by someone watching. "Counts as no one" holds.
- Observers are read-only by construction (send refused), so an observer token can't be used to inject
  messages — a safe credential to hand to a display.
- Schema migration v7 adds `members.observer` (default 0); existing rows are participants, unchanged.
- Limitation noted: observers are not durable across `team export` (they aren't seat files); a
  dashboard re-provisions its observer if the daemon's db is reset. Durable/observer-token models are a
  future option, not needed now.

## Observability & Evaluation

- **Traces:** the route log already carries `recipients`/`delivered`/`firehose_delivered`; observers
  simply don't appear as recipients. No new span — observation is a read fan-out, not a coordination
  act.
- **Eval:** n/a — access/visibility plumbing, no agent-facing model decision to score.
- **Experiment:** n/a — no behavioural variant. (If anything, the observer *is* the surface future
  team-outcome evals read through, per ADR 061.)
