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

## Decision

**1. Warn on foreign modified paths, at the moment they would be staged.** On a PreToolUse `Bash`
call whose command is stage-shaped over an implicit path set (`git add -A`, `git add .`,
`git add -u`, `git commit -a`), the gate compares `git status --porcelain` against this session's
recorded edit set and, when modified tracked paths exist that this session never wrote, emits a
**warn** (`additionalContext`) naming them. Never a deny. The message names the paths and says what
they are: files changed on disk that this session did not touch, which this command will stage.

**2. The session's edit set is local, per-session, and disposable.** Write-shaped calls append their
repo-relative path to a per-session file under the workspace's musterd state, keyed by the envelope
`session_id`. It never leaves the machine: no new audit row, no POST, no server schema. This is a
client-side convenience index, not a ledger — ADR 051's rule that raw paths stay local is preserved,
and a lost or missing index degrades to no warning, never to a false one.

That last clause is load-bearing and was **not** free. Exercising the real hook found the opposite
behavior: with no `.musterd/` directory to append to, every write was silently dropped, and the next
`git add -A` reported the session's _own_ files as foreign — the maximally wrong output, produced by
the failure path that was supposed to be the safe one. "This session wrote nothing" and "this
session's writes were never recorded" are indistinguishable from an absent file's contents and want
opposite answers. So **the absence of an index is treated as no-knowledge, and warns about nothing**;
only a session with a real index is ever compared. The cost is a genuine coverage hole — a session
that stages a predecessor's leftovers before writing anything of its own is not warned — and that
hole is accepted deliberately, because precision is the metric decision 4 hangs on and a warning
that fires on every fresh session's first commit in a dirty tree would destroy it.

**3. Silence on the ambiguous cases, by construction.** Untracked files are **not** warned about
(a build artifact, a scratch file, a fresh checkout's noise — the false-positive floor is too high
and `git add -A` staging an untracked file is not the incident). Neither is a path the session
wrote through a tool the gate cannot see (a heredoc, `sed -i`) — those simply appear foreign, so the
warning is worded as an observation to check, never as an accusation of error.

**4. No enforcement, and the reason is recorded, not deferred.** No branch invariant, no deny on
commit or checkout. The candidate — "a seat commits only on the branch its claimed lane declares" —
is **rejected for now on the measurement above**, not postponed for lack of time: seats legitimately
work outside a lane (docs, spikes, this very investigation started unclaimed), the benign case
outnumbers the harmful one by ~54:1, and a gate that fires mostly on correct work teaches its own
bypass. If the warning fires and is repeatedly _right_, that is the evidence the gate needs; the
Eval below is written to collect exactly that.

**5. Nothing touches the working tree.** The gate reads `git status` and writes only its own index
file. It never stashes, moves, resets or reformats another session's work — the failure mode this
repo has already been bitten by once, and for which there is no reflog.

**Out of scope:** the seat layer (ADR 237); the push-to-the-wrong-branch confusion, which is a
consequence of the same collision and is addressed by not having the collision; multi-session
detection on the roster, which the ledger already supports and which no surface currently reads.

## Consequences

- The common case pays nothing: a `git add -A` whose modified paths are all this session's own
  produces no output, and non-`git` Bash calls return before any `git status` runs.
- The gate gains its first _stateful_ behavior (the per-session index). It is bounded — one small
  file per session in the workspace's state dir, written append-only, never read across sessions.
- A session that writes files outside the gate's view (heredoc, `sed -i`, a subagent's own writes
  under a different `agent_id` but the same `session_id` — identical by construction, ADR 163) will
  see those paths reported as foreign. Accepted: the wording makes a false positive cheap, and
  decision 3 keeps the loudest source (untracked files) out entirely.
- Warn is best-effort by construction (ADR 150): a Claude Code build that ignores `additionalContext`
  proceeds silently. Unlike the ADR 150 gate, there is **no** server-side audit row backing it, so a
  build that drops the surface drops the whole signal. That is the price of decision 2, and it is
  why the Eval below measures from the local index rather than the ledger.

## Observability & Evaluation

**Traces.** None added server-side, deliberately (decision 2). The signal is the warning text in the
model's context, and the per-session index on disk. The already-existing `claim.superseded` rows
(ADR 237 decision 1) remain the ledger-side record of _windows_; this ADR adds no counterpart for
collisions, because a collision is a client-local observation about paths that must not leave the
machine.

**Eval.** Dataset: the incident above, reduced to a fixture — a repo where session A's path is
modified and absent from session B's index. Baseline: today the gate emits nothing on `git add -A`
in that fixture. Post-ADR it names `a-work.txt` and only `a-work.txt`. Verified by **mutation**, not
by green: invert the set difference and the test must fail.

**Experiment.** None planned. The measurement that mattered — window frequency vs. collision
frequency — is already done (54 vs 1, above) and is what selected the warn posture over the gate.

- **Precision is the metric that decides decision 4.** Every warning is either right (foreign paths
  really belonged to another session) or wrong (the session wrote them unseen). The claim to test
  over the next month: warnings fire rarely, and when they fire they are right. **A month with zero
  warnings falsifies the lane's premise** — the incident was a one-off and even this should be
  removed. **A month of warnings that are mostly false positives falsifies decision 3** — the
  gate's view of "this session's writes" is too narrow to be useful, and the honest response is to
  delete the feature rather than widen it into a guess.
- **The no-knowledge rule has its own falsifier:** a session with no index must warn about nothing,
  even in a dirty tree. Asserted directly; without it the first `git add -A` of every fresh session
  is a false accusation, which is what the live exercise actually produced before the rule existed.
- **The cost claim:** a non-`git` Bash call must not invoke `git status`. Asserted by a unit test on
  the command matcher, so the "common case pays nothing" consequence has a falsifier.
- **The no-touch invariant (decision 5):** a test asserting the gate path issues no git command that
  can write — `status` only. Mutation: swap in a writing command and the test must fail.
- **What would falsify decision 1's posture:** a warning that blocks or delays a correct commit. The
  emitter is `additionalContext`, which cannot deny; if a future Claude Code makes that surface
  blocking, this ADR's posture claim is void and the decision needs re-taking.
