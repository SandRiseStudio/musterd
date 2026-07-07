# `resolve` as a state-transition gate, not a recap — open brainstorm

> **Status: OPEN BRAINSTORM, needs a dedicated session. Not spec, not scheduled, not an ADR.** Parked here so a fresh session can pick it up cold. The question is whether closing a thread (`resolve`, ADR 025) should ever require a *separate* signal than the actor who did the work — i.e. whether musterd should treat a thread close as a **verified state transition** instead of a **self-asserted recap**. Parents: `docs/decisions/025-resolve-act-thread-close.md` (what exists), `landscape.md` §4 (the corroborating evidence), `human-agent-dynamics.md` §4 (the governing maxim), `planning-and-insights-brainstorm.md` (point 5 — the terminal-done-marker thread this extends).

## Why this exists

The verifier-first reading of ~15 agentic-loop papers (r/AI_Agents, 2026-06; captured in `landscape.md` §4) keeps returning one line worth holding up against musterd's `resolve` Act:

> **BarberSuccessful2131:** "the part that breaks most often is treating verification as a **recap** instead of a **state transition gate**: if the compiler, test, browser check, or source readback does not pass, the loop should **not be allowed to mark the task done**."

Today musterd's `resolve` (ADR 025) is **self-asserted**: the actor who opened/worked a thread can also close it. The opener of a `handoff` or `request_help` can declare it resolved without the counterpart confirming. That is "verification as recap." The thread's insight — echoed across the post (DebaterLLM: *"a verifier can't share the generator's optimization target"*; mastafied: *"the model happily passes when it grades its own homework"*) — says a close should be gated by a signal the closer can't author alone.

musterd is unusually well-positioned here because it **already has separate actors**: a `handoff`/`request_help` thread inherently has a *different* counterpart who could be the verifier. The question is whether to *require* their signal to close, not whether one exists.

## The tension (why this is a brainstorm, not a fix)

The reason this is **not** a one-line change:

- **Counterpart-ack as a hard gate can deadlock.** If `resolve` *requires* the counterpart's `accept`, a thread whose other party left (human went home, agent seat freed) can never close. The whole point of single-operator localhost ergonomics (ADR 007) is that work shouldn't wedge.
- **Humans-as-peers cuts both ways.** A human lead may legitimately want to unilaterally close a thread ("good enough, moving on") — forcing a machine verifier on a human decision is exactly the "UX preference vs infra" line *inverted*. Humans are the verifier of last resort, not a party that must themselves be verified.
- **musterd is not the verifier and must not become one** (`observability.md` §3 non-goal). Any "gate" must be a *coordination* signal (a different seat's act), never musterd running a test/compiler/judge. The eval/judge machinery is batond's lane.

So the design space is narrow on purpose: how to make `resolve` *able* to be a verified transition **without** making musterd a verifier and **without** wedging threads.

## Open threads (the agenda for the session)

1. **Self-resolve vs. counterpart-resolve — when is each correct?** Likely answer is *kind-* and *act-scoped*: a `handoff` you accepted is yours to resolve; a `handoff` you *gave* maybe shouldn't be self-resolvable by the giver. Map each opening act (`handoff`, `request_help`, plain thread) to who may close it.
2. **Soft gate vs. hard gate.** Could a close be *recorded but flagged* as unverified (closer ≠ counterpart) rather than *refused* — surfacing "self-closed, no counterpart ack" in the roster/audit instead of blocking. This keeps the no-wedge property while making the recap-vs-gate distinction *visible* (the §6 audit-trail pattern applied to closes).
3. **What counts as the "separate signal"?** A counterpart `accept` already exists. Is `resolve` redundant with `accept`, or is the right model `accept` (I'll take it) → work → counterpart-`resolve` (I confirm it's done)? Reconcile with `planning-and-insights-brainstorm.md` point 5 (terminal-done-marker) — these may be the same question.
4. **Evidence in the close, not just assertion.** Dependent_Policy1307's point: a verifier should check *evidence the loop can produce* — "command output, trace IDs, changed files, cost/latency, a clear stop reason." A `resolve` could carry `meta` pointing at the artifact/trace it claims (named artifact already a `handoff` norm; `meta.otel` trace-link already leans this way). Not enforcement — provenance, so a human verifier has something to check against.
5. **Surveillance asymmetry (carry-over caution).** Whatever "unverified close" signal exists, applying it to *human* closes reads as monitoring, to *agent* closes reads as ops (`planning-and-insights-brainstorm.md` point 4). v0.3 need-to-know visibility governs who sees it.

## What's already decided (don't re-litigate)

- musterd does **not** run verifiers (tests/compilers/judges) — that's batond (`observability.md` §3).
- Threads must not be able to wedge (ADR 007 single-operator ergonomics).
- The act log is the source of truth; any "verified" status is **derived** from acts (a counterpart `accept`/`resolve`), never a stored second flag (`human-agent-dynamics.md` maxim; `planning-and-insights-brainstorm.md` point 3).

## Provenance

Surfaced 2026-06-30 while reviewing the "verifier, not the model" r/AI_Agents post (Cleo seat, team ritual) for musterd relevance. Sibling captures from the same review: `landscape.md` §4 (verifier-first corroboration) + §7 (command-center comparator) + §6 (write-action governance), and the cost-per-successful-outcome metric note in the batond flywheel memory. This doc is the one item that was a genuine *open question* rather than a positioning edit.
