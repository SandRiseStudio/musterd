# 155 — The human presence ladder: steering marks you present

- Status: accepted — 2026-07-21. The founder approved the three open decisions as proposed (derived
  presence from the driver link; reuse the presence timeout for the idle window; present → quiet
  full-window wait / away → loud Slack at raise). Implements the fourth backlog item ADR 145
  re-sequenced (`human-presence-ladder`). Number **155 pinned** — next free on `origin/main` (highest is
  154), and now enforced by `adr-numbers:check` (#350).
- Date: 2026-07-21
- Builds on: [ADR 145](145-human-role-refounded.md) §3.3 (the decision — a human presence ladder where
  _steering marks you working_, presence informs timeouts, absolute time still drives them),
  [ADR 021](021-driver-co-presence.md) (driver co-presence — the `presence.driver` column this
  activates), [ADR 042](042-humans-multi-presence.md) (humans fan out — present in the browser while
  present elsewhere), [ADR 044](044-notification-tiers-localhost.md) (the self-set availability axis:
  `available`/`away`/`dnd`/`off_hours` + `away_until`), [ADR 057](057-ambient-agent-presence.md)
  (liveness from real actions, never a synthetic attach), [ADR 138](138-roster-posture-from-source.md)
  (the derived `posture`), [ADR 147](147-human-ask-stream.md)/[ADR 149](149-ask-surfaces.md) (the ask
  stream + surfaces this newly informs), [ADR 153](153-ask-reachability-gated-hold.md) (the
  reachability-gated hold — the consumer that today reads presence as a bare boolean).

## Context

The ladder ADR 145 §3.3 named reads, on inspection of the code, as **mostly already built** — as
primitives, unwired for the human:

- presence states `online`/`away`/`offline` (`protocol/acts.ts`), coarse activity
  `offline`/`idle`/`working` (renamed ADR 140), a self-set availability axis
  `available`/`away`/`dnd`/`off_hours` with `away_until` (ADR 044), and a derived `posture` that folds
  the two (`protocol/posture.ts`, ADR 138 — availability outranks activity);
- a `presence.driver` column (ADR 021) and a `driver` field on the hello/attach path, carried end to
  end (WS + HTTP).

So this item is **not** "invent the ladder." It is wiring the **sources** and the **one consumer** onto
primitives that exist. The record says exactly which wires are missing (ADR 145 Context): `MUSTERD_DRIVER`
absent from all 903 provenance rows, 0 of ~84 lanes human-owned, the human invisible on the roster
precisely while most present — because the two signals a steering human actually emits (driving an
agent, watching `/live`) light up nothing of the human's own.

## Problem

Turn the existing presence primitives into a **truthful human presence read, sourced from signals humans
already emit**, such that:

- a human **steering** an agent reads present — without a manual `status_update` — closing the dormant
  `driver-copresence-gap` ("I steer, therefore I'm online", ADR 145 §3.3);
- presence **informs** the ask-stream clock (a present admin can be waited on quietly; an away one is
  escalated to the loud surface sooner) **without ever becoming the absolute driver** — ADR 153's hold
  ceiling and `stranded` terminal are invariant;
- **nothing here is a monitoring surface.** Human presence is ops input, not monitoring output
  (surveillance-asymmetry, ADR 145): no new record of when the human was at their desk.

## Decision

Three increments over the existing model. No new presence state, no new table, no wire bump: the ladder
is **derived composition** over primitives that exist, plus one new **source** and one **consumer**.

### Increment 1 — steering marks you present (activates `driver` co-presence)

- **Provision the link.** `musterd agent` writes `MUSTERD_DRIVER` for the seat it mints, **opt-in per
  workspace**, exactly as `init` already does from the saved operator identity — closing the concrete
  hole (`musterd agent` never set it, so the ADR 021 annotation never fired for agent-provisioned
  seats).
- **Derive the human's activity from a live driver link.** When a live agent seat carries
  `driver: <human>`, that human composes as **`working`** in the roster read — derived at read time
  from the driver links, **not** a second presence writer and **not** a stored human presence row. This
  is the load-bearing call (see _Open for the founder_): the driver link is itself the real action
  (ADR 057), so composing presence from it needs no synthetic attach.

### Increment 2 — presence informs the ask clock, never the ceiling

ADR 153 already gates the top-tier hold on whether an admin is _reachable_ (present, or notifiable via
the Slack webhook). This adds **one modulation, held to a shipped default** (ADR 145 §6 — nick's
everything-configurable instinct lands as a default, not a knob):

- admin **present** (posture `working`/`idle`): the agent waits the full hold window quietly; the loud
  surface fires on the normal re-notify.
- admin **away/off_hours/offline-but-notifiable**: the loud surface (Slack, ADR 149) fires **at raise**,
  not only on re-notify — sitting a local timer for a demonstrably-away human wastes the window.

The **absolute timeout is unchanged** in both cases (ADR 153 ceiling): presence shifts only
_escalation-eagerness_ — which surface fires when — never the hold's end. `held`/`stranded` semantics are
untouched.

### Increment 3 — web tab as `online` + the idle heuristic

- an **authenticated `/live` tab** heartbeats the human `online` (ADR 042 fan-out) — the browser the
  founder actually lives in becomes a first-class presence source, not just an observer;
- **inactivity** beyond a fixed window flips `online → idle`, derived, no new stored state. Proposed
  default: reuse the existing presence timeout rather than invent a human-specific one.

### Decisions (founder-approved 2026-07-21)

ADR 145 left these three open; the founder approved the proposed default for each:

1. **Derived, not own-seat presence.** `working` is derived from the driver link at read time — no
   second writer, no synthetic attach. (The "I steer, therefore I'm online" thesis is satisfied by the
   derived read; a real own-seat presence row was considered and rejected as unnecessary machinery.)
2. **The idle window reuses the presence timeout** (Increment 3) — no human-specific timeout invented.
3. **Increment 2's modulation default:** present → quiet full-window wait; away → eager Slack at raise.
   The absolute ceiling stays fixed either way. Shipped as a default, not a knob.

## Consequences

- **No new presence state, table, or wire field.** The ladder is a derived read over existing primitives
  plus one source (`driver` → `working`) and one consumer (presence → escalation-eagerness). The
  smallest surface that closes the gap.
- **Surveillance-asymmetry honored.** Presence stays ops input: the steering-derived `working` is roster
  state computed at read time, **not** an audit trail of when the human was present. This ADR adds **no**
  human-activity audit row and **no** derived human-presence metric; need-to-know governs any future one.
- **The ADR 153 invariant is preserved.** Absolute time remains the end driver; presence changes only
  which surface fires when, never a hold's ceiling — so `stranded` cannot be produced or averted by a
  presence change. A hold whose absolute timeout moved with presence would be a bug, not a feature.
- **Opt-in, per workspace.** The driver link is written only when the operator opts in — presence is a
  convenience the human grants, never something musterd infers about them behind their back.

## Observability & Evaluation

**Traces** — deliberately thin, by the surveillance-asymmetry rule. Presence adds **no** new audit
action: the steering source is visible in the existing `presence.driver` column (a live roster read),
not a logged event stream of the human's comings and goings. Increment 2 reuses ADR 149's `ask.surfaced`
row — whether the loud surface fired at `ask.raised.ts` (away admin) or on re-notify (present admin) is
already legible from that row's timestamp, with no new trace.

**Eval** — headline: does "steering marks you present" close the `driver-copresence-gap` — the **share of
live agent seats carrying a driver link whose human composes `working`** (target: > 0; baseline: 0 of
903 provenance rows carry a driver at all). Secondary (the ADR 153 coupling): **latency-to-human-answer
for top-tier holds when the admin is away** — does escalating to Slack at raise (Increment 2) beat
waiting for the re-notify, without moving the ceiling? Guard metrics that must **not** move: (a) no
hold's absolute timeout ever shifts with presence — a `held`/`stranded` outcome whose window changed with
presence is a defect (this is the ADR 153 invariant, mechanized as a test); (b) zero new human-activity
audit rows on any team (the surveillance guard — presence is derived, never recorded); (c) the driver
link stays absent unless the operator opted in (no inferred surveillance). Dataset: the dogfood team's
roster + audit log; baseline: today's state — `MUSTERD_DRIVER` unset by `musterd agent`, presence read as
a bare boolean in reachability, the human offline on the roster while steering.

**Experiment** — a live dogfood, not a cell: (1) provision a driver link on a real steering session
(`musterd agent`, operator opting in) and confirm the human composes `working` on the roster while the
agent seat is live, and drops off the moment steering stops — the Increment 1 acceptance. (2) With an
admin self-set `away`, raise a top-tier `ask` and confirm the loud Slack surface fires at `ask.raised`
rather than on re-notify, while the hold's absolute timeout is byte-for-byte the ADR 153 default — the
Increment 2 acceptance and its ceiling guard in one run. Pre-registered here so the build has a
pass/fail target: success is directional (driver-derived `working` moves off zero; away-admin escalation
beats the re-notify), with the ADR 153 invariant as the hard guard.
