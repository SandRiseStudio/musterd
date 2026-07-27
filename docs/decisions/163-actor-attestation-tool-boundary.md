# 163 — Actor attestation at the tool boundary: attributing subagent writes

- Status: **draft** — 2026-07-26. Authored by stanley (lane `01KYB0N38K9CWTB6YS2D0FGQGS`, opened by
  izzo 2026-07-24). Number **163 pinned** — verified free on `origin/main` (highest is 162), 2026-07-26.
- Date: 2026-07-26
- Builds on: [ADR 150](150-structural-inducement-pretooluse-gates.md) (the PreToolUse gate whose
  payload parsing this extends, and whose declared-class boundary this ADR amends — see §Boundary),
  [ADR 088](088-interrupt-line-tool-boundary-inbox-check.md) (the hook actuator both reuse),
  [ADR 109](109-seat-git-attribution.md) (seat identity, and the attribution path this ADR
  complements rather than replaces), [ADR 101](101-model-as-a-variable.md) /
  [ADR 158](158-model-attestation-truth.md) (harness-attested model — the invariant a subagent
  `model:` override defeats), [ADR 083](083-lanes-phase1-intent-dependency.md) (warn-never-block, preserved
  absolutely here: this mechanism cannot block anything).

## Context

`~/.claude/CLAUDE.md` carries a standing machine-wide rule, written 2026-07-24: **subagents may read,
seats must write.** Its stated justification is that a writing subagent has no seat, no lane, and no
model attestation, so it writes under its parent seat's identity and breaks three musterd invariants
at once — ADR 150 lane ownership (the gate fires on the parent's seat), ADR 109 git attribution (the
commit carries the parent's name), and ADR 101/158 model attestation (the work is recorded at the
parent's model, corrupting the ADR 056 diversity conclusions at their source).

That rule is **guidance only**. Nothing enforces it, and finding 006 measured guidance-only
compliance at **0/8 versus 8/8 under enforcement** — so the honest description of the current state
is _unenforced and unmeasured_. We do not know how often the rule is broken, because a broken rule
leaves no trace distinguishable from ordinary seat work.

### Two holes, not one

The lane that produced this ADR conflated two distinct failures. They need different answers, and
only the second is in scope here:

1. **No seat at all** — an unbound folder. `packages/cli/src/commands/gate.ts:131` returns allow:
   `if (!explicit || !identity) return 0;`. This is **deliberate** — an unbound folder must not be
   gated — and it stays. Accountability is _absent_ by design.
2. **A borrowed seat** — a subagent running inside a _bound_ seat worktree. The gate sees a
   perfectly valid seat (the parent's) and allows correctly by its own rules. Accountability here is
   **wrong, not absent** — and this is what the CLAUDE.md rule is actually about.

This ADR addresses **(2) only**. The title says "subagent writes", not "seatless writes", for that
reason.

### What the harness actually exposes (measured, not assumed)

The lane recorded an open question — "can a PreToolUse gate even see that it is inside a subagent?"
— and both it and the handoff notes guessed _probably not_, on the reasoning that a subagent and its
parent are the same process under the same binding. **That guess was wrong.** Measured 2026-07-26
against Claude Code **2.1.220** with a payload-logging PreToolUse hook and a headless run spawning a
read-only `Explore` subagent:

| payload field      | parent's own call | subagent's own call |
| ------------------ | ----------------- | ------------------- |
| `session_id`       | `c41bccdc…`       | **identical**       |
| `transcript_path`  | parent `.jsonl`   | **identical**       |
| `cwd`, `prompt_id` | —                 | **identical**       |
| `permission_mode`  | —                 | **identical**       |
| **`agent_id`**     | _absent_          | `aeebe25c889a51a45` |
| **`agent_type`**   | _absent_          | `Explore`           |

The process-identity fields are useless — they are the same by construction. But `agent_id` is a
clean one-field discriminator that the harness already hands the hook, and which
`parseToolCall` currently discards.

A second probe settled the model question. Spawning with an explicit `model: "haiku"` override:

- the **spawn** call (`tool_name: Agent`) carries `tool_input.model = "haiku"` — but **no** `agent_id`;
- the **subagent's own** calls carry `agent_id` + `agent_type` — but **no** model field.

Both halves of the ADR 101/158 concern are visible. **Nothing joins them.** That constraint shapes
the decision below and is not papered over.

## Problem

Make a subagent's writes **attributable** — so that the CLAUDE.md rule becomes measurable, and the
three invariants it protects can be checked rather than assumed — without:

- blocking anything (ADR 083; and a denial inside a subagent is uniquely dangerous — see
  §Consequences on ADR 153 stranding);
- taxing read-only fan-out, which nick's rule explicitly blesses and which dominates subagent tool
  volume;
- turning musterd into generic tool mediation (the ADR 150 §Gate B boundary constraint).

## Decision

**Record the actor; never adjudicate it.** A third behavior at the ADR 088 hook seam that emits audit
rows and nothing else. It is deliberately **not a third gate**: a gate answers _may this proceed_,
this answers only _who did it_. It has no posture, no policy class, no deny path, and no ask
emission.

### Boundary — why this may fire on undeclared calls

ADR 150 §Gate B states a load-bearing constraint:

> a call matching **no declared class passes through untouched**, always. If a design change would
> make this gate fire on an undeclared call, it is out of scope by construction.

This ADR **amends** that constraint, narrowly and explicitly. The guard exists to prevent musterd
becoming a second permission-prompt system — creep from "declared costly actions" toward "all tool
calls". **A mechanism that cannot change whether a call proceeds cannot become a permission-prompt
system.** The amended rule reads: _no call may be **mediated** without matching a declared class;
attribution-only observation is exempt, and is exempt precisely because it is outcome-free._

Attribution has to be exempt to be worth anything. A subagent-write ledger restricted to declared
surfaces could answer "was the rule followed on `tariff.ts`" but never "is the rule followed" — and
the second question is the one the CLAUDE.md rule needs answered.

### Mechanism

Three changes, all client-side except the ingest:

1. **Stop discarding the payload envelope.** `parseToolCall` (`packages/cli/src/commands/gate.ts`)
   extracts `agent_id` and `agent_type` alongside `tool_name`/`tool_input`; `GateToolCall`
   (`packages/protocol/src/enforcement.ts`) gains optional `actorId` / `actorType`. On a spawn call
   (`tool_name: Agent`) it additionally reads `tool_input.subagent_type` and `tool_input.model`.
2. **Write-shaped call carrying `agent_id` → one `actor.subagent_write` row**: acting seat, `agent_id`,
   `agent_type`, tool name, target. Write-shaped means the existing set — `Edit`/`Write`/`MultiEdit`/
   `NotebookEdit`, plus `Bash` matched write-shaped. **Reads never fire**, so an `Explore` sweep's
   hundreds of reads cost nothing, per nick's read/write asymmetry.
3. **Spawn call → one `actor.subagent_spawn` row**: declared `subagent_type` and the `model` override
   if present. Fires regardless of whether the subagent goes on to write — the spawn is the only
   place the model is ever visible.

Rows post through the same member-authed daemon ingest the `lane.gate` / `action.gate` rows use, and
carry **shapes only** (ADR 051) — never file content, never the subagent's prompt.

**Emission is fire-and-forget, off the critical path.** Unlike `gateCheck`, attribution has no
decision to await — nothing downstream reads its result, and the tool call's outcome does not depend
on it. The row is therefore emitted **without awaiting the response**, under a hard timeout, and its
failure is **unobservable to the tool call**. An implementer must not `await` the POST into the hot
path: that would convert an observer into a latency tax on every subagent write, which is the guard
metric below.

**Nested subagents are out of scope, not solved.** `agent_id` presence cleanly separates sidechain
from parent, which is all this ADR relies on. Whether a subagent spawning a subagent yields a
distinct `agent_id` per level or collapses depth is **untested** — nothing here should be read as
claiming one-level ancestry is recoverable.

### Increments

**Increment 1 (this ADR's commitment): `actor.subagent_write`.** The write ledger alone answers the
question the CLAUDE.md rule needs answered, and is worth landing on its own.

**Increment 2 (conditional): `actor.subagent_spawn` + the model join.** The spawn row earns its place
immediately as a **denominator** — how much fan-out happens at all, writing or not — so it ships with
increment 1. The **join** does not: it only has anything to join for subagents that write, i.e.
exactly the population the rule says should not exist. If increment 1 reports near zero, the join has
no subject; if it reports a lot, we have a worse problem than model attribution. So the join,
`model_attribution`, and its experiment arm are **gated on increment 1's number** rather than built
speculatively.

### The model join, and its stated limits (increment 2)

The daemon would reconstruct "which model wrote this" by joining `actor.subagent_spawn` →
`actor.subagent_write` on `(session, agent_type)` in spawn order. This is **best-effort and
ambiguous when two subagents of the same type run concurrently under different model overrides.**

That ambiguity is recorded on the row, not hidden: a joined attribution carries
`model_attribution: 'joined' | 'ambiguous' | 'unknown'`, and any consumer of ADR 056 diversity data
**must** treat `ambiguous` as unattributed rather than guessing. A silently-wrong model attribution
corrupts the diversity conclusions exactly as badly as a missing one — worse, because it looks
trustworthy. We do not claim recovered attestation we do not have.

### Fail-open, unchanged

Every ADR 150 failure posture carries over verbatim: missing input, unbound folder, unreachable
daemon, or any unexpected error exits 0. Attribution is strictly less critical than gating — if it
cannot record, it must still not wedge the tool call.

## Observability & Evaluation

**Traces** — two new audit rows at the existing ADR 088 hook seam, no new instrument and no daemon
scheduler: `actor.subagent_write` (seat, `agent_id`, `agent_type`, tool, target; plus
`model_attribution` in increment 2) and `actor.subagent_spawn` (declared `subagent_type`, `model`
override). They sit beside the
`lane.gate` / `action.gate` rows and join to ADR 109 git attribution through the acting seat, so
"which commits contain subagent-authored writes" becomes one query rather than an unanswerable
question.

**Eval** — headline: **subagent-write count**, the number of write-shaped tool calls on the dogfood
team carrying an `agent_id`. **This is a lower bound, not a rate** — see the recall problem below;
report it as "at least N" and never as a compliance percentage. **Dataset:** the dogfood team's own
audit stream from the first full week after landing. **Baseline: 0 — not because the count is zero,
but because it is currently unmeasurable**; the baseline must be reported as "unknown" rather than
"none". Secondary: **detector recall** (arm 2 below) — without it the headline cannot be interpreted
in either direction. Guard metric (must **not** move): **added latency per write-shaped call** (the
fire-and-forget emission above is how this is protected), and zero increase in gate-caused tool
failures — an attribution path that wedges a write is a regression outright.

**The recall problem, stated up front.** Write-shape for `Bash` is a **heuristic match on the command
string**, and ADR 153 / PR #349 already measured how much such matching misses — `git -C ../main
merge` slipped a `git merge*` class until `normalizeCommand` was added. A subagent that writes via
`python -c`, a heredoc, `tee`, `sed -i`, or an MCP filesystem tool produces **no `actor.subagent_write`
row at all**. So a null result is ambiguous between "the rule holds" and "the instrument is blind" —
the same failure mode flagged in §Consequences for the `agent_id` field disappearing.

**Experiment** — pre-registered, three arms, all cheap because the apparatus already exists.
(1) **Compliance arm:** run the dogfood team a week with attribution on and count
`actor.subagent_write` rows. **What this arm can and cannot establish:** a non-zero count
**confirms** the rule is being broken and how often, at minimum. A near-zero count **does not
establish compliance** and explicitly **does not retire the case for a blocking gate** — it is
consistent with a blind detector, and may only be read alongside arm (2). (2) **Recall arm (runs
first, gates the interpretation of arm 1):** deliberately have a subagent write through 3–4
non-obvious paths — `python -c`, a heredoc, `tee`, an MCP filesystem tool — and count how many
produce rows. This converts the floor into a number with a known error bar, and is the difference
between an instrument and a guess. (3) **Join-fidelity arm (increment 2 only, gated on arm 1):**
spawn two same-type subagents concurrently under different models and confirm the join reports
`ambiguous` rather than picking one — a test that the honesty mechanism fires, not that the join
succeeds. Honesty caveat inherited from ADR 150: **n is small; report the mechanism beside every
count**, never a headline number alone.

## Consequences

- **Makes a guidance rule measurable before anyone enforces it.** The sequence finding 006 argues for
  is measure → then enforce if needed. This ADR supplies the measurement and deliberately declines
  the enforcement.
- **Does not close the unbound-folder hole.** `gate.ts:131` still fails open with no seat, by design.
  Anyone reading this ADR as "seatless writes are now handled" has misread it.
- **Deliberately declines to block, and ADR 153 is why.** A denied write inside a subagent is the
  worst stranding case in the system: the subagent cannot raise an ask, cannot reach a human, and its
  parent sees only a failed tool call with no repair path. `ask.stranded` has no route out of a
  sidechain. Blocking here would strand work invisibly — the exact regression ADR 150's guard metric
  forbids.
- **Harness-coupled, and only one harness is verified.** `agent_id` is a Claude Code payload field
  measured on 2.1.220; it is not a stable public contract, and the Codex/Cursor adapters (ADR 038)
  expose no equivalent today. Fail-open means other harnesses silently degrade to current behavior —
  correct, but it means the ledger covers Claude Code seats only, and any cross-harness claim from
  this data is invalid. If the field disappears in a future version the ledger goes quiet rather than
  wrong; the guard against _that_ is the subagent-write rate itself, which dropping abruptly to zero
  should be read as instrumentation failure before it is read as compliance.
- **Costs one POST per subagent write.** Reads and parent-seat calls are untouched, so the hot path
  is unchanged for the overwhelming majority of tool calls.
- **Risk — attribution mistaken for control.** Recording that a subagent wrote does not stop it. The
  docs must not let a ledger read as a guardrail; the CLAUDE.md rule remains the only thing asking
  anyone not to do this.

## Related

Lane `01KYB0N38K9CWTB6YS2D0FGQGS` (opened by izzo, 2026-07-24). Gate this extends:
[ADR 150](150-structural-inducement-pretooluse-gates.md). Guidance-vs-enforcement evidence:
finding 006, [`docs/design/cookoff-cell-runbook.md`](../design/cookoff-cell-runbook.md). Stranding
contract: [ADR 153](153-ask-reachability-gated-hold.md). The positioning argument this defends —
intra-task orchestration by anonymous actors — lives in the multi-agent-trap memo under `docs/design/`.
