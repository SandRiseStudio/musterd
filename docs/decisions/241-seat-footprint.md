# 241 — The daemon knows what a seat costs: footprint sampling, honest attribution, allowlist-only reaping

- Status: accepted
- Date: 2026-08-05
- Deciders: nick, kimi
- Relates to: ADR 131 (harness residency — parked seats are the demand side of this measurement),
  ADR 040 (one team = one daemon — the daemon's db as the machine's ledger), ADR 148 (calm surfaces
  that never cry wolf), ADR 225 (one predicate, two consumers)

## Context

On an 8 GB laptop, three concurrent musterd agents ran smoothly, four slowed the machine, five
brought it near a standstill. Measured 2026-08-05 (`docs/perf/seat-footprint.md`): swap at 10.1 GB
of 11.3 GB, 256 agent-stack processes, and **~15 copies of every configured MCP server** — 213
sidecar processes for 3–5 nominal agents, because every session inherits the user's global MCP
list and the desktop app keeps every session's stack alive, closed tabs included.

The measurement overturned the design's first assumption twice:

1. **The "orphans" are not orphans.** Zero sidecars were reparented to launchd; all 198 duplicated
   stacks were live children of the Claude desktop app process. Quitting the app reclaimed **~9 GB
   of swap** in one move (swap 9.9 → 1.0 GB, the swapfile pool itself shrinking 11.3 → 2 GB).
2. **Not spawning is the whole game.** Emptying the _global_ MCP config (musterd stays per-project)
   cut sidecars 212 → 34 at equal session count. Stacks held inside a live app cannot be safely
   reaped from outside; the only durable fix is a config that doesn't spawn them.

The coordination layer knew every seat, session, and lane on the machine — and nothing about what
any of them cost. Nobody chose the 213-process state; it accumulated silently, exactly the failure
mode ADR 148 retired for build skew.

## Decision

1. **The daemon samples the machine's footprint** — a periodic tick (default 60 s,
   `MUSTERD_FOOTPRINT_INTERVAL_MS`) beside the presence reaper: one `ps` scan, sidecar processes
   matched against an **allowlist of MCP-server command patterns**, grouped into stacks by nearest
   non-sidecar ancestor, classified `live` / `orphaned` (reparented to launchd) / `unattributed`.
   One machine row per tick: swap used/total, free memory. Persisted to `footprint_stacks` +
   `footprint_machine` (migration v34), pruned past `MUSTERD_FOOTPRINT_RETENTION_MS` (default 7 d)
   each tick so the table bounds itself. Darwin first; the scanners throw on any other platform and
   the sampler degrades to a skipped tick with one log line — never a crashed daemon.

2. **Attribution is honest or absent.** Stacks carry `seat: null` in this increment. The desktop
   app parents every session's sidecars itself, so a per-session boundary does not exist in the
   process tree (measured, finding 2), and per-seat attribution via `lsof` cwd resolution is a
   per-tick cost that deserves its own measurement before it ships. An `unattributed` stack is
   shown as such, never guessed onto a seat (ADR 169's absent-vs-unknown).

3. **Read surface:** `GET /teams/:slug/footprint` returns the latest tick, 404 while none exists —
   a fresh daemon, a pre-v34 db, or a non-darwin host all read as "no data", and clients treat any
   non-200 the same way, which is also the older-daemon compatibility story. The doctor
   (`musterd init --check`) rides it with a warn-only note naming orphaned procs and their RSS;
   silence when the daemon is unreachable or reports none — the doctor reports facts, it never
   invents drift.

4. **Reaping is explicit, allowlist-only, and re-verified at kill time.**
   `POST /teams/:slug/footprint/reap { pids }` is the daemon's only kill path. A pid is killed only
   when, re-scanned at kill time, it still exists, still matches the sidecar allowlist, and is
   still orphaned; anything else is refused with a named reason (`not_found` / `not_sidecar` /
   `not_orphaned`) — a stale sample must never kill whatever now wears the pid. SIGTERM, a grace
   (default 3 s), SIGKILL for survivors, and one `footprint.reaped` audit row recording exactly
   what the verification let through. Nothing is ever blocked or auto-killed: warn-never-block,
   same as lanes.

5. **The eval loop is standing.** `scripts/perf/seat-footprint.mjs` is the reference
   implementation of the classification rules (the server port must stay pattern-identical) and
   the measurement harness; results append to `docs/perf/seat-footprint.md`. Thresholds for any
   future warning or admission-control surface come from those curves, not guesses.

## Consequences

- The roster/status surfacing (per-seat cost chips, a machine line) and `musterd reap` in the CLI
  are follow-on increments on this substrate; the /live chip is reserved data (frontend is miley's).
- Admission control ("the board knows the machine is full") is future work and ships only after
  this sampler's curves set honest thresholds — a gate priced on guesses is what ADR 150 warns
  everyone routes around.
- Lean provisioning by default (a seat spawns its role's servers, not the world) is the durable fix
  the Phase 0 diet points at; recorded as future work with ADR 027/144 as the machinery.
- Cloud/off-machine seats are the scale story past one machine's ceiling (ADR 039/040 off-loopback
  bind); out of scope here.

## Observability & Evaluation

- **Traces:** orphan-proc count over time and per-classification RSS (`footprint_stacks`), machine
  swap/free curves (`footprint_machine`), `footprint.reaped` audit rows (killed/refused/rss_kb),
  and `footprint_skip` log lines when a tick could not sample.
- **Eval:** dataset = the appended snapshots in `docs/perf/seat-footprint.md`; baseline = the
  2026-08-05 pre-diet measurement (swap 9.9/11.3 GB, 212 sidecar procs in 15 stacks). The 5-seat
  stagger test (probe every ~5 min while five seats work) re-runs after each increment; pass =
  swap stable and UI responsive. The ~9 GB swap return and the 212→34 sidecar cut are the recorded
  Phase 0 wins this ADR's surfaces exist to keep won.
- **Experiment / falsifier for decision 2:** if orphaned stacks recur with sessions running in
  terminal harnesses (which do parent their own sidecars), per-seat attribution becomes measurable
  and the `seat: null` floor should be revisited.
