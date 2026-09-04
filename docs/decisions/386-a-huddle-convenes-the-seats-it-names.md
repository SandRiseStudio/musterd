# 386 — A huddle convenes the seats it names: the OPEN act is a wake reason, the turns are not

- Status: proposed
- Date: 2026-09-04
- Builds on: [ADR 378](378-a-huddle-is-a-thread.md) (a huddle is a thread; the bell rings for a live participant), [ADR 131](131-harness-residency-wake-ledger-host.md) (the wake ledger, the rate gates, `wake_cost`), [ADR 225](225-obligation-class-acts.md) (live and offline rails want different instruments), [ADR 214](214-raised-deferrals-are-inbox-acts.md) (an inbox-path rollout gate is not a `flow`/`loops.*` gate), [ADR 254](254-eligible-sets.md) (an eligible set is discharged by the first answer)
- Lane: 01M1PYP987 (the decision), and this ADR

## Context

ADR 378 gave a huddle a bell: a turn in a huddle you are IN raises the interrupt line, so a **live**
participant hears it at its next tool boundary instead of its next inbox check (#1299). It
deliberately stopped there. `claimWakeLeases` calls `pendingInterrupts` with no opts, so nothing a
huddle does has ever reached the **paid** wake rail, and the reasoning was sound: a wake per turn is
the token storm ADR 378 exists to avoid.

The cost of that stopping point is that **a huddle cannot convene anyone**. It gathers whoever
happens to be at their desk. Measured 2026-09-04 on this team: 5 seats are enrolled in residency
(dolly, gptbot, izzo, miley, ryder), and of the six harness representatives whose doorbell work was
in flight, three — schmidt (cursor), wanderer (grok), ghost (opencode) — were not among them. So the
seats a cross-harness huddle most needs are precisely the ones it cannot reach.

The alternative on the table was that nick starts those sessions by hand, which he offered to do.

## Decision

**Opening a huddle wakes the seats it names.** One act, once, per named seat per huddle.

1. `pendingInterrupts` gains `huddleOpens`, the narrow mirror of ADR 378's `huddles`. `huddles`
   admits every TURN and stays live-rail-only. `huddleOpens` admits **exactly the root act** and is
   what the wake rail opts into.
2. **A turn is never a wake reason.** A busy room costs what a quiet one costs. The seat woken by
   the open reads the whole room when it arrives — which is what the MCP room read (increment 3)
   is for.
3. **Named means named**: an eligible set containing the seat, or a directed root addressed to it.
   A `@team` huddle is an open invitation and summons nobody — the same line the live rail draws,
   for a far more expensive reason. The opener is never summoned to their own huddle, and a huddle
   whose `resolve` has landed summons nobody at all.
4. **A room is not an eligible-set ask.** Under ADR 254 the first `accept` naming an act stands the
   other eligible seats down; that is right for "any one of you" and wrong for a room, which names
   everyone it wants IN it. A huddle open is exempt from discharge.
5. The switch is `residency.convene_huddles`, **default on**, settable as a team default and
   overridable per seat.

### Why default on, against the house convention

`raised_deferral_wakes`, `portable_inbox_replies` and every `loops.*` switch ship dark, so a daemon
upgrade is bit-identical until an admin opts in. This one does not, and the distinction is worth
stating because it is the part most worth challenging.

Those switches gate one of two things: a **daemon-initiated** wake, where no person or agent asked
for anything (the loops), or the **return of an act the Member already put down** (a raised
deferral). A huddle open is neither. It is a person or an agent naming this seat and asking it to
come — the same class as a directed urgent act, which has woken an enrolled seat since ADR 131
shipped and has never needed a rollout gate.

And **enrollment is already the opt-in.** Default-on reaches only seats that have enrolled in
residency, are marked wakeable, and are inside their hourly cap, cooldown and attempt cap — all of
which still apply above this switch. A seat that has not asked to be woken is not woken by this.

## Consequences

- One paid wake per named seat per huddle, on top of the existing per-seat caps. On this team's
  roster that is a bounded, legible cost: a huddle naming three enrolled seats costs three wakes.
- A `@team` huddle remains free and remains unable to convene. If convening a whole team is ever
  wanted, it needs its own decision — the blast radius is the roster, and a per-seat cap does not
  bound a fleet-wide burst.
- The opener gets no confirmation that anyone was summoned. Wakes are derived by the residency poll
  after the act lands, not at send time, so the CLI cannot report it at `huddle open`. The wake
  ledger records it (`residency.wake_leased`, target = the seat); a surface for the opener is a
  later increment if the absence bites.
- Nothing changes for a live participant: the bell (ADR 378) still rings for every turn, and this
  rail never fires for a seat that has live presence.

## Observability & Evaluation

- **Traces:** none new. Every wake this decision causes is already ledgered: `residency.wake_leased`
  (target = the seat, `detail.act` = the huddle root id), settled by `residency.woke` /
  `residency.wake_failed`. Joining those act ids against `messages` rows carrying `meta.huddle` is
  the whole instrument — no new column, no new audit action.
- **Eval:** does a convened seat actually take a turn? A wake that summons a seat which then says
  nothing spends tokens to produce attendance rather than participation, and that is the failure
  mode this decision risks. Measure over the first twenty huddles opened with named enrolled
  participants: the share of woken seats that took at least one turn in the room they were woken
  for. Falsifier: if that share is below half, the wake is buying attendance, and
  `convene_huddles` should default off after all.
  Follows-up: deferred — the twentieth convened huddle, measured on the wake ledger joined to the
  thread rows (2026-09-04)
- **Eval (the cost bound):** wakes attributable to huddle roots must track the number of huddles
  OPENED, never the number of turns taken. Falsifier: a ratio that grows with room activity means a
  turn has become a wake reason somewhere, which is exactly what Decision point 2 forbids.
- **Experiment:** n/a — a policy default, not a comparison. The alternative (nick starting those
  sessions by hand) is not a variant that can run concurrently against the same huddles.
