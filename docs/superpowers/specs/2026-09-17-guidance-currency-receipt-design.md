# Guidance currency — the refresher leaves a receipt, and a seat reads it for free

**Date:** 2026-09-17
**Status:** proposed
**Lane:** `01M2NTZ9WVS525MDRH8PJRPPM5` (izzo, stakes: high; opened by sloane, carved out of `01M2NRA59J`)
**Scope:** design only; implementation follows an approved plan. Increment 1 is CLI-local and carries
an ADR (it changes what the SessionStart line *means*). Increment 2 is a protocol change — one
optional field on the claim handshake and the heartbeat frame — and carries its own ADR under
`change-adr:check`. Increment 3 is deferred and deliberately unscheduled.

## Outcome

A seat can tell, at the moment it starts acting, whether the rules it is about to follow are the
rules that are on `main` — and if they are not, it is told which rule it is missing and why the
machine has not caught up. Acts carry the guidance epoch the seat was running, so "who closed a lane
on a superseded rule" is a query rather than a forensic script.

## Why

ADR 408 workspace self-heal landed 2026-09-16 and works. It fired at this session's start
(`musterd: repaired 1 guidance file`) and it repairs *before* the skill is read. The census that
opened this lane has already improved because of it:

| 2026-09-16 (lane as filed) | 2026-09-17 (re-run for this spec) |
| --- | --- |
| 7 of 9 seat worktrees stale | 4 of 9 stale (big-body, dolly, ghost, kimi — all at v23 vs v24) |

Nine worktrees carry guidance: five at v24 (izzo, miley, ryder, sloane, stanley), four at v23. The
four stale ones are stale only because no session has started in them; each would repair on entry.
Six further worktrees (compo, gptbot, grokbot, live, schmidt, wanderer) carry no guidance at all and
are not seat workspaces. Drift detection is content-hashed, not version-compared, so a
guidance change that forgets to bump `GUIDANCE_CONTENT_VERSION` still registers as drift.

So the lane's filed cause — advisory refresh, deferred nudge — is substantially addressed. What
remains is one layer down, and it is not addressed at all.

### Observed live while this spec was being written, 2026-09-17 ~16:0x

stanley's #1545 (`556ee598`, "The channel rule blamed the channel for a working-directory fact")
bumped guidance v24 → v25. Census taken ~20 minutes later, from the seat that had just written the
paragraph above:

| epoch | seats |
| --- | --- |
| v25 (current) | izzo — and only because it ran `--refresh-guidance` by hand |
| v24 | big-body, dolly, miley, ryder, sloane, stanley |
| v23 | ghost, kimi |

**One of nine current, twenty minutes after the rule landed** — and stanley, who *authored* v25, was
themselves running v24 in their own worktree.

Note carefully which defect this is, because it is not the one this spec's Section 1 addresses. The
daemon checkout had already caught up (dist at v25 by 15:45), so the build was fine. The seats were
stale because **self-heal fires once, at session start**, and a session that stays up outlives the
rule it started under. That is defect 2 from `2026-09-16-workspace-self-heal-design.md` ("It fires
once"), which that spec named and did not fix.

This is recorded here rather than folded into the argument for the receipt, because the receipt does
not fix it either: a seat that never re-reads the receipt mid-session learns nothing new. What the
receipt makes possible is that *something could* re-read it — the file is cheap enough to check at a
task boundary, where `composeLine`'s once-per-session budget never was. Whether to spend a
task-boundary check is a question for the plan, not a claim this design has already answered.

### The defect

`selfHealWorkspace` repairs a seat to match **the local build**. `inspectClaudeHookDrift` states the
rule in its own comment: compare "against what THIS build would write." The global `musterd` is a
pnpm link to `/Users/nick/agents/packages/cli`, so every seat's guidance authority is the daemon
checkout's dist. **Nothing ties that dist to `origin/main`, and `composeLine` never names the build
it repaired from** — `WorkspaceRepairBody.build` is recorded in the report body and dropped from the
line. A seat repaired from a six-day-old dist prints `repaired 1 guidance file` and runs a six-day-old
rule, green.

The codebase already names this defect in prose. `runtime.ts:59`:

> the doctor's guidance check is SELF-REFERENTIAL: `inspectGuidance` compares each file's stamp
> against `GUIDANCE_CONTENT_VERSION`, the constant compiled into the CLI doing the comparing. A
> binary that writes v21 therefore pronounces v21 files current — correctly, and uselessly, if v22
> is on main.

Measured on the cloud seat `/data/musterd-delta`, 2026-09-06. But the mitigation is a warn-only note
gated behind `isPackagedCliInstall`, and every seat on this laptop is a source checkout, so none of
them receive it.

### Why this stayed invisible

`composeLine` has a `behind` state — "a hook here was written by a NEWER musterd — this checkout is
behind" — which would have caught a stale repair. It cannot fire here. On this laptop every seat is
repaired by the same linked global dist, so when that dist is stale **all seats are stale together
and consistently**, and `checkoutBehindHooks` compares each seat against the very build that made it
stale. A guard that detects disagreement is blind to uniform error. That near-miss is the reason the
defect survived ADR 408 review, and it belongs in the ADR's Context.

### The answer exists and is computed where nobody is looking

`buildSkewNotes` (`doctor.ts:1170`) already performs both comparisons — this CLI's dist stamp vs the
daemon's `/health.build`, and vs `origin/main` with behind-counts. It is careful work: it strips
`-dirty`, stays silent when either side is unknown, says "differs" not "behind" for the daemon.

It runs only in the full doctor. The session-start path runs `inspectArtifactDrift`, whose comment
states the constraint deliberately:

> The cheap half of the doctor, and cheap is the whole design constraint — this runs at every session
> start. It is pure file I/O: no network, no git.

That exclusion is correct and this design does not overturn it. The problem is not that the check is
missing; it is that **the currency answer is computed off the hot path, and the hot path is where
acts get decided.**

### The precedent that makes it urgent

Auto-refresh refuses to advance when the daemon checkout is dirty, and it says so only in its log
(ghost's lane `01M2REEQC36M0KWPMTMGNZR6N0`). Throughout such a refusal, every seat's self-heal
reports `repaired`.

**Corrected count, and the correction matters more than the number.** This spec first cited "86
refusals across six days", inherited from that lane. Both figures are wrong, and stanley found the
cause (insight `01M2RRRVDVFZ`): `grep -c "uncommitted changes"` counts 86, but 34 of those lines are
the *notification* lines, which quote the refusal text back into the log. Re-derived here
independently: **52 real refusals**, of which 41 carry a resolvable timestamp — the log's first
~10,300 lines predate timestamping. Those 41 span **2026-08-05 to 2026-09-17 (42 days)**, in
episodes grouped by a >1h gap:

| episode | refusals | duration |
| --- | --- | --- |
| 2026-08-19 15:31 | 16 | 3h11m (longest *cluster*) |
| 2026-08-27 12:18 | 5 | 1h28m |
| 2026-09-17 11:46 | 2 | 49m |
| 2026-08-05 17:54 | 7 | 27m |
| 2026-09-01 14:09 | 2 | 20m |
| 5 further | 1 each | instantaneous |

**No daemon was ever pinned for six days by a dirty checkout.** Every episode resolved the same day.

The table above measures *alarm clustering* — a >1h gap between refusal lines starts a new row — and
that is the only thing the clock can tell you. It is the wrong instrument for the word **outage**.
stanley groups on the `pinned <sha>` the refusal reports, with gaps under 6h, and on 2026-08-27 all
eight notices report the same unchanged `4e46d72` across **7h06m**: the build demonstrably did not
move, so that is one outage with quiet stretches, and my >1h rule splits it into three and
under-reports the worst case. On "longest outage" stanley's number is the better one and this spec
takes it — **7h06m**, still same-day. The rule belongs beside the number wherever either is quoted;
both, with their rules stated, are in `docs/wiki/when-the-daemon-stops-refreshing.md`.

This *weakens* the urgency argument and is recorded rather than quietly dropped. The design still
stands on the mechanism, not on the size of any past outage.

**Honest negative, recorded so nobody over-claims this design:** that outage did not in fact strand a
guidance change. `guidance.ts` changed twice in ten days — `8626ed88` (2026-09-14 13:30) and
`9116fa07` (2026-09-16 16:28) — and the daemon was pinned on `03baa24` (2026-09-16 21:08), which is
after both. The machine was at v24 the whole time. The pathway is real and unguarded; this
particular outage did not fire it.

## Approaches considered

- **A — the seat asks `origin/main` at session start.** Truest answer. Requires `git fetch` on the
  hot path, fails offline, and breaks the pure-file-I/O contract self-heal was built to honour.
- **B — the seat asks the daemon at session start.** One localhost `/health` call; reuses ADR 130's
  existing guard. Still network on a path contracted not to touch it, dead exactly when the daemon
  is down, and it inherits the silent-agreement hole: a stale daemon and a stale seat agree, and
  both are wrong.
- **C — the writer leaves the answer on disk; the seat reads it for free. Chosen.** The auto-refresh
  tick already fetches, already compares to `origin/main`, already rebuilds. It records what it saw.
  Session start reads a file: the latency contract is honoured exactly, and it works with the daemon
  down. Decisive advantage over B: **an absent or old record is itself the signal that the refresher
  has stopped**, so the writer's failure becomes detectable by the reader instead of the reader
  trusting a writer that silently died. That is `docs/wiki/the-instrument-discharges-the-act.md`
  applied one layer up.

**And it asks a better question than `buildSkewNotes` does.** That compares the CLI build to
`origin/main` in *commits behind*, which is a proxy that fails in both directions: a build 50 commits
behind may contain every guidance change, and a build 1 commit behind may be missing the only one
that matters. `main_guidance_epoch` is the question the reader actually has. This is the strongest
argument for approach C and it is not an implementation detail.

### Relationship to the self-heal spec's deferred approach C

`2026-09-16-workspace-self-heal-design.md` considered "seats attest a provisioning generation on
join" and deferred it: *"once B writes an audit row per repair, the fleet view is a query, and C can
be a later increment on top."* Increment 2 below is that increment, scoped down — one field, no
daemon-side drift computation, no interrupt-line push. Provisioning stays a per-workspace concern;
the daemon only records what the seat says it ran.

## 1 — The receipt

`~/.musterd/refresh/receipt.json`, one per machine, beside `stream/state.json` (`stream.ts:101`).
Per-machine and not per-checkout is the ruling miley landed the same day in #1540: a supervisor that
reads a file the stream never wrote is reading the wrong scope.

Written by the auto-refresh tick on **every** tick — success *and* refusal. Two halves:

| half | fields | meaning |
| --- | --- | --- |
| **observed** | `fetched_at`, `main_sha`, `main_guidance_epoch`, `main_guidance_summary` | what `origin/main` says |
| **applied** | `build_sha`, `build_guidance_epoch`, `blocked_reason` (when they differ) | what this machine runs |

Writing on refusal is the point. A receipt that appeared only on success would go quiet exactly when
things break, and silence is the failure being fixed. Writing on refusal lets the tick say *"main is
at epoch 24, this machine is at 23, and I could not advance it because the checkout has untracked
work"* — ghost's outage, stated at the moment it starts, by the thing that noticed.

`main_guidance_summary` is **an author-written line living beside `GUIDANCE_CONTENT_VERSION` in
`guidance.ts`**, not a commit subject. It exists because a stale seat cannot render the text it is
missing — its build is what is stale.

The first draft used the newest commit subject touching `guidance.ts`, capped at 80 chars. ryder
measured the last 15 such commits and killed it: **9 of 15 subjects exceed 80 characters** (max 172),
several truncating mid-clause — `8626ed88` lands on "…orient stops prescribing i" — and several of
those commits touched `guidance.ts` *incidentally*, so the subject names an unrelated refactor rather
than the rule a stale seat is missing (`ef3e9b05`: "remove the deprecated aliases…"). A carrier that
is truncated 60% of the time and sometimes describes the wrong change is not a carrier.

The authored line is versioned with the rule, written for this reader, never truncated, and never
about an unrelated refactor. A snapshot test already fails when the guidance body changes without the
constant moving; the same mechanism requires the summary line to move with it. The "pointer, not a
guarantee" hedge is then unnecessary and is dropped.

### Freshness cannot be inferred from presence — and age is not the measure

The receipt carries `fetched_at` from the writer; the reader judges staleness itself. A receipt that
is unparseable, or whose `fetched_at` is in the future, is treated as **absent, not as fresh**: ADR
135's doctrine that every consumer degrades to silence rather than a guessed ref.

**A wall-clock age threshold is the wrong measure, and the data on this machine says so.** The first
draft used 15 minutes (~7 missed ticks at the live `StartInterval` of 120s). Measured over
`~/.musterd/autorefresh/refresh.log` — 20,884 timestamped ticks across 44.1 days:

| | |
| --- | --- |
| gap between ticks | p50 121s, p90 122s, p95 126s, p99 406s, **max 83.9h** |
| share of WALL-CLOCK time inside a gap > 15 min | **35.75%** |
| same, > 60 min | 32.79% |

The tick is extremely regular, so the threshold is insensitive to its exact value — but roughly **a
third of all wall-clock time** sits inside a gap long enough for a naive reader to call the refresher
dead. The longest gaps name the cause: `2026-09-10 Thu 21:04 → 09-14 Mon 08:59` (83.9h, a weekend),
`09-01 Tue 22:42 → 09-02 Wed 09:16`, `08-10 Mon 22:48 → 08-11 Tue 06:47`. **The laptop was asleep.**

So state 3 would fire on about a third of session starts, disproportionately at the first session of
the morning — precisely when a human sits down to read it. That is the permanent-noise failure this
design claims to avoid, and it would train readers to skip the line, which is the sloane precedent
this spec cites as the reason increment 1 is weak. The measure would have manufactured the very
failure it exists to prevent.

**Root cause is one conflation:** `fetched_at` age answers *"how long since a tick"* when the question
is *"how many ticks were missed while the machine was awake"*. A sleeping laptop is not a stopped
refresher.

**The repair reuses a musterd invariant rather than inventing one.** The presence reaper already
separates "was the host there?" from "did the thing run?": `HOST_SUSPEND_GAP_MS`
(`server/src/store/residency.ts:72`) and the `residency.host_suspended` audit row (ADR 236,
`presence/reaper.ts:45`). The reader takes the same discipline — **a receipt gap that spans a suspend
is unattributable, not evidence.** Cheapest sufficient form: suppress state 3 when the host woke more
recently than the threshold. `docs/wiki/cannot-separate-two-causes.md` is the same shape one layer
down (ten degrade ticks, three attributable, seven permanently not), and the plan should reuse its
vocabulary.

### Machines with no refresher

A receipt that never exists must not become permanent noise on cloud seats and baked images.

**Do not add a second predicate.** The first draft proposed a fresh "is a refresher installed?"
check. `isPackagedCliInstall` already partitions exactly this population and is already load-bearing
for the ceiling note, so a second check would drift against it and nobody would know which is
authoritative when they disagree. "A refresher is expected here" is defined as
`!isPackagedCliInstall(...)`, and the ADR states that `isPackagedCliInstall` wins.

Silence for that population is not a gap — it is the correct division of labour, because they already
receive `packagedInstallNotes` (`runtime.ts:83`). The ADR should say so, so the next reader does not
re-open it.

## 2 — The reader

One more injected dep on `selfHealWorkspace` — a `currency()` returning the receipt verdict — keeping
the existing shape in which every dep is a production function and tests point it at a temp dir.
Reading a local JSON file is pure file I/O, so the "no network, no git" contract holds exactly.

The change to `composeLine` is small, and it is mostly a change of **meaning**. Today's line implies
currency by saying `repaired`. After this, `repaired` never appears unqualified — it becomes
*repaired from what*:

| state | condition | line |
| --- | --- | --- |
| 1 | fresh, `observed == applied` | unchanged: `musterd: repaired 1 guidance file.` |
| 2 | fresh, `observed > applied` | `musterd: repaired 1 guidance file from a build 1 epoch behind main — you are running guidance v23, main has v24 ("An acceptance ask gets a move…"). This machine's refresher is stuck: untracked work in the checkout.` |
| 3 | absent or old (refresher installed) | `musterd: repaired 1 guidance file, but this machine last checked main 6 days ago — the auto-refresher has stopped.` |

Quiet in state 1 is correct, because there it is true. The existing discipline holds: one line,
bounded by construction, counts not file lists. The single named thing is the authored rule summary —
and that is the point, since the lane measured an unnamed rule as unactionable.

**State ordering must be decided, not discovered.** `composeLine` already returns EARLY on its
`declined` and `behind` branches, before the repaired/head branch. So as written, state 2 can never
print for a seat that is also hook-behind. The ADR states the precedence explicitly: `declined` >
`behind` > currency states 2/3 > state 1. The rationale is that `behind` and `declined` both mean
*this build is not the authority here*, which makes a currency claim about that build meaningless —
so they must win, and the reader must be told they suppress the currency line rather than discovering
it from a silent seat.

**The honest limit.** This is still a warning. The lane records sloane's own SessionStart hook
printing a correct ADR 171 drift line, which sloane then proceeded past — the instrument worked and
the human-shaped reader deprioritised it. A louder line is a bet against evidence we already have.
Increment 3 is what turns this from a plea into a measurement.

## 3 — The attestation

The epoch rides the path model attestation already uses — `claim-handshake.ts:106` and the heartbeat
frame at `frames.ts:59` — so the member carries it and acts inherit it at send time. No new plumbing.

**One field: `guidance_epoch`.** It is the version stamped in the seat's `.claude/skills` files, not
its build's ceiling. The files are the text that was actually in the model's context when it decided
something; the build is only what *could* have been written. Attesting the build would attest a
capability rather than a fact.

That single field makes the lane's acceptance a query. Main's epoch at any past timestamp is
recoverable from git history, so the seat never needs to carry it.

**Deliberately omitted, and the cost is accepted knowingly:** a second field for whether the seat
*knew* it was behind (the receipt's verdict). A gate would need it — "you were told and proceeded" is
a different act from "nobody told you" — so omitting it guarantees a SECOND wire change when the gate
is built. ryder raised this as a tradeoff to decide here rather than leave to the increment-3 author.

**Decision: omit it, and accept the second wire change.** Not on the usual "don't ship unconsumed
fields" ground, which would be the weaker argument, but because the field's *meaning* depends on the
receipt's verdict being trustworthy — and the threshold finding above proved it is not yet. Shipping
`seat_knew_it_was_behind` today would mean shipping a field whose semantics we would have to redefine
once the suspend-aware reader lands. A second protocol change is a real cost; a field that attests
something we cannot yet define correctly is a worse one.

**The limit, stated plainly:** this is self-reported. A seat says what epoch it ran and nothing proves
it — the same limitation `model_source: 'observed'` already carries. It is honest bookkeeping, not an
attestation in the cryptographic sense, and the ADR says so rather than letting a future reader
assume otherwise.

## 4 — The gate (deferred, not scheduled; increment 3)

The lane's direction (c): refuse a lane-closing accept from a seat whose guidance predates the rule
that governs it. Fail-closed, and the only option that makes the harm impossible rather than visible.

Deferred on purpose. Shipping a fail-closed check on the acts that close other people's work, with no
data on its false-positive rate, risks a failure worse than the drift it prevents: stale guidance plus
a dead refresher would mean nobody can close anything. Increment 3 produces exactly that data. This
increment is unscheduled until it exists.

## The security line

The receipt is a local file under `~/.musterd/`, the same trust boundary as `config.json`. Anything
that can write it can already write the config the CLI trusts, so it widens no boundary.

What contains it is the consequence: in increments 1 and 2 the receipt can only cause a **warning**. It
never triggers a repair, never selects a build, never grants a capability. A forged receipt can make a
current seat believe it is stale (noise) or a stale seat believe it is current (the status quo today).
That containment is what makes increment 3 a separate decision — a gate would make the receipt
load-bearing for refusals, and it would then need to be trustworthy in a way it is not yet.

## Acceptance

**The lane's filed acceptance cannot be met by this design, and is proposed for amendment.** It reads:
*"a guidance correction landed on main is provably running in every live seat worktree within one
session boundary."* Warn-plus-attest makes staleness visible and measurable; only the deferred gate
makes it impossible. The sentence is also unachievable as written — a seat whose session never starts
can never be guaranteed current; the guarantee can only exist at the boundary where the seat acts.

Proposed replacement:

> A seat that acts on a superseded rule is detectable without forensics: the nine-worktree census is
> answerable as a query rather than a script, and an induced refresher outage produces a naming line
> at the next session start.

## Testing

`selfHealWorkspace` is already pure over injected deps, so the reader's states are ordinary unit
tests: current / stuck / dead / unparseable / `fetched_at` in the future / no refresher installed. The
writer follows the existing tick pattern — injected runner, temp dir, no real `launchctl`. Guards are
mutation-tested. TDD throughout.

**The end-to-end falsifier is the part that matters, and it has to distinguish sleep from death.**
Induce the outage on this machine — leave untracked work in the daemon checkout, exactly as happened
on 2026-09-17 — and confirm a seat's next session start prints the state-2 line naming the reason.
Then stop the refresher and confirm state 3.

That second half is not sufficient on its own: **an induced outage and a closed laptop lid are the
same observation to a naive reader**, so a falsifier that only stops the refresher passes for the
wrong reason. The suppression case is therefore a required third arm — suspend the host across the
threshold, confirm state 3 does NOT fire, then stop the refresher with the host continuously awake and
confirm it does. Only the pair proves the reader distinguishes them.

Two known traps, from prior sessions: rebuild `packages/protocol` before trusting any `packages/cli`
typecheck (local dist goes stale the moment another lane merges a protocol change), and commit before
`change-adr:check`, which diffs committed changes only.

## Increments

Sections above are numbered by component; increments bundle them. **The order is deliberately not
the section order** — ryder's review reversed it, and the reason is the threshold finding.

1. **Section 3 — the attestation.** `guidance_epoch` through the handshake and heartbeat onto the
   member; the census becomes a query. Own ADR (protocol change).
2. **Sections 1 + 2 — the receipt, reader, and line.** CLI-local, with its ADR.
3. **Section 4** — *deferred, unscheduled* — the gate, only once the attestation has produced
   false-positive data.

**Why the attestation goes first.** It carries no threshold, no false-positive surface, and no
dependency on the receipt — and it is the increment that actually delivers the amended acceptance
(the census as a query). The receipt's line is the part carrying the noise risk that finding 1
exposed, and the part whose own precedent (sloane reading a correct line and proceeding) says it may
not change behaviour at all. Shipping a noisy line first would burn the reader's attention before the
measurement that would justify a gate even exists. At minimum the attestation must not be gated on
the receipt.

## Contention

- `packages/cli/src/service/**` overlaps ghost's `01M2REEQC36M0KWPMTMGNZR6N0` (the refusal that never
  names the file). Same code path, opposite end. nick's call was that this lane keeps the whole chain
  rather than splitting it at the writer; ghost has been told and can object. The overlap is
  productive: this reader turns that 52-refusal outage into something visible at every seat.
- `packages/protocol/**` overlaps big-body's `01M2P8WRVZXWQYA80RMKBCXWBJ`. This design touches
  `frames.ts`, `claim-handshake.ts` and `member.ts`, not `guidance.ts` — so stanley's
  `01M2RP18EVRCY0CHW8G12GTWKH` is clear.
- Unowned lane `01M2PAFNAS1R43HFWVRZPWNPRG` carries `model_source` to `MemberSummarySchema` and the
  audit actor row — the same field travelling the same route as increment 2. If it is claimed while
  this is in flight the two will collide; flagged to the board rather than silently absorbed here.
