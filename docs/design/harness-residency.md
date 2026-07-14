# Harness residency — the contract

- Status: **frozen contract** ([ADR 131](../decisions/131-harness-residency-wake-ledger-host.md)).
  Position from [agent-ontology.md](agent-ontology.md) §4; ladder context in
  [interrupt-line-mid-loop-reachability.md](interrupt-line-mid-loop-reachability.md) §2b.
- Date: 2026-07-12 (landscape + capability research 2026-07-11; owner decisions 2026-07-11).

The claim this doc operationalizes: **musterd makes any harness always-on.** A seat is a durable
identity; a harness session borrows it (ontology §1). Residency is the property that a directed
act reaches the seat even when no session is animating it — because musterd wakes one.

## 1. Architecture — brain and hand

```
┌─ daemon (any host, pure store+transport) ────────────────┐
│ enrollment (seat → enrolled, harness class, host, grant) │
│ wake-due derivation: immediate ∪ batched lanes           │
│ wake_leases (stored mutual exclusion, ~120s TTL, reaper) │
│ rate policy derived from residency.woke audit rows       │
│ audit: residency.* · provenance: wake                    │
└──────────────▲───────────────────────────────────────────┘
               │ POST wake-leases (agent_key, presence-neutral)
               │ ← orders [{seat, act_id, sender, class, composed_line}]
               │ POST wake-report (WakeOutcome)
┌──────────────┴─ musterd host (per machine w/ worktrees) ─┐
│ machine-local registry: seat → workspace dir, harness    │
│ ActuatorBackend: spawn/invoke · roster-verify · watchdog │
│ backends: claude-code (ref) · … · native (musterd loop)  │
└──────────────────────────────────────────────────────────┘
```

**Three stores, each at its only-possible layer** — one verb (`musterd residency on|off|status`)
writes/reverses/cross-checks all three:

| store                         | holds                                                          | why here                                                             |
| ----------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `binding.session` (workspace) | harness, session id, transcript path, started/ended            | where hooks can write; per-machine secret-adjacent (never committed) |
| host registry (machine-local) | seat → workspace path, harness                                 | the host must resolve paths; the daemon must never learn them        |
| `residency` table (daemon)    | enrolled, harness class, host, `authorized_by`, `resumable_at` | roster/predicate need it; survives presence expiry                   |

## 2. The wake pipeline

1. **Trigger** — a directed act lands, recipient offline + enrolled. Lanes:
   - _immediate_: `pendingInterrupts` (ADR 088 — urgent/steer, directed, unresolved; the
     `can_flag_urgent` gate carries over unchanged).
   - _batched_: open directed ledger (ADR 090) on a cooldown window.
2. **Lease** — host polls `POST /teams/:slug/residency/wake-leases`; the daemon transactionally
   derives due wakes (lanes minus cooldown / hourly cap / attempt cap, all derived from
   `residency.woke` rows), inserts leases, returns orders. Crash ⇒ lease expires ⇒ re-due.
   One enrolled host per seat (last-enrolled-wins, audited).
3. **Actuate** — backend spawns/invokes in the seat's workspace. Prompt = the composed line only
   (structured fields; never message bodies). Bounds: `{timeout_ms (mandatory watchdog),
max_turns?, budget_usd?}`. Tool policy: `reply-only` (musterd MCP tools only, default
   permission mode) or `seat-policy` (workspace settings govern). Never a skip-permissions flag.
   **Local-session guard** (inc 4, ADR 131 §5 amendment): roster-offline ≠ workspace-idle — the
   host first consults the workspace's `binding.session` liveness (transcript mtime; survives a
   crash), and a live local session **defers** the wake: lease settles `deferred: true`, audited
   `residency.wake_deferred`, no attempt/rate budget burned, derivation snoozed briefly.
4. **Verify** — from the roster/audit (occupancy appears for the seat, provenance `wake`), never
   from process stdout. Per-harness identity check where the harness can silently mint a new
   session (Codex). Resume failure ⇒ **fresh fallback inside the same lease** (see doctrine).
5. **Report** — `WakeOutcome {occupied, answered?, session_id?, cost_usd?}` →
   `residency.woke | wake_failed`; attempt-cap exhaustion ⇒ `residency.wake_exhausted` + notify.

**Fresh-first doctrine.** The seat (memory ADR 093, lanes, worktree, primer) is the durable
context; the session id is continuity sugar. Every backend must implement fresh-spawn; resume is
an upgrade, never a dependency. **Context hygiene:** wake runs append to the seat's session
(owner decision — one life, one auditable transcript), and the host rolls to fresh when the
transcript is bloated/stale — cost bound and compaction escape in one clause.

**Ping-pong bound.** Acts sent from a provenance-`wake` occupancy qualify only for the _batched_
lane of other seats — chains run at cooldown cadence under caps. _Implemented increment 5
(2026-07-14): the daemon stamps the sender's presence provenance onto each message at insert
(server-derived, never wire-fed — v21 `messages.from_provenance`), and the lease derivation
demotes interrupt-class acts whose trigger reads `wake` into the batched candidate set._

**Policy knobs** (team defaults ⊕ per-seat override at enrollment — shipped increment 5,
2026-07-14; `ResidencyPolicySchema` is the one source of defaults and ranges):

| knob                   | default      | range                  | flag (`residency on` = seat, `residency policy` = team) |
| ---------------------- | ------------ | ---------------------- | ------------------------------------------------------- |
| `lane`                 | `both`       | both/interrupt/batched | `--lane`                                                |
| `cooldown_ms`          | 30m          | 1m–24h                 | `--cooldown 15m`                                        |
| `hourly_cap`           | 2            | 1–20                   | `--hourly-cap`                                          |
| `attempt_cap`          | 3            | 1–10                   | `--attempt-cap`                                         |
| `tool_policy`          | `reply-only` | reply-only/seat-policy | `--tool-policy`                                         |
| `timeout_ms`           | 5m           | 30s–1h                 | `--timeout 5m` (only _tightens_ the host's `--timeout`) |
| `max_turns`            | unset        | 1–200                  | `--max-turns`                                           |
| `budget_usd`           | unset        | ≤100                   | `--budget` (report flag — see below)                    |
| `transcript_max_bytes` | 10 MiB       | 64KiB–256MiB           | `--transcript-max <MiB>` (hygiene rollover bound)       |

Team defaults live on `teams.policy` (`PolicySchema.residency`); the seat override is a **sparse**
partial in `residency.policy` (reserved since v16 — no migration), preserved on a plain re-enroll
and cleared by `--reset-policy`. The effective policy is resolved per lease derivation and the
actuation knobs ride each `WakeOrder`, so the host applies policy it never stores. Two honesty
clauses: there is deliberately **no `lane: off`** (an unwakeable enrollment is a contradiction —
the kill switch is `residency off`; pausing the machine is stopping the actuator), and
**`budget_usd` flags, never kills** (no harness CLI can stop a run mid-flight on dollars — spend
_control_ stays cooldown/caps/watchdog; wakes whose attested cost exceeds it read `over_budget` in
the report, increment 5's metrics).

## 3. The residency contract, per class

### Turn-scoped harnesses (the class residency upgrades)

| harness                     | session-id capture                                                                 | wake (resume → fresh)                                                        | verify                                     | caveats                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **claude-code** (reference) | SessionStart/SessionEnd hooks → `musterd session … --stdin`                        | `claude --resume <id> -p "<line>"` → fresh `claude --session-id <minted> -p` | roster occupancy; same id (resume appends) | 30d GC (`cleanupPeriodDays`) — skip resume past horizon; compaction can break resume ⇒ fresh; resume is cwd-scoped but worktree-tolerant |
| **cursor**                  | **pre-mint**: `agent create-chat` at enrollment (CLI hooks too narrow for capture) | `agent --resume <chatId> -p` → fresh `create-chat` + resume                  | roster occupancy                           | headless `-p` hang reports ⇒ watchdog is load-bearing                                                                                    |
| **codex**                   | `codex exec --json` → `thread.started.thread_id`                                   | `codex exec resume <id>` → fresh `codex exec`                                | roster **+ thread-id match**               | silently starts a _new_ thread on a stale id — verify, never assume                                                                      |
| gemini                      | `--list-sessions` / session files                                                  | `gemini --resume <id>` (headless combo unverified) → fresh `-p`              | roster occupancy                           | treat resume as best-effort until headless resume is verified                                                                            |
| opencode                    | `ses_…` ids                                                                        | `opencode run --session <id>` → fresh `run`                                  | roster occupancy                           | `--fork` exists; session/continue interaction bugs on record                                                                             |
| amp                         | thread ids (`amp threads`)                                                         | `amp threads continue <id> -x` → fresh                                       | roster occupancy                           | `-x` bills on every tier                                                                                                                 |
| droid                       | session id from prior `droid exec`                                                 | `droid exec -s <id>` → fresh                                                 | roster occupancy                           | headless daemon-connect issues reported                                                                                                  |
| crush                       | none                                                                               | fresh-only (`crush run`)                                                     | roster occupancy                           | scripted resume is an open upstream request — fresh-first covers it                                                                      |

### Native (musterd's own harness) — the reference row

Capture: **free** (session state is musterd's own store). Wake: **in-process invocation** of the
agent loop hosted in `musterd host` (Agent-SDK-shaped; a chat surface is its front door; surface
`musterd`, reserved). Verify: trivial. Caveats: none — which is the point: this row keeps the
contract honest. Anything above the `ActuatorBackend` interface that cannot express this row is
CLI-shaped and must move down into a backend. Increment 6, owner-gated.

### Resident-class harnesses (OpenClaw, Hermes, gateways)

Wake is solved by architecture — the gateway always listens. The contract for this class is not
wake but **interrupt policy at the gateway**: runs serialize per session, so a steer queues
behind the in-flight run (deafness becomes queue latency — ontology §4 consequence 1). A
resident-class seat coordinating through musterd should surface interrupt-class acts into its
gateway's queue policy; no musterd-side wake machinery applies.

### Scheduled-class (cron, routines, the steward)

The contract is the **cadence source**: a scheduled seat's trigger swaps from cron to the wake
ledger with no charter change (ADR 112 §3's named destination — increment 5's experiment).
Scheduled remains a legitimate class for calendar-shaped work; residency covers the
message-shaped rest.

## 4. Security posture (inherited bars, made explicit)

- **Injection:** composed line from structured fields only; bodies never cross into prompts or
  lease responses (ADR 088 / ADR 128). The woken session reads its inbox through the same
  governed tools as any session.
- **Authorization:** enrollment is the actor≠authorizer gate (`authorized_by`, ADR 127/129);
  the standing grant is scoped `(agent_key, team, seat)`, revoked on `residency off` /
  unenroll / reclaim.
- **Autonomy:** reply-only default; `seat-policy` defers to workspace settings; the wake path
  never widens permissions and never passes a skip-permissions flag.
- **Visibility:** provenance `wake` on occupancies; ten `residency.*` audit verbs (the six
  wake-ledger verbs + inc 4's `wake_deferred`, `session_captured`, `session_ended` + inc 5's
  `wake_cost` — the supplementary spend record, since harness-attested cost only exists at run
  exit, after the primary report settled the lease); roster label `offline · wakeable`, with a
  `resumable` badge while the capture sits inside the ~30d GC horizon (a timestamp on the wire,
  so renderers apply freshness — inc 5, finding b).
- **Spend:** watchdog + turn/budget bounds + cooldown/caps/attempt-exhaustion; ping-pong
  demotion bounds chains.

## 5. Increment map (each = one lane-sized PR)

| inc | lane                                         | lands                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | this doc + ADR 131                           | the frozen contract                                                                                                                                                                                                                                                                                                                                                                    |
| 2   | wake ledger (server)                         | migration v16 (`residency`, `wake_leases`), `store/residency.ts` (through-DB tests), 6 audit verbs, enroll/lease/report routes, reaper lease expiry, `musterd residency` CLI, roster label                                                                                                                                                                                             |
| 3   | `musterd host` + claude backend, fresh-first | `cli/src/host/{loop,registry,backend,backends/claudeCode}.ts`, shared `resolveClaudeBin` (LaunchAgent PATH gap), provenance `wake` + surface `musterd` reserved, telemetry carve-out — **first measured wake latency**                                                                                                                                                                 |
| 4   | session capture                              | SessionStart/SessionEnd hooks → `musterd session start\|end --stdin`, `binding.session`, `init --check`/uninstall drift coverage, resume upgrade + hygiene in backend, local-session guard (`wake_deferred`)                                                                                                                                                                           |
| 5   | policy + measurement + service               | **landed 2026-07-14** (#269 knobs + ping-pong demotion + provenance newest-wins, #271 wake metrics + `wake_cost` + resumable badge, + `service --wake` + the steward-swap wiring/pre-registration): knobs (team config + enrollment flags), wake latency/answer-rate in the report engine, the wake actuator as a LaunchAgent, steward cron→wake trigger, cookoff residency row pinned |
| 6   | native backend (owner-gated)                 | thin Agent-SDK loop in the host, surface `musterd` live — the reference row proven                                                                                                                                                                                                                                                                                                     |

## 6. Deliberate deferrals

WS push to the host (poll ships first, notify precedent) · SDK-managed wake sessions with true
mid-run `interrupt()` (interrupt-line §7's v2, unlocked by the native seam) · universal pre-mint
at enrollment (`--session-id` / `create-chat` everywhere — capture keeps human-launched sessions
wakeable, so both stay) · wake-chain depth derivation (alternating `residency.woke` pairs) if
dogfood shows chains · fork-on-wake per-seat knob · office choreography for `wake` provenance ·
multi-host failover policy (leases already make active-active safe; preference is policy) ·
notify/host convergence into one resident client process.

## 7. Steward substrate swap — pre-registered (ADR 131 O&E experiment 1; wired 2026-07-14)

The ADR 112 §3 promise, run as an experiment: the steward's trigger swaps from cron to the wake
ledger **under an unchanged charter** (`CHARTER.md` and the task registry are byte-identical
across arms). Registered BEFORE the run; the result is written back here as a dated note.

- **Arm A (incumbent):** the weekly CI cron's `agent` job — a CI-launched Claude session drafts
  the fixes. Trigger latency floor = the cron cadence; cost from the CI job's API billing.
- **Arm B (residency):** `pnpm steward:notify` runs the same deterministic finders locally on the
  same weekly cadence and sends one structured `request_help` per drifted task to the enrolled
  `steward` seat (batched lane → `musterd host` wakes it; `seat-policy` autonomy — the charter
  drafts PRs; the wake path never passes a skip-permissions flag, the CI shape does not transfer).
  Cost from the wake ledger (`musterd report residency`, the `residency.wake_cost` records).
- **Duration:** one week per arm, same task registry, drift planted only by reality.
- **Metrics:** task latency (finder-run timestamp → draft-PR opened, via `gh api`) and cost per
  completed task; secondary, arm B only: wake latency + answer rate from the report engine.
- **Baseline (mined 2026-07-14, the O&E recipe over the dogfood DB, pre-residency epoch):** 4
  offline-recipient directed acts (answer = accept/decline naming the act, or a thread resolve;
  offline proxied as "no recipient act within 60s of send" — presence rows are transient, stated
  approximation): **2 answered, median ≈ 13.2 min; 2 never answered.** The first measured wake
  (2026-07-13) answered at **+46 s** — the number the swap is expected to generalize.
- **Abort conditions:** any `residency.wake_exhausted` on the steward seat, an `over_budget` flag
  (budget $2/wake), or a wake acting outside the charter — `musterd residency off` is the switch.
- **Run gate:** owner-approved spend only — provisioning and the 2-week run start on an explicit
  go (the runbook lives in `scripts/steward/README.md`).
