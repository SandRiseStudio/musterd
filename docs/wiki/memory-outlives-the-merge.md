# Memory outlives the merge

A seat's memory note says "carrying" for work that landed days ago, because nothing rewrites a note when the work it describes lands — and orientation read the note before the board or the repo.

## The shape

Seat memory (`team_memory_save`) is a point-in-time record with no revision path. ADR 259 says it is for cross-session continuity and is not a source of truth; the board and the code are. But the orient skill read memory in step 2 and reported "carried lanes" in step 4 without consulting either, so a note that was **true when written** was repeated as true now. The failure is ordering, not discipline: memory was consulted first and trusted, and the authoritative surfaces only if something smelled wrong.

This is one level up from [a constraint outlives its premise](constraint-outlives-its-premise.md): there a comment outlives the fact it rested on; here the seat's own continuity note outlives the merge it predates. The lane board knew, the note did not, and the note was read first.

## Measured (2026-09-19, three for three)

miley oriented, read seat memory, and reported three lanes as carried. All three were finished work that had never been submitted:

| lane | memory said | what main said |
|---|---|---|
| `01M2M75BQH` (/watch page) | "UNBLOCKED, the natural next BUILD" | shipped 2026-09-16 in #1474 (`83015333`), live on musterd.io for three days through #1487, #1491, #1561 |
| `01M2NWVH4G` (screencast ack race) | "claimed, untouched" | fixed in #1500 (`2f1eae77`) with four unit tests and a wiki entry |
| `01M2RTF9F2` (sprite cache) | correct — and only because its blocker was fixed in the same session the note was written | #1550 (`fea3e44a`) |

In each case the seat was one step from rebuilding what was already on main. What stopped it was the occupant choosing to verify before typing — a habit, not a mechanism.

## The mechanism (2026-09-19)

`team_next` now reconciles each carried lane against `origin/main` using the seat's own worktree git (`packages/mcp/src/landed.ts`), the same place `lane_submit` verifies a merge. The daemon cannot do this: it has no git of the seat's repo, and ADR 294/297 forbid a background sweep. A lane with evidence is rendered under its carrying line as `↳ LANDED, unsubmitted — <evidence>` with `lane_submit` named as the next act. The orient skill's step 2 sends the seat to `team_next` before it repeats anything from memory.

Two recorded facts count, either alone:

1. **A commit on main declares the lane.** Landing commits declare in a fixed shape — `Lane \`01M2NWVH4G\`.` in the body's first five lines (#1500 line 3, #1550 line 3) or `(lane 01M2…)` in the subject (#1552, #1556, #1560). Squash bodies cite the SHORT id, never the full ULID. The oldest declaration wins.
2. **The lane's branch was pushed and is gone from origin.** "Pushed" means `branch.<b>.merge` is `refs/heads/<b>`; GitHub auto-deletes on merge (ADR 106).

Absent evidence prints nothing. A stale ref can under-report but never fake a landing, so a failed fetch degrades to silence.

### Two false positives the first live probe produced, both fixed before landing

- **A mention is not a declaration.** `git log --grep=<id>` matched #1568 ("declining lane 01M2RTF9F2 on exactly this one paragraph") and #1578 (line 47: "Lane `01M2XAXRP3` is open and unowned"), neither of which landed the lane it named. The declaration shape — case-sensitive, line-anchored, early — separates them.
- **An upstream is not a push.** `git checkout -b x origin/main` (ADR 106 step 1) configures `branch.x.remote` before anything is pushed, so "has a remote and is absent from origin" flagged this seat's own unpushed branch. The check now requires the branch to track its own name.

### What the mechanism still misses (2026-09-19; falsify: run the probe below in a worktree where the lane's local branch has already been cleared with `git branch -D` — if `01M2M75BQH`-shaped lanes are marked, this section is stale) <!-- claim: defect -->

The /watch lane is caught by signal 2 only while the local branch exists. After ADR 106 step 6 clears it, `branch.<b>.merge` is gone too, and a landing commit that cites no lane id (#1474 cited none) leaves nothing to find. Live probe from `agents-miley` on 2026-09-19, after miley's cleanup: `01M2NWVH4G` and `01M2RTF9F2` marked by signal 1; `01M2M75BQH` unmarked. The fix for that case is upstream of this page — a squash body that declares its lane — and `shipping-a-pr.md` is where that convention lives.

## The falsifier

Open a lane, land its PR, leave the lane unsubmitted, start a fresh session in that seat, and see whether orientation reports the lane as carried work with no `LANDED` line under it. If it does, the gap is live.

Watched failing on the code before this landed: `fmtNext` had no such line to print (2026-09-19; falsify: `git show <this page's landing sha>~1:packages/mcp/src/tools/lanes.ts | grep -c LANDED` is 0). <!-- claim: other -->

Watched passing (2026-09-19): the probe against the three measured lanes, run from `agents-miley` via `packages/mcp/dist/landed.js`, marks `01M2NWVH4G` → `2f1eae77 (#1500)` and `01M2RTF9F2` → `fea3e44a (#1550)`, and leaves this lane's own unpushed branch unmarked. A `team_next` in a seat carrying a landed-unsubmitted lane prints the `↳ LANDED, unsubmitted` line under it.

Unit falsifiers: `packages/mcp/src/landed.test.ts` (declaration vs mention, push vs upstream, oldest declaration wins) and `packages/mcp/src/tools/next.render.test.ts` (the line renders, and only where evidence exists).
