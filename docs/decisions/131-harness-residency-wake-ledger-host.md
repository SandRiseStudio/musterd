# 131 — Harness residency: the wake ledger and the host

- Status: accepted — design frozen; increments 2–6 are the build arc
- Date: 2026-07-12
- Builds on: [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) (interrupt line +
  injection bar), [ADR 087](087-seat-resume-vs-claim-one-verb.md) (resume ≠ claim),
  [ADR 054](054-wake-on-message.md) (wake the idle), [ADR 035](035-localhost-notify-daemon.md) /
  [ADR 024](024-human-reachability-nudge.md) (actuators live client-side),
  [ADR 090](090-per-recipient-delivery-status.md) (derived delivery ledger),
  [ADR 101](101-model-as-a-variable.md) (occupancy attestation),
  [ADR 108](108-probe-safe-autojoin.md) (probes never claim),
  [ADR 112](112-steward-seat.md) (residency named as the steward's destination),
  [ADR 127](127-authorization-provenance-gates.md) /
  [ADR 129](129-authorization-provenance-completeness.md) (authorization provenance)
- Contract: [harness-residency.md](../design/harness-residency.md) — the per-class residency
  contract, the wake-pipeline spec, and the increment map this ADR freezes.

## Context

The reachability ladder (agent-ontology.md §4, interrupt-line design §2b) has one rung left.
Idle seats wake on arrival (ADR 054), heads-down seats get the per-command nudge (ADR 046),
blocked seats route through the human (ADR 053), busy seats get the tool-boundary interrupt line
(ADR 088 → 125, complete and measured). **Offline** — the session exited, the harness process
gone — still means a directed act waits until a human relaunches the harness.

The strategic claim was frozen in agent-ontology.md §4: a seat's binding can hold the harness
session id, and musterd can resurrect the exited session on a directed act — **musterd makes any
harness always-on**. A landscape pass (2026-07-11) confirmed the position is still unclaimed:
every major harness now exposes the two primitives (a capturable session id and a scripted
headless resume — `claude --resume <id> -p`, Cursor `agent --resume <chatId> -p`,
`codex exec resume <id>`, and peers), but none has an inbound message→wake layer. The always-on
gateways (OpenClaw, Hermes) get residency by _owning the whole runtime_ — single-human-centric,
their own agent loop — and the vendor clouds own the infrastructure. Nobody wakes an arbitrary
local harness because a teammate needs it. Open Claude Code feature requests for exactly this
(daemon watch+wake, webhook wake) document the unmet demand.

One owner requirement extends the frame: **musterd itself becomes a harness** — a native agent
loop and chat surface, peer to Claude Code/Codex/Cursor. The ontology anticipated this
("musterd's own daemon" sits in the resident class); this ADR must leave that seam first-class,
not bolted on.

## Problem

Turn-scoped harnesses die between turns, and today musterd cannot do anything about it:

- The daemon never learns a harness session id (hooks discard their stdin JSON; MCP carries no
  session identity), has no seat→workspace map (`binding.json` is client-side by design), and has
  never spawned a process ("pure store + transport" is a deliberate boundary).
- The ADR 087 resume grant expires at 24h — precisely the long-offline case residency targets
  would fall back to the human-approval lane, stalling the wake on the human it exists to relieve.
- An unattended wake is a new injection and governance surface: teammate-authored text must not
  become a spawned session's prompt (ADR 088's bar), machine-initiated sessions must be visible
  and attributable (ADR 127/129), and a wake loop that misfires can burn real money.

## Decision

### 1. Split the primitive: the daemon keeps the ledger, a per-host `musterd host` acts

The **daemon** owns the _wake ledger_: which enrolled seats are offline with work waiting, under
what policy, with every decision audited. It never spawns a process, never learns a workspace
path or a session id. This preserves the store+transport boundary, the ADR 024/035 doctrine
(actuators that touch the host machine live client-side), and the cross-network topology — a
remote daemon can still order wakes it cannot physically perform.

**`musterd host`** is the actuator: a resident client-side loop (the `musterd notify` shape —
poll, presence-neutral, best-effort, LaunchAgent-managed in a later increment) running on the
machine that holds the worktrees. It maps seat→workspace via a machine-local registry, claims
wake leases from the daemon, spawns the harness resume in the seat's workspace, verifies the wake
**from the roster** (never by parsing process output — headless modes hang), kills on watchdog
timeout, and reports the outcome. It authenticates with the team `agent_key` (it is harness-side
infrastructure, not a seat); each woken session occupies via the seat's own binding grant, so the
host never holds seat credentials centrally.

The name is deliberate: the host is where the future **native musterd harness** lives (§7) — the
same resident process that resurrects external harnesses will host musterd's own agent loop.

### 2. Enrollment is the gate: `musterd residency on|off|status`

Residency is **opt-in per seat**, and enrollment is the authorization event. `musterd residency
on` (run in the seat's workspace) does three writes in one verb: the machine-local registry entry
(seat → workspace path + harness), the server-side enrollment row (seat, harness class, host
identity, `authorized_by` — this is an actor≠authorizer gate in the ADR 127 shape), and a
**standing resume grant** for the seat. `residency off` reverses all three — revoking the grant
is the kill switch (ADR 017's revocation primitive). `residency status` cross-checks the three
stores and names drift, the `init --check` idiom.

Standing-while-enrolled (not TTL-decayed) is a considered exception to ADR 087's "the TTL keeps
the human in control": a quiet week must not silently make a seat unwakeable — that is the exact
failure residency exists to close. Control moves from decay to explicitness: enrollment is
admin-authorized, audited, revocable, and visible on the roster (`offline · wakeable`).

### 3. Two wake lanes, both derived from stores that already exist

- **Immediate lane** — interrupt-class acts (`pendingInterrupts`, the ADR 088 predicate: urgent
  or steer, directed, unresolved). Same scarcity, same `can_flag_urgent` gate; residency adds no
  new way to command a teammate's machine, only a new state the existing one reaches.
- **Batched lane** — ordinary unanswered directed acts (the ADR 090 open-directed ledger), woken
  on a cooldown window. This is the "your handoff gets handled overnight" half of the claim.

Launch defaults (owner call, 2026-07-11): **both lanes on**, batched conservative — ~30min
cooldown, 2 wakes/hour/seat, 3 attempts per act — and **configurable**: team-level defaults with
per-seat overrides at enrollment (`residency on --lane both|interrupt|batched`, cooldown/cap
flags).

_Amendment (2026-07-14, increment 5): the knobs shipped — `ResidencyPolicySchema` (protocol) is
the single source of defaults/ranges; team defaults ride `teams.policy` (`PolicySchema.residency`,
set via `musterd residency policy`), the seat override is a sparse partial in the v16-reserved
`residency.policy` column, and every rate gate in the lease derivation reads the effective merge.
The actuation knobs (tool policy, bounds, transcript hygiene bound) travel per `WakeOrder`; the
host's local `--timeout` remains the ceiling policy can only tighten. Knob table + the two honesty
clauses (no `lane: off`; `budget_usd` flags, never kills) live in the contract doc §2._

### 4. Mutual exclusion is stored (wake leases); rate policy stays derived

The pressure-test correction this ADR codifies: ADR 090's "derived, never stored" maxim governs
_status_; a wake is an _actuation_, and actuation needs mutual exclusion. Audit rows are
best-effort by contract (`appendAudit` swallows errors) and cannot bear correctness — the
precedent for actuation-shaped state is the `requests` table, not the delivery ledger.

So: a **`wake_leases`** table (short TTL ~120s, reaper-expired exactly like requests). The host's
poll is `POST …/residency/wake-leases`: in one transaction the daemon derives due wakes, inserts
a lease per grant, and returns the orders — two hosts, a crash mid-spawn, or a re-poll race can
never double-spawn a seat. A crashed wake's lease expires and the wake re-becomes due, still
bounded by rate policy. Enrollment names one host per seat (last-enrolled-wins, audited), so a
second host is told it is not the actuator instead of silently racing.

Everything _rate-shaped_ stays derived from `residency.woke` audit rows (the `hasInterruptRaised`
pattern): cooldown, the hourly cap, and a **per-act attempt cap** whose exhaustion writes a
terminal `residency.wake_exhausted` and surfaces to the humans via notify. Termination is
provable: wake → cooldown → cap → exhausted. **Ping-pong bound:** acts sent from a
provenance-`wake` occupancy never qualify for another seat's _immediate_ wake — they fall to the
batched lane, so machine-to-machine chains run at cooldown cadence under caps, without lineage
tracking.

_Amendment (2026-07-14, increment 5): the ping-pong bound is now implemented — it shipped dark
(increments 2–4 had nothing recording who sent an act from where). Migration v21 adds
`messages.from_provenance`, stamped at insert from the sender's freshest live presence,
**server-derived by construction** (no wire field exists, so a wake-born session cannot
masquerade as human-driven); the lease derivation demotes interrupt-class candidates whose
trigger reads `wake` into the batched set. Depends on the §6 provenance amendment — without it,
resumed wakes sent acts labelled `session` and escaped demotion._

### 5. Session capture rides the hooks; the seat, not the session, is the identity

Claude Code (the reference implementation) passes `session_id`/`transcript_path`/`cwd` on every
hook's stdin — musterd currently discards it. Increment 4 provisions a SessionStart capture and a
new SessionEnd hook (markered one-liners, the ADR 088 pattern, covered by `init --check` and
uninstall) piping stdin to **`musterd session start|end --stdin`**, which writes
`binding.session {harness, id, started_at}` and pushes the _resumable attestation_ (harness class
only — never the id, never the path) straight to the daemon, presence-neutral (ADR 057) and never
claiming (ADR 108). The MCP adapter never reads `binding.session`, so there is no hook-vs-adapter
boot race to lose. SessionEnd is advisory (it never fires on a crash); resumability never depends
on it.

**Fresh-first degrade doctrine.** The durable identity is the **seat** — its memory (ADR 093),
its lanes, its worktree, its primer. The session id is continuity sugar. A wake therefore never
_requires_ a captured session: resume failure (stale id, 30-day GC, compaction breakage) falls
back to a **fresh session in the same worktree with the same composed prompt, inside the same
lease**, `--session-id` pre-minted so the host knows the new id even if capture hooks fail. This
is also why increment 3 ships wakes before capture exists — fresh-wake is a complete v0.

**Append + context hygiene** (owner call): wake runs append to the seat's session — one life, one
transcript, auditable by whoever resumes it next. Appending grows the context, so the contract
carries a hygiene clause: the host prefers resume for continuity but rolls over to a fresh
session when the transcript is bloated or stale — the cost bound and the compaction escape hatch
are the same clause. Fork-on-wake is a deferred per-seat knob.

**The local-session guard** (amended 2026-07-13, from the first measured wake; owner-endorsed):
**roster-offline ≠ workspace-idle.** The daemon leases on the presence it can see — and a daemon
bounce once dropped a seat's WebSocket so the roster honestly read `offline · wakeable` while a
human-driven session was actively working in that worktree; the wake spawned a concurrent session
beside it. Only the host's machine can see local liveness, so before actuating, the host consults
the target workspace's `binding.session`: no `ended_at` and a freshly-touched transcript (the
mtime signal survives a crash, unlike the advisory SessionEnd) means a live session holds the
workspace, and the wake is **deferred** — the lease settles with `deferred: true`, audited as
`residency.wake_deferred`, and the daemon snoozes further lease derivation for that seat for a
short window. A deferral burns **no** attempt/cooldown/hourly budget: a working human must never
exhaust the act's wake budget; the act stays fully due for when the session ends. Guard-first
ordering also means resume can never target a live transcript.

### 6. The wake run is bounded, composed, and visible

- **Composed, never quoted:** the spawn prompt is built from structured fields only (act enum,
  delimited sender name, seat, one instruction: check the inbox via musterd tools) — the ADR 088
  injection bar. Message bodies never enter a prompt; the lease response itself carries
  `{seat, act_id, sender, class, composed_line}` and no bodies (ADR 128 need-to-know). The woken
  session reads bodies the same governed way any session does: `team_inbox_check`.
- **Bounded:** `bounds {timeout_ms, max_turns?, budget_usd?}` — the watchdog timeout is the one
  universally enforceable bound and is mandatory; turn/budget caps apply where the backend
  supports them.
- **Reply-only by default:** the reference backend passes an allowed-tools list scoped to the
  musterd MCP tools under the default permission mode — an unattended run can coordinate but not
  edit. `seat-policy` autonomy means _the workspace's own settings govern_; musterd never widens
  permissions, and **the wake path never passes a skip-permissions flag** (the steward's CI shape
  explicitly does not transfer to a laptop).
- **Visible:** woken occupancies carry provenance **`wake`** (additive `PROVENANCES` entry), so
  the roster, stream, and office can distinguish machine-initiated sessions; every step is
  audited — `residency.enrolled|revoked|wake_leased|woke|wake_failed|wake_exhausted`, with wake
  detail `{act, sender, grant_id, lease_id, session: fresh|resumed}`. Increment 4 adds three:
  `residency.wake_deferred` (the local-session guard — outside every rate/attempt derivation) and
  `residency.session_captured|session_ended` (the capture pushes, detail `{harness, enrolled}` —
  harness class only, never an id or a path).

  _Amendment (2026-07-14, increment 5, owner-endorsed): **provenance describes the current
  animation source — newest wins.** The inc-4 rehearsals found resumed wakes attesting `session`:
  the woken session's hook-driven CLI one-shots ambient-touched the seat before the MCP adapter
  claimed, and the CLI never resolved `MUSTERD_PROVENANCE`, so the touch wrote the `session`
  default — verify credited that row, and the roster could not mark machine-initiated resumed
  occupancies. Fix: the CLI resolves `MUSTERD_PROVENANCE` exactly like the MCP adapter
  (`resolveAttestedProvenance`, agent keys only — a human shell must not label itself `wake`) and
  sends `x-musterd-provenance`; the ambient touch stamps it enum-validated. Where ADR 014 read as
  sticky-attach-time, this supersedes it for provenance: a machine wake reads `wake` from its
  first authenticated command, and a human later resuming that same session correctly flips it
  back to `session`. (Model/build attestations keep their COALESCE stickiness — ADR 101/135.)_

### 7. One actuator interface; musterd itself is a harness

The host drives an **`ActuatorBackend`** interface — spawn-or-invoke, verify, report
(`WakeOutcome {occupied, answered?, session_id?, cost_usd?}`) — and the contract doc holds a row
per harness. `claude --resume` is backend #1, _not_ the design: nothing above the backend may
assume a CLI flag shape. The **native row** is the reference case: musterd's own harness (the
agent loop hosted in `musterd host`, Agent-SDK-shaped, a chat surface as its front door) has
capture and resume for free because musterd owns the loop — wake is an in-process invocation.
If the contract cannot express the native row cleanly, it was CLI-shaped and wrong. Surface
`musterd` is reserved (additive) so native-hosted occupancies are roster-distinct. The thin
native backend is increment 6, owner-gated; the seam is frozen now.

The no-orchestrator principle holds: the host executes _reachability policy_ (wake who is
addressed), it never decides _work_ (what anyone does next stays on the plan/lanes).

### 8. Vocabulary

ADR 087 owns **resume** (grant re-presentation); the dogfood team owns "revive". This arc:
**residency** (the property), **wake** (the actuation), **host** (the process). CLI:
`musterd residency on|off|status`, `musterd session start|end --stdin`, `musterd host [--once]`.
Roster label: `offline · wakeable`.

## Consequences

- Schema v16 (additive): `residency` enrollment table + `wake_leases`; no wire bump (additive
  frame/enum fields only). Six new audit verbs render in `musterd audit` with no CLI change.
- The build arc is five lanes, frozen in the contract doc's increment map: **2** wake ledger
  (store + routes + reaper + `residency` CLI + roster label), **3** `musterd host` + Claude
  backend fresh-first (the first measured wake-latency number; extracts the PATH-robust `claude`
  resolver the LaunchAgent env demands), **4** session capture (hooks + `binding.session` +
  resume upgrade), **5** policy knobs + report metrics + service label + the steward swap,
  **6 (owner-gated)** thin native backend.
- ADR 112's substrate promise is honored: the steward's cron swaps to a residency trigger under
  an unchanged seat charter (increment 5's experiment).
- Residency is a **single-host primitive** (daemon and worktrees co-located) with the per-host
  seam explicit: hosts are enrolled per seat, so a cross-network team runs a host per machine;
  remote-exec is a non-goal.
- Deliberate deferrals, named: WS push to the host (poll ships first), SDK-managed wake sessions
  with true mid-run `interrupt()` (the interrupt-line doc's §7 v2, unlocked by the native seam),
  universal pre-mint at enrollment, wake-chain depth derivation, fork-on-wake knob, office
  choreography for `wake` provenance, multi-host failover policy, notify/host convergence into
  one resident client process.

## Observability & Evaluation

**Traces** — one `musterd.residency.wake` span per actuation (lease → spawn → occupied →
answered) emitted by the host; the six `residency.*` audit verbs make every wake decision
reconstructable (who enrolled, what leased, what woke, what failed, what exhausted, with
authorization provenance). The host's poll loop carries the resident-loop telemetry carve-out
(one span per actuation, never per tick).

**Eval** — headline: **wake latency** (directed act ts → woken seat's first authenticated act)
and **wake answer rate** (woken acts that reach `answered` in the ADR 090 ledger). Dataset: the
dogfood team's directed acts to offline recipients. Baseline: mined from the existing dogfood DB
before residency lands — median directed-act→first-answer latency where the recipient's presence
was offline at send (finite and honest, unlike "∞"); the steering-latency metric (ADR 125)
extends to offline recipients as the same headline number.

_Amendment (2026-07-14, increment 5): the metrics shipped — `deriveWakeMetrics` in the report
engine (`Report.wake`; `musterd report residency` + the team-altitude wake section + team_report),
per-distinct-act latency/answer-rate (the message log proxies "authenticated act", the ADR 125
convention; answer state is a LIVE ledger read, never the host's report-time snapshot), and wake
economics: cost per lease (deduped, a supplementary `residency.wake_cost` row wins — cost exists
only at run exit, after the primary report settled the lease inside the TTL) with `cost_reported`
as the honesty denominator and per-seat `over_budget` flags against the effective `budget_usd`
report bound. Presence rows are transient, so "recipient offline at send" is not retroactively
derivable — the live extension IS the wake block (wake-triggered acts are the offline-at-send set
by construction); the mined pre-residency baseline stays a one-off recipe recorded with the
experiment pre-registration._

**Experiment** — two, pre-registered: (1) the ADR 112 steward substrate swap — cron → residency
trigger under an unchanged charter, comparing task latency and cost per task across a week each;
(2) a cookoff residency benchmark row (research finding 005's resident-vs-CLI coverage axis) once
the run ladder resumes.
