# 008 — The subagent-write detector catches about two thirds of writes, and misses the agent-shaped third

**Status:** measured 2026-07-27 · **Lane** `01KYJ8B5AB` · **Gates** the interpretation of ADR 163's
compliance arm · **Apparatus** `scripts/research/adr-163-recall.ts`

ADR 163 increment 1 emits `actor.subagent_write` rows and states plainly that the resulting count is a
**lower bound, not a rate**, because `isWriteShaped()`'s `Bash` arm is a heuristic match on a command
string whose recall had never been measured. Until it was, a near-zero count was ambiguous between _the
rule holds_ and _the instrument is blind_, and the compliance arm could not be read in either
direction. This is that measurement.

## Headline

| Quantity                                     | Result            |
| -------------------------------------------- | ----------------- |
| **Recall, executed corpus**                  | **21/31 = 67.7%** |
| Recall, inspected-only corpus (not run)      | 6/9 = 66.7%       |
| **Recall, combined**                         | **27/40 = 67.5%** |
| **False positives** (non-write scored write) | **0/15**          |

So the ADR's lower bound is loose by roughly a third: **a reported count of N implies on the order of
1.5 N actual write-shaped subagent calls**, on this corpus. The detector is _conservative but not
noisy_ — it never cried wolf once across 15 true reads, including reads by the very same binaries whose
writes it catches (`awk` with and without a redirect, `sort` with and without `-o`, `python3` reading
vs writing). That asymmetry is the right one to have: the count can be trusted as far as it goes.

## Ground truth was measured, not asserted

The first thing this arm had to avoid was the failure mode it exists to catch. Each command runs in a
fresh sandbox and the tree is hashed before and after — **file contents, file mode, symlinks and
directory structure** — and "did it write" is that hash changing. Nothing is labelled by my belief
about what a command does.

That caught two bugs in my own harness on the first run, both of which would have published a wrong
number:

- `copy.txt` was seeded with content identical to `seed.txt`, so `cp seed.txt copy.txt` was a genuine
  no-op and scored as a **false positive** against the detector. It was not one.
- The tree hash covered content but **not file mode**, so `chmod 600 seed.txt` — a real write —
  scored as a non-write, producing a second phantom false positive.

Fixing both moved recall trivially (67.9% → 67.7%) but took false positives from 2 to **0**. The number
that would have been wrong was not the headline; it was the claim that the detector over-fires, which is
the opposite of what it does. Recorded because it is the third time on this team that a measurement
harness lied before the thing it measured did — see finding 007's matcher gap and miley's
self-contaminating broadcast load gate.

## What it misses, and why the pattern matters more than the number

The 10 executed misses are not scattered. They fall into four groups:

| Group                               | Misses                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Interpreter indirection**         | `python3 -c 'open(...).write(...)'`, `python3 write_it.py`, `node -e '...writeFileSync...'`, `node build.js` |
| **Delegation to a script or build** | `bash script.sh`, `make out.made`                                                                            |
| **Archive extraction**              | `tar -xf bundle.tar`, `unzip -o bundle.zip`                                                                  |
| **In-place via a tool's own flag**  | `sort seed.txt -o sorted.txt`, `rsync seed.txt rsynced.txt`                                                  |

Inspected-only misses add a fifth: **outward writes** — `gh pr create`, `curl -X POST`, `curl -o`.

The unifying property: the detector recognises **command names it knows and redirection syntax it can
see**. It cannot see a write that is the _runtime behaviour of an interpreted program_, one _delegated_
to a script or build tool, or one passed as an _argument_ rather than a redirect.

**This is the load-bearing finding, not the 68%.** The miss set is precisely the shape of "an agent
writes a program and then runs it" — which, after `Edit` and `Write`, is the most common way an agent
actually changes a repository. The blindness is not uniformly distributed across agent behaviour; it is
concentrated on one of the most-travelled paths. A subagent doing exactly the thing nick's rule forbids
— landing build artifacts, running a generated script — is disproportionately likely to be invisible.

### A correction to ADR 163

ADR 163 §Observability names its own examples of the gap: _"a subagent that writes via `python -c`, a
heredoc, `tee`, `sed -i`, or an MCP filesystem tool produces no `actor.subagent_write` row at all."_
Measured, **three of those five are caught**:

- `tee` — caught (explicit pattern)
- `sed -i` — caught (explicit pattern)
- heredoc — caught, both `cat > f <<EOF` and `cat <<EOF > f` (the redirect is visible)
- `python -c` — **miss, confirmed**
- MCP filesystem tool — see below; not a `Bash` question at all

The ADR was simultaneously **pessimistic about shapes it does catch** and **silent about the four
groups above**. Corrected in the ADR alongside the number.

## Two things this arm did NOT measure, stated plainly

**1. Pipeline recall — deliberately not run, because the rule forbids the apparatus.** ADR 163's
pre-registration says to _"deliberately have a subagent write through 3–4 non-obvious paths."_ Doing
that means spawning a subagent that writes, which is exactly what the global operating rule prohibits
("never spawn an agent that writes"). Running it would have broken the rule whose compliance the parent
experiment measures, and contaminated that week's own audit stream with deliberate violations
indistinguishable from real ones.

So what is measured here is **detector recall** — a pure function of the command string, which is what
the ADR actually cites — and **not** end-to-end pipeline recall (does the hook fire, does `agent_id`
arrive, does the row land). Those are covered by inc 1's integration tests for the paths they cover, and
unmeasured beyond that. **This is a real, named gap, not a completed arm.**

**The gap is measurable later, and should not be filed as intrinsic** (stanley's correction to an
overstatement in the first draft of this finding). The blocker is not that a writing subagent is
unusable — it is that its rows would be **indistinguishable from real ones** in the stream arm 1 reads.
Contamination is a labelling problem, not a physical one: a `synthetic: true` marker in the audit
detail, or a fixture team the analysis excludes by construction, makes seeded and real rows separable at
read time. With that in place a subagent can be spawned deliberately, under the rule's own exception for
measurement, and pipeline recall becomes an ordinary number. That is a later increment; until it runs,
**the 68% bounds the matcher, not the plumbing**, and no count may be read end-to-end.

**2. MCP filesystem tools.** `isWriteShaped` matches `WRITE_SHAPED_TOOLS` by exact name plus the `Bash`
heuristic, so a write through an MCP server's own file tool (`mcp__…__create_file`,
`mcp__…__content_modify`, and the several such tools live on this machine) is **structurally invisible** —
not a heuristic miss but outside the matcher's domain entirely. Not folded into the recall figure,
because it has no denominator: the population of MCP write tools is open-ended and per-install. Flagged
as a separate hole that a count cannot bound.

## How the number should be cited

> At least N, where the detector's measured recall on a 40-command corpus is 68% (0 false positives),
> concentrated-miss profile: interpreter indirection, script/build delegation, archive extraction,
> tool-flag in-place writes, and outward writes. MCP filesystem writes are outside the instrument
> entirely.

**Do not** invert 68% into a point estimate of true volume. Recall here is over a **hand-built,
unweighted** corpus, so it measures the detector against a spread of shapes, **not against real
traffic**. Turning it into a multiplier would require weighting each shape by how often agents on this
team actually use it, which nobody has measured. `N × 1.5` is a plausible order-of-magnitude, not a
result.

## Limits

- **n = 40 commands, one author.** Selection bias is mine: I chose the corpus, including the misses,
  and a corpus chosen by someone who has read the regex list is not a random sample of agent behaviour.
- **Unweighted** — see above. This is the single biggest caveat.
- **One platform** (macOS, bash 3.2, GNU/BSD tool mix). `sed -i ''` is BSD-shaped; a Linux box would
  need re-running, though the four miss groups are structural rather than platform-specific.
- **9 of 40 not executed** — outward or environment-mutating commands (`git push`, `npm publish`,
  `curl`, `ssh`, `docker`) are labelled by inspection and reported separately, never silently pooled.
- **Detector recall only**, not pipeline recall. See above.

## Bearing on ADR 163's sequencing

The compliance arm can now be interpreted, with a stated error bar, which was the gate. Increment 2
(the spawn→write model join) remains correctly unbuilt and gated on the compliance number. One
sharpening this arm adds: a near-zero compliance count should now be read against a **concentrated**
blind spot rather than a diffuse one — if the team's subagent writes happen to run through scripts,
builds, or interpreters, a zero is close to uninformative, and the honest next move would be closing the
four groups rather than reading the zero.
