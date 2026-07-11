# 130 — Daemon build provenance: `/health` names its commit, `service status` names the skew

- Status: accepted
- Date: 2026-07-11
- Builds on: [ADR 118](118-service-refresh.md) (`service refresh`), [ADR 045](045-service-lifecycle-launchd.md)
  (service lifecycle), [ADR 016](016-db-visibility-and-join-failure-surfacing.md) (health visibility)

## Context

The dogfood daemon runs from the dist of a checkout kept on a **detached HEAD** (deliberate — the
`agents-*` worktrees hold the branches). ADR 118 already shipped the actuator: `musterd service
refresh` syncs that checkout to `origin/main`, rebuilds, and restarts behind the live-session guard.

What is missing is the **detector**. On 2026-07-11 the daemon served code from a day before ADR 125
while the roadmap said "shipped": `git pull` in the detached checkout was a silent no-op, nothing
compared the running daemon to `origin/main`, and the gap was only found because a feature's metrics
were visibly absent from `/report`. "Shipped on main" and "running on the daemon" can drift apart
with no check — the operator has to _notice_.

## Decision

Two small, additive pieces — the daemon states what it runs; `status` states how far behind that is.

1. **`/health` gains `build`** — the commit the daemon booted from. `musterd serve` resolves it once
   at boot (`git -C <repoRoot> rev-parse HEAD`, repo root derived from the CLI entry path, exactly as
   `service refresh` locates the checkout) and passes it into the server config as `buildRef`. Not a
   wire/SPEC change — `/health` is the unversioned ops surface (ADR 016) and the field is additive.
   A daemon not running from a git checkout (npm install) simply omits it.

2. **`musterd service status` compares and warns.** When `/health` carries `build` and the service
   checkout is a repo: best-effort `git fetch origin main --quiet`, then
   `git rev-list --count <build>..origin/main`. Behind by N ⇒ one warn line naming the fix:

   ```
   build:  38edb9b — ⚠ 3 commit(s) behind origin/main — run `musterd service refresh`
   ```

   In sync ⇒ `build: 7757d2c · up to date with origin/main`. Offline / fetch-failed / unknown commit
   (e.g. history rewritten) degrade to printing the build ref with no verdict — the check must never
   make `status` fail (watcher, never gatekeeper). The boot-time ref means a rebuilt dist under an
   un-restarted daemon still reports the _old_ commit — which is precisely the truth the operator
   needs (`restart` is the missing step, and `refresh` covers both).

Non-goals: auto-refresh on merge (bouncing a shared daemon under live seats is a human call — the
ADR 047 guard exists because exactly that went wrong before); stamping dist at build time (boot-time
`rev-parse` is simpler and can't drift from what actually booted); surfacing skew on every CLI
command (status is the "how is the service" verb; a steward-seat task may later watch it).

## Consequences

- The detached-HEAD checkout stays (it is load-bearing for the worktrees); its failure mode — silent
  staleness — is now named by the tool that manages the daemon.
- `service status` may do one network `fetch`; kept best-effort with the same short-timeout posture
  as its health probe.
- A future steward task can read `/health.build` vs `origin/main` and open a nudge issue — the
  provenance field is the seam.

## Observability & Evaluation

**Traces** — none new: `/health` is polled, not traced; the field rides the existing endpoint.

**Eval** — _skew visibility_: with the daemon deliberately started on `HEAD~1`, `musterd service
status` must print the behind-by warning naming `service refresh`; with daemon = `origin/main` it
must print "up to date". Dataset: the two unit fixtures (injected runner + health) covering behind /
in-sync / no-build / fetch-failure. Baseline: before this ADR, `status` printed no build information
at all (the 2026-07-11 incident: one full day of skew, discovered only via a missing report field).

**Experiment** — dogfood: after the next few merges to main, check that the operator (or steward)
acts on the warn line rather than rediscovering skew forensically; if the warn is routinely ignored,
consider promoting the check into the SessionStart verify hook (ADR 060) as a follow-up.
