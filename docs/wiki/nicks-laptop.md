# nick's laptop — constraints and load-bearing services

The machine every seat shares is an 8 GB / 8-core MacBook that lives in swap — check `sysctl vm.swapusage` before any capture, probe, or many-process run, and never remove a service without checking `~/Library/LaunchAgents` first.

## The hard constraint (standing, re-measured 2026-07-29 at 7.0/8.2 GB swap used; falsify: sysctl vm.swapusage)

nick has said explicitly: do not crash the machine. Before any resource-heavy run: check swap, ask him to close Chrome if needed, bound the run (`--duration`), abort below 500 MB free swap. Launching 12 seats at once crashed the machine once — stagger. Spawn-heavy test suites time out on load spikes, not defects (see #782, load 17.9): the answer is suite concurrency, not per-test budget bumps.

## Load-bearing — do not remove (inventoried 2026-07-10; falsify: ls ~/Library/LaunchAgents + live ports)

Local Postgres 17 + Redis (amprealize pipelines target them), `~/MoveTrail` incl. the locally-trained `scam_model` binary (NOT in git, retrained by LaunchAgents), `~/Ring` (jobsearch LaunchAgent), ollama qwen3:4b (dogfood fixture — never re-pull casually). Removed in the 2026-07-10 cleanup rounds (7.6 → 45 GB free): simulator runtimes, caches, podman VM; a SIP-restricted 17 GB orphaned simulator-runtime asset is removable only via the Settings GUI.

## Sampling gotcha

`ps -Ao pcpu,comm` with a `chrom` pattern matches nothing useful on macOS (comm is a full path) and cannot separate a capture's Chrome from nick's browsing Chrome — use `ps -Ao pcpu,rss,command` and treat totals as upper bounds.
