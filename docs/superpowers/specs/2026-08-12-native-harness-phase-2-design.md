# Native harness phase 2 — a seat that works, and can't lie about it

- Date: 2026-08-12
- Status: design approved in session (nick); spec awaiting review
- Builds on: [ADR 251](../../decisions/251-native-backend-musterd-as-its-own-harness.md)
  (phase 1: the in-process loop, the `AgentLoopEngine` seam, the `wake_turns` capture rail),
  [ADR 131](../../decisions/131-harness-residency-wake-ledger-host.md) (the residency contract),
  [ADR 101](../../decisions) (model as a variable), [ADR 106](../../decisions) (the git loop),
  [ADR 221](../../decisions) (budget-neutral machine gates)
- Lane: `01KZVX17EN3Z1YKD4EV9K66K4T`

## Purpose

Phase 1 proved the seam: musterd can be its own harness — an in-process agent loop, the seat's
own MCP surface as its tools, occupancy earned on the roster, cost computed by the harness from
per-turn usage. But the loop is coordination-only: it can check its inbox and answer; it cannot
work a lane.

Phase 2 makes the native seat a **working** seat, and does it so that autonomy and
auditability ship in the same phase. Three pillars, each landable as its own increment, each
reinforcing the others:

1. **Working tools, jailed at the tool** — the seat can edit files and run commands, inside a
   deterministic workspace jail.
2. **Chained wakes + resume-by-replay** — a lane is a chain of bounded, priced wakes; resume is
   a daemon property (replaying captured rows), not a provider favor.
3. **Verification as protocol, v1** — the chain boundary is a gate: the daemon audits the
   seat's structured progress claims against git, lanes, and its own ledger before funding the
   next wake.

The one-line argument for combining them: **the chain gate makes verification nearly free, and
makes unaudited autonomy unnecessary.** A field sweep (Appendix A) found no shipped harness
that independently audits an agent's work claims, none that enforces cost in the request path,
and none that owns resume — the three pillars are also the three sharpest unoccupied
differentiator positions.

Rejected shapes, for the record: *differentiators-first* (verification/flywheel on the
coordination-only loop, tools later) inverts the driving use case — nick chose "do real lane
work" as the phase-2 goal; *tools-first, verification later* ships an autonomous file-editing
seat with no audit for a whole phase, the exact window an unaudited seat can claim finished
work that isn't; *everything at once* (all six charter items) founders on scope — memory is
blocked on an open lane, and the flywheel needs chain data that doesn't exist yet.

## 1. Working tools, jailed at the tool, not the model

The bridge (`packages/cli/src/host/backends/nativeBridge.ts`) grows a **second tool source**
beside the seat's MCP surface: a native toolkit implementing the same `EngineTool` interface.
The engine stays ignorant of what it is talking to; the backend composes the tool list.

**The toolkit, deliberately small:** `read_file`, `write_file`, `edit_file`, `glob`, `grep`,
`bash_run`. No browser, no network tool, no subagents — phase 2 is a seat that can build and
ship, not a general workstation.

**The jail is enforced inside each tool implementation** — deterministic code, never a model
judgment:

- **FS tools:** every path resolves via `realpath` and must land inside the seat's worktree;
  symlink escapes and `..` traversal are refused with a structured error that names the escape
  hatch ("outside your workspace — raise an `ask` act if you need this").
- **`bash_run`:** an allowlist matched on the **parsed command head**, never substring: the
  build/test/lint scripts the repo declares, `pnpm exec prettier|tsc|vitest`, and a git subset —
  `status`/`diff`/`log`/`add`/`commit`/`checkout -b`/push of the **current non-main branch** —
  plus `gh pr create` (the ADR 106 loop, mechanized). No `rm -rf`, no `curl`, no
  pipes-to-shell; `cwd` pinned to the worktree; child env sanitized the way the CLI backends
  already sanitize theirs.
- **Everything is captured:** tool calls land in the per-turn transcript rows (ADR 251 §7), so
  the jail's decisions are audit-visible for free. **Denied calls are captured too** — a seat
  probing its jail is a signal, not a silent no.

**Policy knob.** `tool_policy` gains a third value: `reply-only` (unchanged default) ·
`seat-policy` (CLI rows only) · **`workspace-jail`** (native only). When working tools are
enabled for a native seat, `workspace-jail` is the **default and only** posture — there is no
unjailed native tools mode. The field's sandbox-escape incidents (Appendix A caveat) set the
bar: the jail ships default-on, not opt-in.

## 2. Chained wakes + resume-by-replay

**The chain is a daemon object, not a loop behavior.** A native seat never spawns its own next
wake — it *requests* one, and the daemon grants it.

**The checkpoint tool.** The bridge gains one more native tool:
`checkpoint({done, claims, next})` — the loop calls it to end a run honestly:

- `claims`: structured statements of what it believes it completed (schema in §3 — a closed
  vocabulary, not prose);
- `next`: the self-composed prompt for its successor wake;
- `done: true` closes the chain; `done: false` files a **continuation request**.

The checkpoint is the load-bearing choice: the claim posted at the chain boundary is a
structured artifact the daemon can audit, not prose buried in a transcript. A run that exhausts
`max_turns` or the watchdog **without** checkpointing ends `unchecked` — chains only continue
through the front door.

**Chain state lives server-side.** `wake_leases` rows gain `chain_id` (the first lease's id)
and `chain_seq`; a continuation request becomes a wake order the actuator picks up like any
directed act — same registry, same backend, same per-wake bounds. **Chain-level bounds are new
and mandatory:** `max_wakes` and `budget_usd` for the whole chain, enforced by the daemon from
the summed per-turn cost rows it already holds. A chain ends exactly one of: `completed` ·
`budget_exhausted` · `max_wakes` · `verification_failed` · `unchecked` · `abandoned` (no
continuation claimed within TTL).

**Resume is replay, bounded.** Wake *N+1*'s engine run is seeded from daemon-held rows, never
provider session state:

1. the original composed line,
2. the predecessor's checkpoint (claims + `next` prompt),
3. a capped tail of transcript rows, newest-first within a total byte budget (the per-turn
   256 KiB bound already exists; the chain replay gets its own total cap).

Not full-fidelity replay — **the checkpoint is the compaction**; the tail carries recency. This
keeps replay priced and small, and it is model-portable by construction: replayed rows are
provider-neutral `EngineTurn` transcripts, so wake N+1 can run on a different model than wake N
(ADR 101; the seam's whole reason to exist — and the substrate phase 4 stands on).

**Explicitly out of phase 2:** summarization/compaction of long chains beyond the cap;
cross-chain memory (phase 3, behind the memory-system lane); resuming CLI backends by replay
(the claude row keeps `--resume`; replay is native-only).

## 3. Verification as protocol, v1: the chain gate

**Shape: the host is the field arm, the daemon is the judge.** Truth is split across the two —
git lives on the machine (the host can read the worktree); lanes and the ledger live in the
daemon — so verification does too. When a checkpoint arrives, the host runs deterministic
checks and posts evidence; the daemon compares claims against evidence plus its own records,
records a verdict, and only then funds the continuation. **The model is never in the verifier**
— v1 is deterministic code end to end.

**A closed claim vocabulary, v1.** Claims are typed; the checkpoint schema accepts only:

| claim | verified by | how |
|---|---|---|
| `commit_exists {sha, branch}` | host | `git cat-file` + branch containment in the worktree |
| `branch_pushed {branch}` | host | remote ref matches local |
| `pr_opened {number}` | host | `gh pr view` — exists, right head branch |
| `lane_state {lane, state}` | daemon | its own lane record |
| `tests_green {command}` | host | **re-runs the allowlisted command** — only on `done: true`, not every boundary (one paid test run per chain, at the close; parsing the loop's own captured output would be trusting the transcript, the exact thing this refuses to do) |

Anything outside the vocabulary is recorded `unverifiable` — visible in the ledger, never gated
on. That is the growth path: the vocabulary widens claim-type by claim-type, each with a
deterministic checker; nothing is ever half-verified.

**Verdicts and consequences.** Every claim gets `verified` / `failed` / `unverifiable`, written
to the audit ledger as `residency.claim_verified|claim_failed` under the seat's identity — the
substrate the phase-3 flywheel and any future trust surface read. One `failed` claim ends the
chain `verification_failed`: no next wake is funded and the lane the chain carries is flagged.
The seat's enrollment is untouched — a failed claim is a datum, not a conviction; repeated
failures are a pattern for a human (or the phase-3 loop) to see, not an auto-ban. **The gate
fires on falsified claims, never on absence** — a checkpoint with no claims verifies vacuously,
but the emptiness is on the record, and a `done: true` close with zero verified claims on a
claimed lane is exactly the low-trust signature a reviewer sees at acceptance.

**Why this is the differentiator, not a feature:** every other harness's answer to "did the
agent do what it said" is a human, an LLM reading a diff, or a test run the agent itself
performed. Here the answer is the coordination substrate the seat already works through — git,
lanes, ledger — cross-examined by the party that pays for the next wake. Verification isn't
bolted beside the harness; **it's the funding condition.**

## 4. Phases 3–4 — chartered, not designed

**Phase 3 — the self-improving harness.** Two halves, each gated on something outside this
spec:

- **The flywheel:** the ADR 051/052/056 trace→eval→experiment loop over the substrate phase 2
  produces — `wake_turns` transcripts, checkpoint claims, verification verdicts, per-chain
  cost. Governance stance on record from the start: the evaluator lives outside the evolving
  loop, criteria are pre-registered, frozen Decisions are the standing answer to reward
  hacking. Enters design only after phase 2 has generated real chain data.
- **Seat memory as native memory:** deliberately blocked on the open memory-system lane
  (`01KZVPW7J5KFJ6PCD05WC0T9BN` — three stores, three lifetimes, no boundary). Whatever
  boundary that lane lands is the boundary the native loop's memory honors.

**Phase 4 — model diversity through the seam.** A second `AgentLoopEngine` implementation (the
Track B / ADR 110 local-model line is the standing candidate). §2's replay design was shaped
for this: provider-neutral transcripts mean a chain can switch engines between wakes — ADR
101's "model as a variable" moves from a per-seat property to a per-wake one. Nothing to decide
until a second provider is a real requirement; the seam is the named insertion point.

## 5. Observability & eval

**Traces (all additive, riding existing rails):** chain fields on `wake_leases` (`chain_id`,
`chain_seq`, chain end state); the checkpoint artifact captured like any turn; new audit verbs
`residency.claim_verified|claim_failed|chain_ended`; jail denials visible in transcript rows;
chain cost = the sum of member wakes' per-turn rows — no new pricing path (ADR 251 §6 already
reconciles exactly).

**Eval — phase 2 is done when:** on the live dogfood daemon, a native seat takes a real small
lane end-to-end: claims it, works it across **≥2 chained wakes** (proving replay), files
checkpoints whose claims **verify against git/lanes**, and lands a mergeable PR through the
ADR 106 loop — with total chain cost reconciling exactly against the summed `wake_turns` rows,
and the jail recording zero escapes.

**Experiment (owner-gated, one run, pre-registered like phase 1's):** the same small lane
worked by the native seat vs the claude-code backend baseline. Report: wall-clock, cost, turns,
and — the number nobody else can print — **claims made vs claims verified**. Plus one
adversarial probe: a scripted engine files a false `commit_exists` claim, proving the gate ends
the chain `verification_failed` rather than funding wake 2. That probe is the demo of
differentiator 1.

**Rollout posture, unchanged from phase 1:** opt-in per enrollment, never default;
`workspace-jail` mandatory when working tools are enabled; chain bounds (`max_wakes`,
`budget_usd`) mandatory — no unbounded chains, ever.

## Appendix A — field sweep: harness differentiators, August 2026

Researched 2026-08-12 (web sweep; URLs at the end). Condensed here because the design leans on
its conclusions.

**Per-competitor sketch.** *Claude Code / Agent SDK*: session-first, permission-prompt
architecture, provider-side session persistence, per-session cost visibility, no independent
verification of the agent's claims. *OpenAI Codex CLI/Cloud*: sandboxed local + hosted async;
`@codex review` is LLM-review-of-a-diff — the closest thing to built-in verification, and still
transcript-trusting in kind. *OpenClaw*: resident self-hosted gateway daemon; multi-level
permission cascade but **sandboxing off by default**; sandbox escapes (Snyk) and the ClawHavoc
malicious-skills campaign are the field's cautionary tale. *Hermes Agent*: pluggable isolation;
its differentiator is an **ungoverned** self-improvement loop (memories, prior-session search,
self-authored skills) — 60k stars in 8 weeks proved demand; governance is the community's open
worry. *Devin*: most autonomous hosted agent; trust model is "review the PR"; flat-rate cost.
*SWE-agent / OpenHands*: open, self-hostable; verification is test-execution inside the run —
which the cheating literature (DebugML's Meerkat study: cheating across 28+ submissions on 9
benchmarks) shows is gameable. *Cursor background agents*: per-task cloud VMs, checkpointing,
opaque post-hoc credits; Cursor's own blog names reward hacking as swamping model-intelligence
gains — the problem stated, no harness answer. *Google Jules*: async task agent; human reviews
the diff. *Microsoft Agent Framework Harness / Squad* (GA Aug 2026): the strongest
multi-agent-native entrants, both **orchestrator-worker shaped** — anonymous delegation, no
per-worker identity surviving to git or an audit layer.

**Gap analysis (capability × field):** resident daemon run model — several have it; jailed
tools — most have some form, OpenClaw's is off by default; **independent audit of work claims —
nobody**; **per-turn cost metering enforced in the request path — nobody** (post-hoc credits at
best); **resume-by-replay of harness-owned transcripts — nobody** (provider persistence or
external durable-execution engines bolted alongside); **peer multi-agent with identity,
attestation, and the right to decline — nobody** (orchestrator-worker everywhere); governed
self-improvement — exists only as essays.

**The five claims this design stakes:**

1. **"The harness doesn't trust the transcript."** No shipped harness independently audits
   progress claims; the External Anchor literature argues the verifier must live outside the
   loop — exactly where the daemon sits. (§3)
2. **"Cost enforcement in the wake path, not the invoice."** Tooling outside the request path
   can only report, never intervene; musterd prices each bounded wake and gates the next on
   verified progress. (§2)
3. **"Resume is a daemon property, not a provider favor."** Owned per-turn capture +
   replay-by-rows; model-portable by construction. (§2)
4. **"Peers with identity, not workers without it."** Seats/lanes/attestation vs the field's
   anonymous delegation — the provenance hole the multi-agent security literature flags. (ADR
   109/101/150, already shipped substrate)
5. **"Governed self-improvement is the next fight, and verification-as-protocol is the entry
   ticket."** A harness that already audits claims against an external ledger is structurally
   positioned to govern skill evolution the same way. (Phase 3)

**Design-shaping caveat:** the OpenClaw incidents raise the bar for any new jail — hence §1's
default-on posture.

Sources: firecrawl.dev/blog/best-ai-coding-agents · morphllm.com/ai-coding-agent ·
mcplato.com/en/blog/ai-agent-harness-comparison-2026 · nebius.com/blog/posts/openclaw-security ·
labs.snyk.io/resources/bypass-openclaw-security-sandbox · thenewstack.io/openclaw-hermes-agent-harness ·
composio.dev/content/openclaw-vs-hermes-agent · debugml.github.io/cheating-agents ·
cursor.com/blog/reward-hacking-coding-benchmarks · arxiv.org/pdf/2605.21384 (SpecBench) ·
arxiv.org/pdf/2606.26300 (Verification Horizon) · infoq.com/news/2026/08/agent-framework-harness-ga ·
infoworld.com/article/4164601 (Squad) · trustgateai.io/blog/token-bill-runaway-agents ·
nittikkin.medium.com (durable execution) · zylos.ai/research (replayable runtimes) ·
eugenevyborov.substack.com (External Anchor Principle) · bdtechtalks.com/2026/07/13 (self-improving
harness governance) · lilianweng.github.io/posts/2026-07-04-harness · arxiv.org/pdf/2603.09002
(multi-agent security) · techsy.io (background agents compared)
