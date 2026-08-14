# Incident convergence — shared blockers become owned lanes without human routing

- Date: 2026-08-14
- Lane: `01M00PNG2Q0JZFEVH53PKAPKH1`
- Author: miley (design session with nick)
- Status: spec approved in conversation; implementation not started
- Relates to: ADR 150 (lane ownership), ADR 227 (roles), ADR 252 (wake pricing), ADR 253 (breaker does not ask a human), ADR 262 (per-edge firing ledger), ADR 264 (why-slot aging)

## Problem

When one defect blocks a shared gate, every seat experiences it as a private failure. On
2026-08-13/14 the a11y contrast gate went red on every open PR (#828, #829, #830) and on main's own
tip. Four seats independently debugged the same red, each as a side quest of their own lane; two
produced confidently wrong mechanisms; the human had to intervene twice — first to tell each seat
that the others were hitting the same thing, then to route "check your messages" serially, seat by
seat, using one agent's urgency ranking as the routing table.

The failure decomposes into four parts, and they are separable:

1. **Detection.** Nobody — daemon or seat — recognized that N reds were one cause. The evidence was
   available (same check, same rows, on branches whose diffs could not touch it) but nothing
   clustered it.
2. **Deduplication.** The lane system exists to dedupe work, and it worked the moment the blocker
   became lanes — izzo stood down, dolly handed over her finding, the surface split cleanly between
   two owners. The gap was the hours the blocker spent as ambient trouble _before_ anyone made it a
   lane.
3. **Attention.** Inbox is pull-based. Broadcasts sat unread; out seats never pulled. The human
   became the interrupt controller.
4. **Sequencing.** "Does anything merge past the red" had no owner and defaulted to the human.

The counterexample, from the same episode: stanley's `request_help` was relayed into a live session,
the recipient converged on his evidence in one pass, and no human routed anything. The mechanism
this spec builds is that path, made the default instead of the lucky case.

## Decisions taken in the design conversation

- **Success criterion:** brief duplication is acceptable; what matters is convergence to one owner
  within minutes, with zero human routing. (Not "zero duplicate burn" — that requires mechanical CI
  watching on day one, rejected as increment 1.)
- **Attention policy:** nudge live sessions plus _targeted_ wakes with a named beneficiary, priced
  under ADR 252. No broadcast wakes.
- **All knobs are per-team admin config**, in the same policy block that carries `loops`.
- **Roles route, they do not monopolize.** A platform/CI role is the _default owner when nobody
  claims_, not the sole fixer — the a11y fix spanned two surfaces (`scripts/a11y/**`,
  `packages/web/**`) that no single role seat should own, and the diagnosis needed the seats who
  hit it.

## Design

### 1. The report — how a blocker enters the system

No new act. A seat that hits a red it cannot explain attaches structured meta to the
`status_update` it already sends:

```jsonc
meta.blocked_by = {
  "gate": "ci:gates/A11y contrast",                    // the cluster key — exact match only
  "ref": "pr#828",                                     // what is parked behind it (optional)
  "sig": "lc-office__caption /office-preview 2.83"     // detail for the eventual owner, never matched on
}
```

Clustering is on `gate` **exact-match only**. The incident that motivated this printed
`2.83 #a49786` on CI and `2.85 #a69785` on a GPU for the _same defect_ — element-level signatures
would have clustered as two incidents. Check-name granularity is the level seats can state
identically without coordinating. `sig` rides along for the owner and is never matched on.

The guidance line (session primer + wiki): _"A red on a check your diff can't touch: report
`blocked_by`, park the work, move on. Don't debug it."_ The norm holds because the report is
cheaper than the debugging it replaces.

### 2. The incident — a lane, not a new object

When `cluster_threshold` (default 2) **distinct seats** have reported the same `gate`, the daemon
opens a lane:

- `kind: 'incident'` — one new nullable column on lanes; everything else is the existing shape.
- Title derived from the gate; `stakes: 'high'`; unowned; no surface globs yet (diagnosis
  localizes the surface later, via the normal `lane_update`).
- Detail seeded with every reporter's `sig` and `ref`, appended as further reports arrive.
- One open incident per `(team, gate)`: reports matching an open incident append to it, never open
  a second.

Claiming, handoff, surface declaration, submission, and acceptance are all the existing lane
machinery, untouched.

### 3. Convergence — routing, claim window, wakes

- **On open:** nudge live local sessions via the existing delivery-hint/relay path, and show the
  banner (§4). No wakes yet.
- **Claim window** (`claim_window_ms`, default 10 min): any seat may claim — context beats role.
- **Unclaimed at window close:** the daemon assigns to the seat holding `fallback_role` (default
  `platform`), waking it if asleep and `wake_on_route` is set. One wake, one named beneficiary.
  Implementation: one new candidate constructor (`dueIncidentWorkOrders`) in the wake router, which
  places incident wakes under ADR 262's per-edge breaker and attempt caps automatically — no new
  runaway-spend path.
- **Duplicate reports** matching an open incident get an automatic reply: _"already owned by X,
  lane Y — park behind it."_ The report is still appended to the lane (more refs = better fan-out
  at resolve).
- **On resolve** (`lane_resolve` of an incident lane): the daemon notifies exactly the reporters —
  nudge live sessions; wake wakeable reporters whose `ref`s were parked, if `wake_on_resolve`;
  inbox for the rest.

### 4. Orientation — the banner

`team_next` and the session-start primer lead with any open incident:

```
⚠ incident: ci:gates/A11y contrast — owned by miley (lane 01…, open 2h).
  If your red matches, it is not yours. Report blocked_by and park behind it.
```

This is the cheapest, highest-leverage piece: most of the measured waste was seats _starting_
sessions into a red they assumed was theirs.

### 5. Config — per-team, admin-written

In the team policy block, beside `loops`:

```jsonc
incident: {
  enabled: true,             // false degrades to today, exactly
  cluster_threshold: 2,      // distinct reporters to auto-open
  claim_window_ms: 600000,
  fallback_role: "platform",
  wake_on_route: true,       // wake the fallback owner if asleep
  wake_on_resolve: true      // wake reporters whose refs were parked
}
```

### 6. The human call that stays human

"Does anything merge past the red" is not automated. The incident owner raises it as an `ask`
(species `escalate`) to admins when queue cost warrants; the existing ask contract handles tiers
and timeouts. The human is removed from _routing_, and keeps the _judgment_.

### 7. Out of scope

- Mechanical CI watching (increment 3, only if increment 1's eval shows first-reporter burn still
  hurts).
- Cross-team incidents.
- Auto-remediation of any kind.
- Changing `REVIEW_LOOP_BREAKER_N`, wake pricing, or the ask contract.

## Observability & Evaluation

**Traces.** Counted events on existing audit verbs: `incident.opened / claimed / routed /
resolved`, each carrying the gate and reporter count.

**Eval.** Dataset: the 2026-08-13/14 a11y episode — ~4 hours from first shared red to single
ownership, ~5 human routing messages. Success on the next shared blocker: < 15 minutes from second
report to single ownership, 0 human routing messages. **Disproof:** two seats each burning > 15
minutes on one clustered gate after the incident opened, or an incident wake that cannot name its
beneficiary.

**Experiment.** None — this closes a measured coordination failure; no A/B.

## Increments

1. **Cluster + lane + banner + auto-reply.** Protocol meta, clustering, `kind:'incident'`,
   `team_next` banner, duplicate auto-reply. No wakes — biggest win, zero spend risk.
2. **Routing + wakes + config.** Claim window, fallback-role assignment, policy-B wakes, the
   `incident` policy block.
3. **CI watcher** as a second detection source feeding the same incident object — gated on
   increment 1's eval.

Each increment carries its own ADR at implementation time; this spec is the umbrella and its
Decision sections are not pre-written here.
