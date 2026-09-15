# The perf gate's two blind spots

`pnpm perf:check` measures a dist it did not build, and a PR that reads exactly at budget on its own gates will read over on main — both cost the team a red main and three PRs' worth of gates on 2026-09-01, and neither is a bug in the gate.

## Blind spot 1 — `perf:check` does not build (2026-09-02; falsify: run `pnpm perf:check` twice around a web change without rebuilding and watch the number not move)

`scripts/perf/check-budgets.ts` reads `packages/web/dist/client` and nothing else. It never invokes
the web build. A reading taken without `pnpm --filter @musterd/web build` first is the *previous*
tree's dist, and it looks exactly like a real reading — same format, same confidence. The script
warns only when `dist/client` is *missing* ("run `pnpm build` first"); a stale one passes silently.

The measured instance (miley, 2026-09-02, lane `01M1FZV07M3K3WAKB0D1239C1H`): two commits 243 B
apart (`d7cb401c` and `5cc8aa68`) both read 155,964 B, a fake 0 B delta, because the second reading
was the first commit's dist. The true numbers were 155,721 B and 155,964 B, which is the whole
story of why main went red (below).

The dist-freshness gate that protects `typecheck` ([running the gates](running-the-gates.md))
works by comparing a package's `src` against the ADR 135 stamp in its `dist/build.json`.
`check-budgets.ts` does no such comparison: it opens `dist/client`, gzips what it finds, and
reports.

**Rule:** a hand measurement is `pnpm --filter @musterd/web build && pnpm perf:check`, always as
one command. A number quoted without the build in front of it is not a measurement.

## Blind spot 2 — a PR at exactly N KB / N KB on its own gates reads over on main (2026-09-01; falsify: the `gates` run on `db1099de` is green)

CI's gzip output is not the laptop's. The `$comment` in `docs/perf/budgets.json` has recorded the
delta since 2026-08-24 as "~0.7 KB higher on CI" — but it is a different *build output*, not a
different gzip level: on the same commit the initial JS reads higher on CI and the app CSS reads
lower (CI 22.0 KB, local 22.1 KB). The divergence is larger than the headroom the gate defends
when a ceiling is nearly consumed.

The measured instance: #1158 (lapsed asks) passed its own gates at 152.3 KB against a 152.3 KB
budget. Merged as `db1099de`, main's gates read 152.4 KB and went red, taking every PR rebased on
it with them (#1155 at `0540ee3f` with no web change, #1160, #1167). #1158 had cost 243 B against
279 B of headroom. Nobody checked the budget at review time, because the PR's gates were green,
which is the point: **green at N/N on a branch is not green on main.** The same shape recurred
in review of the repair itself — the reclaim in #1168 reads 150.9 KB / 150.9 KB locally with the
board shell put back eager, which CI would refuse and a laptop would pass.

**Rules:**

- A reviewer of any web change reads the `perf:check` line in the gates log, not just the tick.
  A reading within ~1 KB of a ceiling is a finding, not a pass.
- A ceiling with under 1 KB free is a coin flip against CI for the next change. Raise or reclaim
  *before* the change that trips it, per ADR 183's ritual — the 2026-08-25 and 2026-08-31 entries
  in `docs/perf/web-live-baseline.md` are both this, caught late.
- Reclaim beats raise when the route carries something that was supposed to be lazy. #1166 raised
  the ceiling as triage (correct: main was red); #1168 repaid it 14× over by making the
  `BoardOverlay` shell lazy, which its own header had claimed for weeks. Read the headers of the
  eager graph before reaching for the budget file.

## Related

- [running the gates](running-the-gates.md) — the stale-dist trap on the typecheck side, which
  this page's first blind spot is the web-build twin of.
- [correct by coincidence](correct-by-coincidence.md) — a branch gate that agrees with main until
  the day it does not.
- `docs/perf/web-live-baseline.md` — the dated ledger of every budget move, including the
  2026-09-01 raise and the 2026-09-02 repayment this page is drawn from.
