# /live web performance — the arc, the gate, the measurement traps

The 2026-07 perf arc took /live from Lighthouse 49 → 85 (transfer 1077 → 381 KB, DOM 4461 → 1564) and its ranked backlog is EXHAUSTED — the numbers live in docs/perf/web-live-baseline.md, and `pnpm perf:check` (ADR 151) gates the budgets in CI.

## The gate (ADR 151, #333)

`docs/perf/budgets.json`: total JS gzip, per-chunk, CSS, font bytes, font-family allowlist — baselines + 10 % headroom. Raise protocol: the increase goes in the same PR that needs it, with the measured cost appended to the baseline doc's optimization log. `perf:check` needs `pnpm build` first (dist is gitignored). `packages/web/AGENTS.md` carries the non-machine-checked contract (suspend unseen rAF loops, windowed lists, canvasFont tokens).

## Don't re-chase (findings that corrected the doc, 2026-07-19)

- "Entry chunk shares marketing code" — false; the entry is React 19 + TanStack runtime. Parked.
- `content-visibility: auto` on stream rows drifts placeholder sizes after manual anchoring — measured 3082 px; don't reintroduce.
- The "~1 s backfill long task" was one-run variance; the real cost was DOM weight (94 % of nodes), fixed by windowing (#328).

## Measurement traps (falsify: re-run scripts/perf/live-baseline.mjs)

- Never restart the shared daemon — measure on a temp daemon over a `.backup` DB copy (see [temp-daemon-probe](temp-daemon-probe.md)).
- `/live?team=...` measures the CONNECTED page; without `?team` you get the shell, 2× lighter.
- `.musterd/binding.json` embeds `server:` and OVERRIDES `MUSTERD_CONFIG` — a CLI probe run from a worktree posts to prod; probe from a scratch dir with a rewritten binding.
- Lighthouse single runs are noisy (±7); median of 3. CDP `Network.*` timestamps are monotonic, not epoch. CLI `send` costs 650–920 ms of Node startup — never read CLI-bounded latency as transport latency.
- Presence on a DB copy decays in ~45 s, so an office on a temp daemon self-parks — send a probe act to make the room alive before measuring; and vite preview caches dist, so restart it after EVERY build or you measure blank pages.
