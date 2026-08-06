# 239 — Foreign paths in the working tree: warn about the files this session never touched

- Status: proposed
- Date: 2026-08-05
- Deciders: dolly, from ryder's incident lane `01KZ9GRJT7`
- Relates to: ADR 150 (lane-ownership PreToolUse gates — the enforcement pattern, and its warning
  about gates that induce workarounds), ADR 163 (the PreToolUse payload envelope, measured), ADR 109
  (per-worktree seat git identity), ADR 065 (one seat, one worktree), ADR 092 (same-workspace
  successor grace), ADR 237 (the same incident's seat layer)

## Context

musterd guards **lanes** (surface overlap, ADR 150) and **seats** (single-active, ADR 068). Nothing
guards the **working tree**. A worktree is one directory with one HEAD shared by every session
running in it, and git has no notion of sessions — so two sessions in one seat folder collide with
no warning from either system.

The incident (`/Users/nick/agents-ryder`, 2026-08-05, from the reflog): session A checked out
`ryder/wake-unreachable-defers` and left an ADR plus a server implementation uncommitted; session B
checked out `ryder/standing-acceptor-capture` in the same folder and ran `git add -A`. B's commit
swept A's entire uncommitted lane diff into B's unrelated commit, which merged as PR #679. A's own
PR #678 had to be **closed**, because merging it would have reverted B's work and a third seat's
ADR. Nothing was lost — the files on main were byte-identical to the tree A had gated — but the
authorship, the PR narrative and the lane's provenance went with it. A's push had also gone to B's
branch, so a later `git push` reported "Everything up-to-date" while the intended branch sat at an
old commit.

Reproduced in four commands (a scratch repo, A edits without committing, B switches branch and runs
`git add -A`): B's commit contains A's file, and A's branch contains nothing. The mechanism is
entirely git's and needs no musterd bug to fire.

### What the measurement changed

The lane was filed at n=1 and asked, correctly, for frequency before enforcement. The audit ledger
answers it, and the answer splits in two:

- **The window is routine.** 54 `claim.superseded {same_workspace: true}` rows in `~/.musterd/musterd.db`
  between 2026-07-06 and 2026-08-04 — 1 to 10 a day, most days. A second session in a seat folder is
  not an anomaly; it is the normal way a seat gets picked up again.
- **The harm is rare.** One observed collision, ever.

That ratio is the whole design. A gate priced for a daily event, defending against a monthly one,
is exactly the gate ADR 150 warns becomes the thing everyone learns to work around. The window is
common **and benign** — the predecessor session is usually finished. What distinguishes the incident
is not two sessions; it is one session staging _another session's_ files.

### The seam is already open

The lane recorded a make-or-break open question: **is the session's own edit set even knowable at
the hook seam?** It is, and nothing new has to be wired to know it.

- `musterd init` already provisions a PreToolUse hook matching `Edit|Write|MultiEdit|NotebookEdit|Bash`
  — both halves are already in scope: the writes that build the edit set, and the `git` command that
  consumes it.
- The payload envelope carries `session_id` (measured on Claude Code 2.1.220 and tabulated in
  ADR 163; `parseToolCall` already reads sibling fields off the same envelope).
- `gate check` already extracts `file_path`/`notebook_path` per write call, repo-relative
  (`repoRelativePath`).

So the session's edit set is a per-session accumulation of paths the gate is already parsing. The
answer to the lane's question is yes — and because it is yes, the cheaper half survives.

### Amendment, 2026-08-05 (same day) — the index has to be ignored, or the gate feeds itself

The Decision below is unchanged. One thing it did not say, and had to: **the per-session index must
be git-ignored.** It was not, and within hours of the gate shipping, three indexes were tracked on
`main` — `session-edits-1f14cba0`, `-4e182ce6`, `-548fda80` — each swept in by a `git add -A` in a
different seat. Not a one-off: it is the default outcome of the ritual everyone follows, and the
ritual this gate exists to watch.

**What that actually breaks**, stated narrowly because the temptation is to overstate it. The gate's
_correctness_ is intact: it reads only the file matching its own `session_id`, so a foreign index is
never consulted. What breaks is decision 2's claim, in this ADR's own words, that the index "never
leaves the machine" — committing one publishes a session id and one seat's edited-path history to
every clone, forever. And it is self-feeding: those files land in every other seat's state dir on
pull, where they are foreign paths in the working tree, which is the exact condition the gate warns
about. The instrument manufactures its own signal.

Fixed by ignoring `**/.musterd/session-edits-*.txt` alongside `binding.json`, `continuity.json` and
`pending/` — the same class of local, per-session, never-committed state — plus `git rm --cached` on
the three already tracked, because ignoring does not untrack. A test asserts both properties against
the real repository index, so a future `git add -A` cannot quietly restore them.

**The reason this is worth an amendment rather than a silent `.gitignore` line:** a gate whose own
evidence is committable was under-specified, and the next stateful gate will have the same question.
Local state needs an ignore rule in the same change that creates it.

### Correction, 2026-08-05: the normalizer answered a different question

The first implementation matched `normalizeCommand(command)`, and gptbot's outcome review declined
it for two false-positive classes that turn out to be one mistake wearing two hats.

`normalizeCommand` exists to serve the ADR 150 enforcement matcher, whose question is **"what class
of action is this?"** — so it lifts off git's pre-subcommand globals on purpose (ADR 153's exercise
finding: a class author writes `git merge*` and it should still catch `git -C ../main merge`). This
check's question is **"which tree does this touch?"**, and the normalizer erases the exact token
that answers it. `git -C ../main add -A` and `git add -A` normalize to the same string, so the gate
ran `git status` here and described a tree the command never touched. Separately, the matcher's own
comment claimed "no other pathspec" while its regex only anchored the flag, so `git add -A own/`
matched and the whole tree was reported for a command scoped to one directory.

This is ADR 225's shared-predicate trap, third sighting: one value with two consumers whose needs
are opposite, where the consumer that arrives second inherits a predicate tuned for the first. The
repair is not a better regex — it is matching the **raw** command, lifting only the env-assignment
prefix (which changes the committer's identity, never the tree).

Two things are worth recording about how it was caught. The bad behavior was **asserted as correct
by its own test** (`'git -C ../main add -A'` sat in the match list citing ADR 153), so the suite was
green on the defect; a test can only protect the property its author understood. And the gate's
first live warning fired on its author's own `git add -A`, against files written through a python
heredoc it cannot see — the documented coverage hole, arriving within the hour.

### Verdict, 2026-08-06 — the purpose survives, the instrument does not

This ADR pre-registered its own falsifier: _"a month of warnings that are mostly false positives
falsifies decision 3 … the honest response is to delete the feature rather than widen it into a
guess."_ One evening's use, reconciled across three seats, produced:

| outcome                    | n   | what happened                                                             |
| -------------------------- | --- | ------------------------------------------------------------------------- |
| false positive             | 4   | writes through a `python3 - <<EOF … open(p,'w')` heredoc, invisible to it |
| true positive, **ignored** | 1   | correct, and overridden — the caveat had been true three times running    |
| miss                       | 1   | an untracked foreign index, excluded by decision 3 **by construction**    |
| collisions prevented       | 0   | —                                                                         |

**Two ways of reading that are both wrong, and it matters which.** Triggering the rate test on day
one would be moving the goalpost pessimistically — the pre-registration said a _month_, and five
warnings is not a rate. Waiting a month would be moving it optimistically, because the sample already
exposed the mechanism the rate test was only ever a proxy for. The proxy is unnecessary once the
mechanism is visible, and the mechanism is this: **decision 1's predicate has unbounded negative
space.** "Not in the set this session wrote" is built from Edit/Write tool calls, so every write
through Bash — a heredoc, `sed -i`, an interpreter's own I/O — is not merely unobserved but converted
into an accusation. Agents write through Bash constantly. The false positives were not bad luck; they
were the design working as specified. All four came from that one cause, across three seats, on day
one.

And the false positives are what destroyed the true one. izzo overrode a correct warning by reaching
for the "you may have written these through a channel I cannot see" caveat, which did not apply that
time. A warning that is usually wrong teaches its reader to dismiss it, and it spends that
credibility on the occasion it is right.

**But the purpose survives, for a reason discovered while looking for a cheaper replacement.** The
obvious alternative — ask the daemon whether another session is live in this folder — **cannot be
built.** ADR 068 single-active means the second session _evicts_ the first, and
`touchAmbientPresence` no-ops while the winner holds a socket, so the evicted-but-still-working
session — ADR 237's entire subject, and precisely the dangerous actor — is invisible to the
coordination layer by construction. The working tree is the only place it can be observed. This gate
is not redundant with a cheaper signal; there is no cheaper signal.

**One error of mine is worth recording, because it is the same error the whole team hit that day.**
The original lane recommended detecting the _condition_ (two sessions in one workspace) before
attempting per-file attribution. I overrode that with a measurement: 54 same-workspace displacements
a month, too common to gate on. But a **displacement** is sequential and benign — one session
replacing a finished one — while **concurrency** is simultaneous and dangerous, and I had measured
the first while reasoning about the second. A number that reads as a fact about the system was a fact
about the instrument. The irony is exact: this ADR is about an instrument that cannot see what it
reports on, and it was chosen using one.

So decision 1 is replaced rather than deleted, and decision 2 is deleted outright.

## Decision

**1. Warn about paths that provably predate this session, at the moment they would be staged.** On a
PreToolUse `Bash` call whose command is stage-shaped over an implicit path set **in this worktree**
(`git add -A`, `git add -u`, `git commit -a`), the gate lists `git status --porcelain` and names
every path whose file was **last modified before this session began**. Warn (`additionalContext`),
never deny.

The change is from a predicate of _inference_ to one of _certainty_. "Was not observed to be written
by this session" admits everything the gate cannot see; "was last modified before this session
existed" admits nothing — it is not a claim about what was observed but about what is possible. The
entire measured false-positive class disappears by construction, without teaching the gate about
heredocs, `sed -i`, or any future write channel. It also stops being a race the gate can lose as
agents adopt new tools.

Untracked paths are now **included**, reversing the old decision 3, and the mtime test is what makes
that safe: ignored files never appear in porcelain, and real build output is rewritten constantly so
its mtime is recent. What survives the filter is a leftover from before this session existed — which
is exactly the case that did the most damage and could not previously be seen at all.

**The accepted loss, stated plainly because it is the motivating case.** A genuinely _concurrent_
writer modifies files during this session, so it is no longer caught — the 2026-08-05 incident that
prompted this ADR would not fire under the new predicate. Recall is traded for certainty on purpose.
A warning nobody believes prevents nothing, and the day-one ledger is the evidence: the old predicate
had the recall and still prevented zero collisions, because it spent its credibility before it was
right. A test asserts this loss so a future reader cannot mistake it for an oversight.

Scope agreement is unchanged and still governs which commands qualify: a command earns a `git status`
**only when the tree that status inspects is the tree the command stages**. Three forms are excluded,
each a way the warning could name a file the command would leave alone:

- **A pathspec.** `git add -A own/` stages only `own/`; status reports the whole tree.
- **A tree-redirecting global.** `git -C ../main add -A` stages a sibling worktree.
- **`git add .`** — scoped to the shell's cwd, which the hook cannot observe (the Bash tool's
  working directory persists across calls; the hook always runs at the repo root, so the two can
  disagree). Unknown scope is treated as out of scope.

**1a. The warning states a certainty and offers no escape hatch.** The old wording ended "if you
wrote them through a command this gate cannot see, carry on" — the sentence izzo reached for when
overriding a correct warning. The predicate now guarantees these paths are not this session's, so
there is nothing to excuse them with, and the copy says so. A test asserts the caveat's absence.

**~~2. The session's edit set is local, per-session, and disposable.~~ WITHDRAWN by the verdict.**
The tool-call index is deleted entirely — with it goes the append-per-edit write, the "no index means
no knowledge" special case, and the class of bug that let the gate's own state be committed
(amendment above). What replaces it is one empty marker file per session whose **mtime is the session
start**, created once with `wx` so a resumed session keeps its original start, and never read across
sessions. A session with no marker has no start time and therefore can never accuse anything; a
marker created by the very command being judged is treated the same way, since everything on disk
would predate it.

<details>
<summary>The withdrawn decision 1 and 2, as shipped 2026-08-05 (kept for the record)</summary>

**1. Warn on foreign modified paths, at the moment they would be staged.** … the gate compares
`git status --porcelain` against this session's recorded edit set and, when modified **tracked** paths
exist that this session never wrote, emits a warn naming them.

**2. The session's edit set is local, per-session, and disposable.** Write-shaped calls append their
repo-relative path to a per-session file keyed by the envelope `session_id`; a lost or missing index
degrades to no warning, never to a false one.

</details>

**~~3. Silence on the ambiguous cases, by construction.~~ WITHDRAWN by the verdict**, and it is the
withdrawal that mattered most. Decision 3 excluded untracked paths because their false-positive floor
was too high, and the single most damaging event of day one — a foreign session's index, untracked,
swept onto `main` — was invisible to the gate _because of that exclusion_. The mtime predicate
removes the reason for the exclusion, so untracked paths are in scope under decision 1. Its second
half (a path written through a channel the gate cannot see "simply appears foreign") is not softened
but eliminated: that path is now never named at all.

**4. No enforcement, and the reason is recorded, not deferred.** No branch invariant, no deny on
commit or checkout. The candidate — "a seat commits only on the branch its claimed lane declares" —
is **rejected for now on the measurement above**, not postponed for lack of time: seats legitimately
work outside a lane (docs, spikes, this very investigation started unclaimed), the benign case
outnumbers the harmful one by ~54:1, and a gate that fires mostly on correct work teaches its own
bypass. If the warning fires and is repeatedly _right_, that is the evidence the gate needs; the
Eval below is written to collect exactly that.

**5. Nothing touches the working tree.** The gate reads `git status` and `stat`s the paths it reports;
the only thing it writes is its own empty session marker. It never stashes, moves, resets or
reformats another session's work — the failure mode this repo has already been bitten by once, and
for which there is no reflog.

**Out of scope:** the seat layer (ADR 237); the push-to-the-wrong-branch confusion, which is a
consequence of the same collision and is addressed by not having the collision; multi-session
detection on the roster, which the ledger already supports and which no surface currently reads.

## Consequences

- The common case pays nothing: a `git add -A` in a tree whose changes are all this session's own
  produces no output, and non-`git` Bash calls return before any `git status` runs.
- **The false-positive class is gone by construction, not by coverage.** No future write channel —
  a new tool, a new interpreter, a subagent writing under the same `session_id` (identical by
  construction, ADR 163) — can reintroduce it, because the gate no longer asks what wrote a file.
  This is the whole point of the verdict: the old design had to keep up with how agents write, and
  this one does not.
- **The gate no longer knows what this session edited, and nothing should ask it to.** The tool-call
  index is gone; what remains is one empty marker file per session. That also removes the class of
  bug in the amendment above — a marker carries a session id in its filename and nothing else, so
  committing one leaks no edit history.
- **Recall is materially lower and the motivating incident is now out of scope.** A concurrent writer
  is not caught. This is the cost of the trade and is asserted by a test rather than left to memory.
  If concurrent-writer detection is ever wanted, it needs an instrument that can see a session the
  daemon cannot (see the verdict), and it should be argued on its own evidence — not smuggled back in
  by widening this predicate, which is how the first version failed.
- Warn is best-effort by construction (ADR 150): a Claude Code build that ignores `additionalContext`
  proceeds silently, and there is no server-side audit row backing it. **That absence is now itself a
  finding**: the day-one ledger had to be reconstructed from three seats' status messages because the
  feature recorded nothing about its own firings. A gate that cannot be evaluated cannot be defended,
  and the next stateful gate should decide its evidence trail in the same change that creates it.

## Observability & Evaluation

**Traces.** None added server-side, deliberately (raw paths stay local, ADR 051). The signal is the
warning text in the model's context. The existing `claim.superseded` rows (ADR 237) remain the
ledger-side record of _windows_. See the last consequence above: the lack of any firing record is a
known, named weakness of this design, not an oversight.

**Eval.** The dataset is now the day-one ledger itself — six real outcomes, each a fixture in
`workingTree.predates.test.ts`, and the predicate is judged on all six rather than on the ones that
flatter it. Baseline (old predicate): 4 false positives, 1 true positive overridden, 1 miss. Under
the new predicate the four false positives are silent, the true positive still fires, and the miss
now fires — with the concurrent-writer case newly silent, asserted as the accepted loss.

**Experiment.** None planned. The measurement that selected this design is in the verdict; the one
that would have been needed to keep the old one (does teaching the gate about every write channel
converge?) is unanswerable in principle, which is why it was not attempted.

- **Certainty is the invariant, and its falsifier is any named path a session could have written.**
  A warning must name only paths whose mtime predates the session marker. If a warning ever names a
  path modified after that instant, the predicate has been widened back into an inference and the
  verdict has been reversed by accident. Asserted directly, and by mutation.
- **Ignored files are kept out twice, and neither guard is individually tested.** Plain
  `git status --porcelain` already omits them, and the `!!` status is skipped as well; each mutant
  survives alone because the other covers it. Recorded for the same reason as the matcher
  redundancies below — a reader should know the property has two guards and no test that
  distinguishes them, rather than discover it by removing the wrong one.
- **The accepted loss must stay lost.** A test asserts that a concurrent writer produces **no**
  warning. If someone "fixes" that test to make it warn, they have reintroduced the false-positive
  class this verdict removed — the test says so in its own comment, because the failure mode is a
  well-meaning future reader, not a bug.
- **No-knowledge beats a guess, twice over:** a session with no marker, and a session whose marker
  was created by the very command being judged, must both warn about nothing. The second case is the
  subtle one — a marker stamped microseconds ago makes the entire tree "predate" the session — and
  the live exercise of the previous design produced exactly that failure in its own form.
- **Scope agreement** (the 2026-08-05 correction) is unchanged and still governs which commands
  qualify: for any command the matcher accepts, the set `git status` reports must equal the set the
  command would stage. The falsifier is a matched command whose staged set is narrower — a pathspec,
  a `-C`/`--git-dir`/`--work-tree` redirect, or a cwd-relative `.`. A failure here is _silent_: a
  plausible warning about the wrong files, not an error anyone would notice.

  Mutation testing said something the green suite could not, and it is recorded rather than tidied
  away. Of the matcher's rules, four are load-bearing — a bare token means a pathspec, the attached
  `--git-dir=`/`--work-tree=` forms, the env-prefix lift, and a value-taking flag consuming its value
  — and each has a killed mutant. **Three are redundant**: the separated `-C`/`--git-dir` forms, the
  `--` separator, and any special case for `.` all reduce to the bare-token rule or the subcommand
  check, and their mutants survive. The honest statement is that the invariant rests on _one_ rule,
  with the rest kept as intent. A future edit that weakens the bare-token rule will not be caught by
  the checks that appear to guard the same property.

- **What would falsify the posture:** a warning that blocks or delays a correct commit. The emitter is
  `additionalContext`, which cannot deny; if a future Claude Code makes that surface blocking, this
  ADR's posture claim is void and the decision needs re-taking.
- **What would falsify the whole feature, restated post-verdict.** The old rate test is spent — it was
  a proxy for an unbounded negative space, and that space is now bounded. The replacement: **a month
  in which the warning never fires, or fires only on paths a reader shrugs at, means the harm it
  guards is not occurring and it should be deleted outright.** There is no third revision. A gate
  that has been redesigned once already and still cannot show a prevented collision is a gate whose
  premise, not whose implementation, is wrong.
