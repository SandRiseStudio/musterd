# 266 — Incident convergence increment 1: shared blockers become owned lanes without human routing

- **Status:** accepted 2026-08-14
- **Relates to:** spec `docs/superpowers/specs/2026-08-14-incident-convergence-design.md` (the
  umbrella; its Decisions section binds this increment), ADR 150 (lane ownership — the dedup engine
  this reuses), ADR 227 (roles — deliberately NOT consulted in increment 1), ADR 252/262 (wake
  pricing and the per-edge ledger — untouched here; increment 2 wires into them), ADR 051 (audit
  rows carry shapes, never bodies), ADR 085 (layered guidance — where the norm text landed).

## Context

On 2026-08-13/14 one defect turned the a11y contrast gate red on every open PR and on main's own
tip. Four seats independently debugged the same red as a side quest of their own lane; two produced
confidently wrong mechanisms; the human routed "check your messages" seat by seat. The lane system
deduplicated the work the moment the blocker became lanes — the gap was the hours it spent as
ambient trouble before anyone made it one. The spec decomposes the failure into detection,
deduplication, attention, and sequencing; this increment closes the first two and the cheap half of
the third, with zero spend risk (no wakes).

## Decision

1. **The report rides `status_update`** — no new act. `meta.blocked_by: { gate, ref?, sig? }`,
   shape-validated in `actMetaRules` whenever the key appears. `gate` is the cluster key,
   **exact-match only**; `sig` is carried for the eventual owner and never matched on.
2. **The incident is a lane, not a new object.** `lanes.kind` (nullable TEXT, v41; `'incident'` is
   the only value) plus an `incident_reports` table pooling reports per `(team, gate)`. At
   `CLUSTER_THRESHOLD = 2` distinct seats — a hardcoded constant; the per-team policy knob is
   increment 2 — the daemon opens ONE unowned lane (`stakes: 'high'`, no surface globs, title
   `incident: <gate>`, detail seeded with every reporter's sig/ref). One open incident per
   `(team, gate)`: later reports append, never open a second. All lane machinery (claim, handoff,
   submit, accept) is untouched; `kind` is immutable after open.
3. **Duplicate reporters get an automatic reply** ("already owned by X / open unclaimed, lane Y —
   park behind it"), and the opening reporters each get one announcement naming the lane — both
   composed by the daemon on the `routeEnvelope` post-persist seam and routed through normal
   delivery, so live sessions get the existing delivery-hint nudge for free. Incident traffic
   speaks as the lane's owner (else creator); a recipient who IS that voice is announced to by
   another reporter, because a self-send never reaches an inbox.
4. **`team_next` leads with the banner** (`NextBrief.incidents`, default `[]` for daemon skew) —
   most of the measured waste was seats starting sessions into a red they assumed was theirs.
5. **The norm text lives in the on-demand skill body, not the always-loaded primer.** A primer line
   was written and then removed: the per-session context budgets (`pnpm context:check`) had ~47 B
   of slack, and the human's call was to stop raising budgets when an on-demand layer serves. The
   live pointer comes from the banner; the teaching comes from the skill's "Shared blockers"
   section.
6. **Trace:** `incident.opened` / `incident.report_appended` / `incident.duplicate_replied` audit
   verbs, shapes only.

## What increment 1 deliberately does not do

No wakes, no claim window, no fallback-role assignment, no `incident` policy block, no CI watcher,
no resolve-time reporter notification, no auto-remediation (spec §3 remainder, §5, §7 — increments
2–3). "Does anything merge past the red" stays a human ask (spec §6).

## Observability & Evaluation

**Traces.** `incident.opened` / `incident.report_appended` / `incident.duplicate_replied` audit
rows, each carrying `{ gate }` plus the lane (and reporter count on open) — shapes only, never sig
or body text (ADR 051).

**Eval.** Baseline is the 2026-08-13/14 a11y episode: ~4 hours from first shared red to single
ownership, ~5 human routing messages. Success on the next shared blocker: < 15 minutes from second
report to single ownership, 0 human routing messages — measured from the audit rows above joined to
the message log. **Disproof:** two seats each burning > 15 minutes on one clustered gate after the
incident opened, or an incident that never converges to one owner.

**Experiment.** None — this closes a measured coordination failure; no A/B (spec's own call).
