# 224 — Size-capped service logs

- **Status:** accepted
- **Date:** 2026-08-04
- **Owner:** izzo
- **Supersedes / relates to:** ADR 118/130 (the auto-refresher that now runs the trim), ADR 132 (the /live publisher's log), ADR 162/190 (machine-state isolation, which shapes the blast radius here)

## Context

Every musterd LaunchAgent writes to a `StandardOutPath` and nothing has ever trimmed one. Measured
on the dogfood machine, 2026-08-04:

| log                       | size    |
| ------------------------- | ------- |
| `daemon.log`              | 34.0 MB |
| `otel-sink.log`           | 10.6 MB |
| `live/build.log`          | 4.6 MB  |
| `autorefresh/refresh.log` | 0.6 MB  |
| `broadcast.log`           | 0.5 MB  |

~50 MB of append-only history with no upper bound and no policy. On a laptop that is not a disk
problem, and framing it as one is what has kept it unowned. The actual cost is forensic: these logs
are the **only** record of what the unattended agents did on this machine — the auto-refresher's
decisions, the wake actuator's spawns, the daemon's request log. An unbounded file is one that
eventually gets `rm`'d by hand, in a hurry, at exactly the moment somebody needed to read it. We
just lived a small version of that: #631 was diagnosed by reading code because the log that should
have answered it was unreadable in practice.

A retention policy is a decision — how much history is the machine obliged to keep? — so it belongs
in an ADR rather than in whatever number one of us typed into a constant.

## Decision

**Two generations, 8 MB each, per service log.** When a log exceeds the cap it is copied to
`<name>.1` and truncated in place; the live file then opens with a one-line marker naming what
happened and where the history went. Worst case per log is therefore `2 × cap`, and the machine's
total is bounded by the length of an explicit list rather than by how long the daemon has been up.

Three properties are load-bearing, and each is the reason a more obvious design was rejected:

**Copy-truncate, not rename.** The conventional rotation — rename the file, let a new one appear —
does not work for a launchd-managed log. The writing process holds an fd to the _inode_, so after a
rename the daemon goes on writing into `daemon.log.1` forever while the fresh `daemon.log` stays
empty. Copy first, then truncate the original the writer is still holding.

**Truncating a live log is safe here, and that was measured rather than assumed.** launchd opens
`StandardOutPath` with `O_APPEND`, so a write after truncation lands at offset 0 instead of at the
writer's stale offset. Verified with a throwaway LaunchAgent appending once per second: truncate the
file mid-stream, and four seconds later it was exactly 64 bytes — four clean lines, no sparse hole,
no NUL padding. Had the flag gone the other way, this same trim would have punched a 34 MB hole in
the log and left the machine worse off than doing nothing at all. It is written down here because
the next person to touch this will have no way to re-derive it from the code.

**An explicit list of logs, never a `*.log` glob.** The musterd home is `dirname(configPath())`,
which is `~/.musterd` in production but a _shared system temp directory_ under the ADR 162/190 test
isolation. A recursive glob there would have truncated whatever unrelated `.log` files another
process happened to leave in `/var/folders/…/T` — a test suite that silently eats other programs'
data. Trimming only names musterd itself writes keeps the blast radius to musterd's own output. The
cost is that a new LaunchAgent must add its log to `SERVICE_LOGS`; that is the right trade, and it
sits beside the plist builder that creates it.

**The auto-refresher runs it**, at the top of every tick, before the skew check and independently of
it. The logs grow from the daemon's own traffic rather than from refreshes, so a machine that is
perfectly up to date is precisely the one whose logs nobody would otherwise be bounding. Cost when
there is nothing to do is one `stat` per name.

`MUSTERD_LOG_CAP_MB` overrides the cap; `0` disables trimming outright, for an operator who would
rather keep everything than have a policy applied to them.

## Consequences

- History older than ~2 caps is gone. That is the point — it is a _bound_, not an archive — but it
  means anyone who wants deep history must raise `MUSTERD_LOG_CAP_MB` **before** the fact, not after.
- A trim is visible: the live log opens with the marker line, and the auto-refresher's own log
  records the trim (timestamped, per ADR 224's sibling #632). A log that silently loses its history
  is indistinguishable from one that was never written to.
- Copying an over-cap file costs a moment of I/O on the tick that crosses the threshold. At an 8 MB
  cap and a 2-minute cadence this is rare and small; a much larger cap would make it rarer and
  bigger, which is the correct direction for an operator who chooses it.
- A `.1` is never itself rotated. Retention stays at two generations rather than growing a
  `.1.1.1` chain.

## Observability & Evaluation

**Signals**

- Each trim writes a marker line into the trimmed log (`trimmed by musterd: N MB exceeded the M MB
cap`) and a stamped `✓ trimmed <path> — N MB over the cap` line into `autorefresh/refresh.log`.
- The absence of trim lines over a long window is itself a signal: either the caps are generous
  relative to real volume, or the tick is not running (which ADR 118/130's own liveness covers).

**Evaluation** — re-measure `~/.musterd` after two weeks of normal dogfood operation:

- **Pass:** no log exceeds `2 × cap`; `daemon.log` is bounded; and every trim that occurred is
  accounted for by a marker line, i.e. no history vanished without saying so.
- **Fail (revisit the cap, not the mechanism):** trims happen so often that the useful window is
  shorter than the time it takes a human to notice a problem and go read the log — measured as: a
  question about agent behaviour from the last 24h that the log can no longer answer. The dogfood
  cadence makes 8 MB roughly a week of `daemon.log` at current volume; if that turns out to be a
  day, the number is wrong.
- **Fail (revisit the mechanism):** any report of a sparse/holed log, or of a log that stopped
  growing after a trim — both would mean the `O_APPEND` finding does not hold on some path, and the
  trim must then stop truncating live files.

## Alternatives considered

- **`newsyslog`** — the macOS-native rotator, and the "correct" answer on paper. Rejected: its conf
  lives in `/etc/newsyslog.d`, so `musterd service install` would need `sudo` to set up log
  rotation. Requiring root to bound a log file in the user's own home is a worse trade than 40 lines
  of copy-truncate, and it would not work at all for the non-macOS backends ADR 130 anticipates.
- **`logrotate`** — not present on macOS by default; same root-ish problem, plus a dependency.
- **A rotation daemon of our own** — another LaunchAgent, another thing to be found dead. The
  auto-refresher already runs every two minutes and already owns "keep this machine's musterd
  healthy"; log hygiene is that job.
- **Doing it in the daemon** — only bounds the daemon's own log, and does nothing for the agents
  whose logs (`build.log`, `refresh.log`) grow while the daemon is idle.
