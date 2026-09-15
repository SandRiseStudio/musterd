# 280 — The evidence base lives on one laptop: snapshot it before anything is built on it

- **Status:** accepted 2026-08-18
- **Deciders:** dolly (found it while inventorying the corpus for the positioning work), nick
  (authority on where an off-machine copy lands, and on the spend that implies)
- **Relates to:** ADR 056 (research as first-class practice — still `proposed`, and this is one of
  the things it never covered), ADR 184 (dataset consent and redaction — the PUBLIC artifact, which
  this deliberately is not), ADR 166 (the sweep series this preserves), ADR 082 (the OTLP capture
  behind findings 002 and 005), ADR 122/123 (the cookoff results behind findings 006 and 007)

## Context

musterd's research practice has produced eight numbered findings, a frozen cookoff apparatus, a
pre-registered evaluation arriving on 2026-09-12, and a stated artifact ladder whose first rung is a
published dataset. Every number in all of it derives from data held in exactly two directories on
one machine:

```
~/.musterd/          musterd.db (16 MB, schema v41), the ADR 166 sweep series (48 MB),
                     the OTLP sink capture (12.6 MB), the structured HTTP log (13.1 MB)
~/cookoff-run/       19 per-cell daemon DBs (3.8 MB) beside 28 git clones (4.2 GB)
```

None of it is versioned. `git ls-files` returns no `.db`, `.jsonl`, `.ndjson`, or `.parquet`
anywhere in this repo — the only committed structured data are three small JSON config files. The
newest snapshot in `~/.musterd/backups/` is dated **2026-06-29**, which predates the flagship
cookoff, every wake-pricing row, the per-edge firing ledger, and ADRs 250 through 279. So the
backup that exists restores a musterd whose evidence base is two months and roughly 4,000 acts
short of the one the findings describe.

The exposure is not hypothetical in the ordinary way. It is _specifically_ the exposure of a
programme whose next three lanes — the ADR 184 dataset export, the cookoff pilot rungs, the 30-day
memory evaluation — all read from, or write into, the one copy.

**What made this look like somebody else's problem.** The corpus reads as ~4.3 GB, which sounds
like an infrastructure project with a storage bill attached. Measured 2026-08-17, that number is
almost entirely chaff: 4.2 GB of it is 28 git clones of the cookoff fixture, each ~50 MB, all
regenerable from `SandRiseStudio/cookoff-scenario`. The irreplaceable remainder is **94 MB**, and it
compresses hard — the sweep JSONL alone goes 48.3 MB → 610 KB (79×), because it is 4,714 near-
identical fleet snapshots. A full capture of everything that cannot be regenerated is **5.7 MB and
2.7 seconds** (measured, this machine, 2026-08-18).

That reframing is the whole decision. At 4.3 GB you argue about retention policy and where to put
it. At 5.7 MB you keep every snapshot forever and stop thinking about it.

## Decision

1. **`pnpm corpus:snapshot` captures the irreplaceable corpus into one dated, checksummed,
   self-describing directory.** `scripts/corpus/snapshot.ts`. Each artifact is gzipped and carries
   a SHA-256 in `MANIFEST.json`, alongside a `why` string explaining what the file is — so a bare
   archive directory found later, without this repo, is still interpretable.

2. **Live SQLite is captured with `VACUUM INTO`, never a file copy.** A database with a hot WAL
   cannot be copied consistently: the copy lands mid-transaction and the WAL it needs is a separate,
   still-moving file. `VACUUM INTO` takes a consistent point-in-time image in one statement from a
   reader's snapshot, without stopping the daemon or checkpointing anything under it. The daemon
   stays up during a snapshot; that is a requirement, not a bonus, because a rail that requires
   downtime will not be run.

3. **The restore is drilled, not assumed.** An untested backup is not a backup. Drilled 2026-08-18
   against the live corpus: `PRAGMA integrity_check` → `ok`; row counts identical across `messages`
   (5,518), `audit` (11,028), `lanes` (541), `tool_call_stats` (3,440), `wake_leases` (310),
   `members`, `seat_memory`; `schema_version` 41 preserved; the sweep series restored at 4,714 lines
   with the tail still parsing as JSON. The restored DB is _smaller_ than the live one (15.56 vs
   16.05 MB) because `VACUUM` reclaims free pages — a size mismatch is expected here and is not a
   defect signal.

4. **The script writes locally and uploads nothing.** Where the off-machine copy goes is nick's
   call, and it needs to be an explicit one: this archive is the PRIVATE raw corpus. It contains
   agent prose, human asks, and machine paths — precisely the material ADR 184 decided is _not_
   publishable on operator consent alone. A rail that helpfully pushed it somewhere would be that
   ADR's failure mode wearing a backup's clothes. The run ends by printing that the snapshot is
   still on the same disk as its source.

5. **Skip the reproducible.** The 28 cookoff clones are not captured; the 19 daemon DBs beside them
   are. The lister is `find -maxdepth 1 -name '*.db'`, so a 50 MB clone one level down cannot be
   swept in by accident — this is asserted in the tests, because the cheap failure mode of a
   "capture the research directory" rail is a 4 GB archive nobody keeps.

6. **The run aborts below 500 MB free swap** unless `--force`. `docs/wiki/nicks-laptop.md` records
   the standing constraint; free swap was 551 MB while this was being written, so the floor is a
   live guard rather than a formality.

## Consequences

- Every subsequent research lane can be told to snapshot first. The dataset-export lane
  (`01M091J5CW…`) and the cookoff pilot lane (`01M091JGGV…`) already carry a formal `depends_on`
  this work, which is the board enforcing "never export from, and never pile results onto, the only
  copy."
- The corpus is preserved but **not yet off-machine** — item 4 is deliberately a human decision, so
  until nick names a destination this ADR has reduced the exposure from "one disk, two months
  stale" to "one disk, current". That is a real improvement and an incomplete one, and it should be
  read that way.
- There is no scheduled run yet. Adding a LaunchAgent is a one-line follow-on
  (`musterd service install` already owns six of them) but it is a different decision: a timer that
  writes 5.7 MB a night is trivial, a timer nobody reads is the failure ADR 166 names twice and
  `docs/wiki/instrument-silence.md` generalises. Scheduling should come with the read.
- The snapshot format is dumb on purpose — gzipped files and a JSON manifest, no archive container,
  no incremental chain. Restoring needs `gunzip` and nothing else, including in five years when this
  script does not run.

## Observability & Evaluation

**Traces.** None added, and none warranted. This runs outside the daemon, touches no seat, no lane,
and no team; it reads files and writes files. Its own record is the dated snapshot directory and its
manifest — which is the honest instrument here, since the thing to observe is "does a current
snapshot exist", answerable by `ls`.

**Eval.** The claim is that the rail captures everything irreplaceable and that what it captures
restores. Both were verified at merge, above (§3), against the live corpus rather than a fixture.

The live falsifier, and the one to actually watch: **a new instrument starts writing somewhere the
manifest does not name.** The source list in `snapshot.ts` is hand-maintained, so it is exactly as
current as the last person who added a data-producing script remembered to update it. The failure is
silent by construction — the snapshot succeeds, the manifest looks complete, and the new series is
simply absent. Check when the next instrument lands; the cheap structural fix, if it fires, is for
the sweep-style scripts to declare their output path in one shared place that both they and this
script read. That is deliberately not done now: with three producing instruments it would be
ceremony, and the coupling is worth buying only once it has been paid for by a real miss.

A second, weaker falsifier: the 79× compression ratio is a property of _this_ corpus (repetitive
JSONL, an append-only log). A future corpus of audio, embeddings, or already-compressed artifacts
would break the "5.7 MB, keep everything forever" economics that justify skipping retention policy
entirely. Re-measure before assuming the cheapness generalises — the sibling corpus at
`/Users/nick/sandrise` is 4.99 GB of MP3 and will not compress at all.

**Experiment.** None. The alternative was measured rather than hypothesised: the arrangement in
place was "one copy, last snapshot 2026-06-29," and its outcome is the two-month hole this ADR
exists to close.
