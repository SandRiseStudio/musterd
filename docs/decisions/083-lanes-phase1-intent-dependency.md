# 083 — Coordination lanes, Phase 1: the intent + dependency layer

- Status: accepted
- Date: 2026-07-01

## Context

The P3 dogfood post-mortem (`docs/design/lanes-and-the-multi-agent-tax.md`) measured where a
multi-agent session actually loses money: coordination *messages* cost ~1% of tokens, but **~37% of the
code produced never reached main** — and **53% of that waste was one dependency failure** (`d08cf43`, a
handshake built against a schema that wasn't finished). The rest was duplicate lanes: handoffs that
moved a *description* instead of a *branch*, so the recipient re-derived the work byte-for-byte.
Meanwhile the `resolve` act was dead in practice (2/21 loops closed) — closing a message thread is a
social courtesy agents forget.

The design arc's answer is **"team, not swarm"**: make work-ownership first-class and contention
*visible*, never gated. `docs/design/lane-phase1-mvp-spec.md` (reviewed) scopes Phase 1 to the two
signals that are catchable with **declarations alone** — no file-watching, no diff analysis,
git-optional. This ADR accepts that spec and resolves its open questions.

## Decision

**Ship the lane — `{ work-item × owner × surface }` — as a first-class, additively-landed object with
warn-only contention checks.**

1. **Data model.** One new `lanes` table (additive migration): `id, team_id, project, title, detail?,
   owner_seat?, role?, surface_globs[], depends_on[], branch?, state, created_by, timestamps`. States:
   `open | claimed | active | blocked | done | abandoned`. `project` scopes contention (the ADR 068
   workspace label; defaults to the team's single project). `surface_globs` + `depends_on` are the
   engine; everything else is bookkeeping.

2. **Verbs, dual-surface** (the `team_*` / CLI parity pattern): `lane_open`, `lane_claim`, `lane_board`,
   `lane_handoff` (**carries the branch** — the mechanic that kills the biggest single duplicate),
   `lane_update`, `lane_resolve`. Every mutating verb returns `{ lane, warnings[] }`. HTTP surface:
   member-authed `/teams/:slug/lanes` routes (`authTouch` — a lane verb is also an ambient-presence
   touch, ADR 057).

3. **Two checks, warn-only, never block** (run when a lane becomes/changes an active claim):
   - **`unmet_dependency`** — a `depends_on` target not yet `done` (the 53% case).
   - **`surface_overlap`** — declared globs intersect another *active* lane's in the same project
     (path-prefix/glob intersection; cheap set operation).
   Advisory always; the verb never fails. Dedup: a given `(subject, with, kind)` warns once until the
   condition clears or changes.

4. **Warning delivery — silent until actionable, never broadcast.** (a) **Inline** to the actor in the
   verb's response — they are already acting, zero extra tokens. (b) **One directed act to the affected
   owner** — an ordinary `message` act *from the acting member* with structured `meta.lane_warning`, so
   it rides the entire existing wake path (inbox, ADR 053 Notification hook, ADR 054 `inbox --wait`,
   ADR 024/035 notify) and needs **no new act and no SPEC bump** (free-form `meta`, like `meta.usage` in
   ADR 082). (c) On demand via `lane_board`. Nothing reaches the firehose/team.

5. **Lifecycle closes as a fact, not a courtesy.** `lane_resolve` → `done` manually; git bonus: when the
   lane's `branch` is observed merged into the main line (checked cheaply at the next lane-verb
   interaction, no watcher), the lane auto-transitions to `done`. Non-git teams simply use manual
   resolve — everything else is unchanged (git-optional throughout).

### Resolutions of the spec's open questions

- **Glob false-positives:** accepted in P1 (warn-not-block makes them cheap); warnings name the most
  specific shared path segment. Phase-2 observed-surface tightens precision.
- **`lane_ack`:** **not** in P1 — dedup-until-cleared is enough; an ack verb is Phase-2 if the board
  proves noisy.
- **Auto-claim:** `lane_open --claim` is opt-in; default `open` (unowned) keeps the Phase-2
  role-pool/assignment path open. The primer teaches agents `lane_open --claim` as the task-start habit.
- **Dependency re-warn cadence:** warn on declare + once when the depending lane goes `active`; after
  that the board carries it (no nagging).
- **Board vs roster:** augment, not replace — roster = who is present; board = who owns what.
- **Adoption:** the agent primer gains a lane habit line; no implicit lane-from-`handoff` in P1 (the
  prose `handoff` act stays for conversation; `lane_handoff` is the structured superset for work-units).

## Consequences

- **Additive, no flag day:** new table + new verbs; nothing existing changes. `status_update` traffic
  (51% of session messages) can migrate to lane transitions over time, but P1 only makes the board
  exist.
- The two acceptance replays from the spec become the DoD: the dependency-revert scenario produces an
  inline warning + a directed wake (the revert never happens), and the redone-lane scenario hands off
  a branch instead of prose (no byte-identical duplicate). A disjoint lane stays silent, and
  cross-project overlap never warns.
- Phase 2 (observed surface, merge-funnel, role-pool assignment, `lane_ack`) builds on this substrate
  and stays out of scope here.
- Whether lanes actually cut the wasted-work ratio is now *measurable*: ADR 082's telemetry shipped
  first for exactly this A/B.

## Observability & Evaluation

**Traces** — lane verbs ride the existing member-authed HTTP path; the directed warning is a normal
envelope, so it already gets the `musterd.envelope.process` span + counters (ADR 015/082). Add a
`musterd.lanes` counter (by verb) and a `musterd.lane.warnings` counter (by kind) so contention volume
is first-party.

**Eval** — the headline eval is the ADR 082 pair this feature exists to move: wasted-work ratio
(git-side, Phase-2/lab-notebook for now) and the emitted `musterd.coordination.loop_latency` /
`open_loops`. Lane-native evals: warning precision (acked-as-useful vs noise — judged qualitatively in
dogfood until `lane_ack` exists), % of lanes closed via `lane_resolve`/auto-merge vs abandoned (the
dead-resolve fix), and handoffs carrying a branch vs prose.

**Experiment** — the built-in A/B: the P3 session is the no-lanes baseline (37% wasted work, 2/21
resolves); the next comparable multi-agent dogfood runs with lanes on. If the wasted-work ratio and
duplicate-diff count don't move, Phase 2's observed-surface is the next lever — or lanes are the wrong
shape and we learn that cheaply.
