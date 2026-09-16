# 088 — The interrupt line: a tool-boundary inbox check reaches a busy agent

- Status: accepted — increment 1 shipped 2026-07-05 (PR #109); the arc continued in ADR 103 (inc2) + ADR 111 (inc3); amended 4× (latest 2026-09-16, lane 01M2P69FHZ)
- Date: 2026-07-03

## Context

The reachability ladder ([046](046-agent-side-reachability.md) heads-down nudge,
[053](053-inbox-reaches-blocked-agent.md) blocked-on-approval via the human,
[054](054-wake-on-message.md) idle `inbox --wait`) has a missing rung: an agent **busy mid-loop on its
own work**. A directed act lands at its seat instantly, but the model doesn't see it until its next
inbox check — minutes of stale-assumption work away. This is the canonical multi-agent-orchestration
failure observed live in a Qoder demo (steering couldn't propagate to busy agents → stale assumptions,
incompatible work, rework) and measured in our own P3 dogfood (~37% wasted work; the largest single
item, a dependency revert, was exactly a steering message that arrived too late). Full arc:
[interrupt-line-mid-loop-reachability.md](../design/interrupt-line-mid-loop-reachability.md) — this ADR
freezes **increment 1** of that design.

The unlock: a busy loop is not opaque. Harness hooks fire on **every tool call, mid-turn**, and hook
output is injected into the model's context. Each tool-call boundary is an interrupt point — a place
the outside world can put one line in front of the model without the model's cooperation. (Resident
harnesses have the same need at their gateway: they serialize runs per session, so a steer queues
behind the in-flight run. The busy-loop deafness is universal; only the injection point varies.)

## Problem

Deliver a waiting, interrupt-worthy directed act to an agent that is mid-turn on its own work — within
seconds, not at the next task boundary — without a wire change, without polling waste, without letting
team chatter thrash deep work, and without opening a prompt-injection channel into every working agent
on the team.

## Decision

### 1. `musterd inbox --interrupt-check` — the primitive

A one-shot, local, sub-50ms query against the daemon: *is there an interrupt-class directed act waiting
for this seat?*

- **No** → exit 0, **zero output**. The common case must be free: no context added, no tokens spent.
- **Yes** → exactly **one line** to stdout and exit 0, e.g.
  `⚡ musterd: urgent from june (handoff) — run 'musterd inbox' to read it.`
  _(Amended 2026-09-16: the tail now names the act id and a by-id read. See the amendment below.)_

It reuses the waiting-act predicate ADR 046 built for the per-command nudge — this extends that nudge
from "musterd commands only" to "every tool call the agent makes." No SPEC bump, no new wire frames.

### 2. Provisioned as a PostToolUse hook by `musterd init`

`musterd init` (and `musterd agent`) wires the check as a **PostToolUse hook** in harnesses that
support hooks (Claude Code first), alongside the SessionStart hook it already writes
([060](060-verify-provisioning-not-assume.md); layered-guidance stamping, ADR 085). `init --check`
verifies the wiring (the 060 drift-detector pattern). Where hooks are thinner (Cursor today) the
design degrades to the ADR 046 per-command nudge; where absent, the ladder's other rungs apply.

### 3. Interrupt-class is scarce by construction

Only acts that clear a severity bar raise the line; everything else waits for the natural
task-boundary inbox check:

- **urgent-tier directed acts** ([044](044-notification-tiers-localhost.md)), which
  `can_flag_urgent` (ADR 071 governance) already gates by capability — a seat without the capability
  gets downgraded-and-delivered, and **cannot interrupt**.
- Future steering acts (design §4.2–4.3: `steer` / `challenge`) are interrupt-class by definition —
  they arrive in increment 2 and need no change here beyond act names.

### 4. Injection-surface mitigations are launch requirements, not follow-ups

Injecting teammate-authored text into a working agent's context mid-turn is a prompt-injection vector;
a compromised seat could steer every busy agent on the team. Therefore, from the first release:

- The injected line is **daemon-composed** from structured fields (sender, act, tier) — **never the raw
  message body**. Reading the body is an explicit follow-up act by the agent (`musterd inbox`).
- Sender identity is always present in the line, so the model can weigh the source.
- The capability gate (§3) bounds *who* can raise the line at all.

## Consequences

- Steering reaches a busy agent at its **next tool boundary** (typically seconds) instead of its next
  task boundary (minutes). The deaf window shrinks to: one tool call's duration, mid-generation gaps,
  and the ADR 053 approval-parked case — which keep their existing rungs.
- Cost at rest is one fast local process per tool call and zero context growth in the no-message case.
  If measured overhead is noticeable, the hook can throttle (e.g. skip if last check < Ns ago) without
  design change.
- The interrupt line becomes the delivery channel later increments ride: `steer`/`challenge` acts,
  goal-epoch mismatch warnings, and dependency-invalidation flags (design §§4–5) all arrive as more
  reasons the same line can fire.
- A new provisioning surface to keep honest: `guidance:check`/`init --check` must cover the hook so a
  renamed flag can't silently kill reachability.

**2026-09-05 — the line never reached a Claude Code model, and the audit could not have told us
(lane 01M1T4339Y).** Decision 1 says "exactly one line to stdout". Claude Code's hook contract says
a PostToolUse hook's plain-text stdout at exit 0 goes to the **debug log** and is never shown to the
model — only `UserPromptSubmit`, `SessionStart` and two others promote bare stdout to context; what a
PostToolUse hook can hand the model is the JSON field `hookSpecificOutput.additionalContext` (or
`systemMessage`, or stderr on exit 2). So since this ADR shipped, every Claude Code raise was written
to the daemon as `interrupt.raised`, run by the hook, recorded in the transcript's `hook_success.stdout`,
and read by nobody. Measured in izzo's own transcript on 2026-09-05: **67** PostToolUse hook runs
carried a musterd line — "ryder took a turn" at 00:48:26Z among them — and **0** appeared in the
model's context; the seat noticed none. The 2026-09-05 bell check saw the same fact from the other
side: every Claude Code seat answered "no bell", including ryder, whose probe the daemon had
provably raised nineteen seconds after the turn. The fix is one flag: the hook now runs
`musterd inbox --interrupt-check --hook claude-code`, which emits the line as
`{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}`, and the deaf line
(#1317) rides the same seam — it too had been going to the debug log. Cursor's adapter (ADR 369)
already wrapped its seam correctly, which is how the mistake stayed visible only on the harness
everyone assumed worked. Two things follow. First, `interrupt.raised` measured delivery to the
**hook**, never to the **model**; the raised→read pair this ADR's Eval leans on was confounded by
agents reading their inbox for unrelated reasons. Second, the doorbell contract the cross-harness
huddle is convened to write must name each harness's injection seam explicitly — "prints a line" is
not a delivery. Existing worktrees carry the old hook command; `musterd init --refresh-hooks`
rewrites the marker-owned hook, and the SessionStart nudge already says so.

## Amendment 3 — discharge (2026-09-14, lane 01M2GJFCQV)

Six clauses of the doorbell contract (`docs/design/daemon-doorbell-contract.md`) governed delivery
and none governed what stops ringing. Three live falsifiers on `c8e89dd8` the same day: a routed
acceptance for a lane closed eight days earlier rang at every boundary of two sessions (ryder); a
steer read, acted on and replied to on its own thread rang ~20 boundaries across two sessions
(delta); and a directed `interrupt-check` returned `count: 1` with only that stale ask, so a live
seam with a pinned cursor read as PASS on all six clauses. A bell that rings the wrong thing at every
boundary teaches the model to ignore it, which defeats the six at once.

**Decided:** the interrupt line discharges on any of — (i) this seat's own accept/decline/resolve
(#1361); (ii) the referenced lane leaving awaiting acceptance, answered or not; (iii) a
co-addressee's accept or decline on an eligible-set act, fetched by reference because it is a DM to
the asker and outside the seat's window; (iv) for an act with no answering move — a steer, an urgent
message — being **rendered to the addressee by an inbox read**, recorded as one `inbox.rendered`
audit row per (recipient, act), or the addressee's own reply on it. The ADR 287 watermark is
unchanged and cannot carry (iv): an elided backlog pins the cursor behind the act forever, which is
exactly the field case. `interrupt-check` itself never writes the row — the one-line notice is not a
read. When the newest steer is discharged the superseded steers under it go with it (ADR 103), so
none rises in its place. The paid wake rail reads the same candidate set, so a wake is no longer
leased for an obligation whose lane already closed.

Falsify: on a daemon carrying this, a `lane_review` ask whose lane is `done`, or a steer the
addressee has been shown by `musterd inbox`, appearing in `interrupt-check`'s `act`.

## Amendment 4 — the follow-up is a by-id read (2026-09-16, lane 01M2P69FHZ)

§1 fixed the line's *shape* and never its *destination*: the tail said `run 'musterd inbox' to read
it`, which is an unbounded read. That is fine for a seat a few acts behind and a haystack for the
seats this ADR exists to reach.

Measured 2026-09-16 (izzo, lane 01M2P5B3RE), native wake of compo at 6,231 unread: nick's steer
`01M2P6211PG002HS91QAVK3DH6` was delivered verbatim into the turn-3 tool result, the model **obeyed
the line** and called `team_inbox_check {limit:5}`, the daemon marked the steer `inbox.rendered` at
22:40:43Z — and the model's next act ignored it. The steer was five lines inside a 32 KB result.
Delivery held; the instruction was wrong for the seat. Note what the discharge rule in Amendment 3
does here: clause (iv) counts that read as having rendered the act, so the line stops ringing for a
steer the model never acted on. A wrong follow-up therefore does not merely waste a turn — it
consumes the obligation.

The act id was already in this route's JSON (`act: {id, from, act}`) and never on the line, which is
the only part of the reply a model sees.

**Decided:** `composeInterruptLine` names the act id and the read that fetches exactly it, in both
spellings — `team_inbox_check {ids:["<id>"]}` and `musterd inbox --id <id>` — each carrying the id
verbatim so either is copy-pasteable as-is. All three branches (single, plural, huddle) take it; the
huddle line keeps its `musterd huddle say <thread>` answer verb. The plural line names ONE act, the
headline the notice is about, because naming a queue without naming a row is the same haystack one
size smaller. `musterd inbox --id` is new and moves **no cursor**: being rung about one act is not
having read the window behind it.

Both spellings rather than one chosen by surface: the tempting tighter version forwards the CLI's
`--hook <harness>` and lets the daemon pick, but `HOOK_SEAMS` knows only `claude-code` while Cursor
has its own seam and passes no `--hook` at all — a Cursor seat holding musterd MCP tools would be
told to shell out, which is this defect moved rather than fixed. An id is 26 characters and the line
fires once per raise.

Still inside §4: an act id is a structured field, never `env.body`.

Falsify: a seat with >1000 unread receives a steer and its next tool call after the line is anything
other than a by-id read of the named act.

## Observability & Evaluation

**Traces** — emit `musterd.interrupt.check` (counter, dimension: `result` = `silent` | `raised`) and
`musterd.interrupt.raised` audit events carrying act id + sender + tier, so every raised line is
first-party auditable (who grabbed the mic, when, at whom). The raised→read pair (raised event followed
by the inbox read of that act) is the delivery-confirmation signal.

**Eval** — the headline metric this ADR exists to move: **steering latency** — time from an
interrupt-class act being sent to the recipient's next act acknowledging it (measurable today from the
message DB; the P3 dogfood is the baseline, where the dependency-steer went unseen for a full work
cycle and produced the 53%-of-waste revert). Targets: median steering latency under one tool call's
duration for hooked agents; interrupt precision (raised lines that the operator/agent judges
interrupt-worthy) high enough that nobody disables the hook — the disable rate is itself the guard
metric.

**Experiment** — the built-in A/B: same two-agent task with a mid-task direction change, hook on vs
hook off (hook-off = today's behavior, the control), comparing steering latency and rework (reverted
lines attributable to stale assumptions). This is also the launch demo and a coordination-traces
benchmark scenario (ADR 056).
