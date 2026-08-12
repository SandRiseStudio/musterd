# 251 — The native backend: musterd as its own harness

- Status: accepted
- Date: 2026-08-12
- Builds on: [ADR 131](131-harness-residency-wake-ledger-host.md) (§7 reserved this increment
  and froze the seam it must fit), [ADR 101](101-model-as-a-variable.md) (the model ladder the
  native loop reads), [ADR 108](108-probe-safe-autojoin.md) (occupancy as a side effect of the
  first tool call), [ADR 135](135-build-provenance-every-runtime.md) /
  [ADR 109](109-seat-git-attribution.md) (the attestation chain the native seat joins),
  [ADR 144](144-mcp-tool-surface-measure-then-craft.md) (the scoped-by-role tool render the
  native agent consumes), [ADR 093](093-persistent-seat-memory.md) (the
  memory envelope a native occupancy surfaces), [ADR 241](241-a-wake-verifies-against-its-own-lease.md)
  (lease-bound verification)
- Lane: `01KXY9YRQWG6K70PWE77W0K0ES`
- Authored by izzo from a design session with nick, 2026-08-12 — the owner-gated design ADR 131
  §7 called for.

## Context

ADR 131 §7 froze the `ActuatorBackend` seam and named its falsification test: **the native
row**. musterd's own agent loop, hosted in `musterd host`, woken by in-process invocation
rather than a spawned CLI — "if the contract cannot express the native row cleanly, it was
CLI-shaped and wrong." Increments 1–5 shipped the contract, the ledger, the claude and codex
CLI backends, capture/resume, and the policy knobs. Increment 6 — this ADR — is the closing
reference row, explicitly owner-gated; the design above was settled with the owner in session.

Two facts shape the decision:

**No Anthropic dependency exists anywhere in the tree.** The closest runtime deps are
`@modelcontextprotocol/client`/`server` 2.0.0 and zod. Whatever thinks inside the native loop
is a new runtime dependency, which hard rule 6 gates on exactly this document.

**The field has converged on "harness engineering," and its admitted worst gap is the one
musterd already fills.** The 2026 harness literature (Anthropic's long-running-agent guidance,
the loop-engineering essays, the self-improvement surveys) centers on verification loops,
context lifecycle, and audit — while the multi-agent governance surveys report that only a
minority of teams give agents standing identities at all, and post-hoc attribution across
multi-agent runs is called the hardest open governance problem. Every surveyed harness
verifies work by trusting the model's own transcript. musterd has an independent truth source
— roster, lanes, wake ledger, attestation — and the native harness is the first loop born
inside it. The owner's standing directive for this arc: the native harness is to be the most
effective harness that exists, and its differentiation is this substrate, not a bigger tool
catalog. That ambition is chartered (not frozen) in Consequences; this ADR builds its floor.

The design deliberately splits in two. **Phase 1 (this ADR) is proof-of-contract**: the
thinnest honest agent loop that can occupy a seat and answer a directed act, invoked
in-process — proving the seam is not CLI-shaped. **Phase 2 (chartered, not designed)** is the
harness as product. The phase-1 substrate choices below are the ones phase 2's claims will
stand on; everything else is kept small.

## Decision

### 1. New runtime dependency: `@anthropic-ai/sdk` (hard rule 6)

`packages/cli` gains `@anthropic-ai/sdk`. The native loop is driven by the SDK's tool runner
(`client.beta.messages.toolRunner`): musterd defines the tools, the SDK runs the
request → execute → repeat cycle, and musterd owns everything else — context, session,
verification, cost accounting.

Alternatives considered and rejected:

- **`@anthropic-ai/claude-agent-sdk`** — Claude Code packaged as a library. Building the
  native row on it would make "musterd's own harness" a second wrapper around the same harness
  as backend #1, which weakens the very claim §7 exists to prove. Also a far heavier
  dependency (built-in filesystem/bash tools phase 1 must not have).
- **No model — a deterministic stub loop** — zero deps and it formally exercises every seam
  field, but it proves plumbing, not that musterd can host an agent; throwaway by design.
- **An existing in-tree dependency** — none can drive an LLM loop; confirmed absent.

### 2. `NativeBackend`, harness `musterd`, in-process

A third `ActuatorBackend` implementation registered alongside `claudeCode` and `codex`.
`wake()` spawns no child process: it starts an agent loop inside the host process. Surface
`musterd` (already reserved, additive, ADR 131 §7) makes native-hosted occupancies
roster-distinct.

### 3. The loop-engine seam: named, one implementation

The backend drives an internal **`AgentLoopEngine`** interface — given a system prompt, a
tool set, and bounds, run a loop; report turns, per-turn usage, and how it ended. Exactly one
implementation ships: `anthropicEngine` on the SDK above. The seam exists because ADR 101
made model a variable and Track B (ADR 110) keeps a local-model line open: the day a second
provider is a real requirement, the insertion point is already named and documented. No
second implementation is built now, and Claude-specific code (model ids, thinking/effort
parameters, refusal handling) lives only inside the engine file.

The engine resolves its model exactly like every other seat: the ADR 101 env > binding
ladder. The model the loop actually ran attests into the occupancy like any harness would —
the native seat participates in model-as-a-variable, never bypasses it.

### 4. Tools: the seat's own MCP surface, nothing else

The loop's tool set is not hand-rolled. The backend connects to the daemon as an MCP client
(`@modelcontextprotocol/client`, already in the tree) using the seat's binding, provenance
attested `wake`, and bridges the rendered `team_*`/`lane_*` tools into engine tools 1:1. This
buys, for free: the ADR 144 scope-by-role render, ADR 101/135 attestation on the connection,
and zero drift between what a native seat and any other seat can do. The engine never knows
it is talking to musterd; the bridge does.

**Phase 1 is coordination-only.** The native agent can check its inbox, answer a directed
act, send, update status, and work lanes. No filesystem, no bash, no network tools. It can be
woken and can genuinely answer — exactly the `{occupied, answered}` pair the ledger prices —
and nothing more. A working native agent (read/write/bash, sandbox, ADR 150 gate integration)
is phase 2 and requires its own design.

### 5. Occupancy is earned, never granted

The wake prompt starts the agent the way every seat starts: check your inbox. The agent's
first real tool call autojoins (ADR 108), presence appears with `provenance: wake`, and the
backend's `verifyOccupied` polls the roster with `sinceTs` = loop start and the ADR 241 lease
binding — the same independent evidence path as the CLI rows. musterd never claims the seat
on the agent's behalf; occupancy stays a side effect of the agent working. ADR 131 §1's rule
holds even with no process: **loop internals are never a verification source.** `occupied`
and `answered` derive from roster and ledger only.

### 6. Outcome, settled, and measured cost

`outcome` resolves as soon as verification does, inside the lease TTL. `settled` resolves
when the runner finishes or the watchdog aborts it, carrying `duration_ms` and `cost_usd`
**computed from the SDK's per-turn usage totals** — the native row is the first backend whose
`budget_usd` is measured by the harness rather than self-reported by a child process. Bounds
map exactly: `timeout_ms` → an abort of the loop (mandatory watchdog, never orphaned because
the host awaits `settled`); `max_turns` → the runner's iteration cap; `budget_usd` → a report
bound, per the frozen contract.

### 7. The phase-1 substrate additions

Two additions beyond the minimum, chosen because phase 2's claims stand on them and they are
cheap now:

- **Daemon-owned transcript capture.** Every native turn (prompts, tool calls, results,
  usage) is persisted through the daemon as a musterd artifact from day one — attested,
  auditable, priced — not a harness-private file. This is what makes ADR 131's "capture and
  resume for free" literally true. Resume itself is **explicitly deferred to phase 2**;
  phase-1 wakes are fresh-only, and the capture rows are the substrate resume will replay.
- **Per-turn telemetry into the wake ledger.** Usage reports turn-by-turn rather than only at
  settle, closing for this backend the known bias where `wake_cost` exists only when a run
  survives to report (#745).

## Consequences

- `packages/cli` gains `@anthropic-ai/sdk` (this ADR is the hard-rule-6 record). The
  provider seam bounds the blast radius of that vendor choice to one file.
- The residency contract doc (`docs/design/harness-residency.md`) gets its native row filled
  in; the ROADMAP residency item closes its "remaining: increment 6" clause when the
  implementation lands.
- The native seat is the first fully auditable agent loop in the tree: every turn is a
  daemon-held artifact under the seat's identity. Local `MUSTERD_DB` growth from transcript
  rows is accepted for the dogfood scale; retention policy is a phase-2 concern.
- A native wake spends real dollars against the configured model. Phase-1 rollout keeps the
  native backend opt-in (registry selection per enrollment), never the default.
- _Phase-2 charter (dated note, 2026-08-12, owner-endorsed) — the ambition on record, not a
  frozen design._ The native harness is to be the most effective harness in the field, and
  its differentiators are musterd's substrate, not feature parity: **verification as
  protocol** (progress claims audited against roster/lanes/ledger — the independent truth
  source no transcript-trusting harness has); **seat memory (ADR 093) as the loop's native
  memory**; **resume replayed from the phase-1 capture rows**; **the ADR 051/052/056
  trace→eval→experiment flywheel as the governed self-improvement loop** (pre-registration
  and frozen Decisions as the standing answer to reward hacking); and **model diversity as a
  first-class capability** through the loop-engine seam. Each of those is its own design
  conversation; none is licensed by this ADR.

## Observability & Evaluation

**Traces.** The native backend emits through rails that already exist: `wake_leases` rows
with the `musterd` surface; `residency.wake_deferred|wake_failed` with the standard failure
taxonomy; `residency.wake_cost` supplementary reports — now per-turn-derived; presence rows
attesting `provenance: wake`, model, and build on the occupancy. New: transcript capture rows
(daemon-held, keyed by occupancy) and per-turn usage rows, both additive.

**Eval.** Phase 1 is done when, on the live dogfood daemon, a directed act to an enrolled
native seat produces: (1) a verified occupancy (roster-derived, lease-matched) and an
in-band answer to the act — the `{occupied, answered}` pair — with latency comparable to the
increment-3 claude-backend baseline (occupancy 22.4 s, answered +46 s; the in-process row
should beat it); (2) a settled report whose `cost_usd` is present and equals the sum of the
per-turn usage rows (native target: 100% of settles carry cost, against the CLI rows' known
report-survivor bias); (3) a watchdog kill that leaves no orphaned loop and a
`wake_failed` with the standard taxonomy when the agent never occupies. The scripted
fake-engine suite must drive the backend through occupy/answer/timeout/deferral
(`occupied && !lease_matched`) paths without a model; the live run is owner-gated, one
measured wake, reported like increment 3's first-wake measurement.
