# Running the gates locally

CI's `gates` job is install → build → typecheck → lint → coverage → format:check, in that order — running a subset and calling it green is the classic red-CI cause, and grepping a gate's output instead of trusting its exit code has lied at least once.

## The order is load-bearing (2026-07-13, #246/#250; falsify: lint a fresh clone pre-build)

`build` must precede `typecheck` AND `lint`: eslint's import resolver follows workspace packages to their `dist/`, so linting pre-build yields ~9 phantom `import/order` errors from unresolved `@musterd/*`. `format:check` chains all the doc gates (obs-evals, vocab, adr-numbers, roadmap, guidance, arch-trees, wiki — see [shipping-a-pr](shipping-a-pr.md)); every ADR ≥ 060 needs an `## Observability & Evaluation` section answering Traces / Eval / Experiment. `roadmap:gen` output is not prettier-stable — generate last, don't prettier it. Root `pnpm test` is the gate, not `pnpm -r test`.

## Never grep a gate's output (2026-07-13, PR #268)

Grepping `pnpm lint` output for "problems" missed eslint's singular "✖ 1 problem" and reported success while CI failed. The gate ran fine; the filter lied. Chain on exit codes: `pnpm build && pnpm typecheck && pnpm lint && ...`.

## A stale dist/ makes you blame someone else's merged code (twice by 2026-07-13; falsify: clean rebuild)

Cross-package imports resolve to `dist/`, so a stale build lies two ways, neither looking like a build problem: typecheck reads stale sibling `.d.ts` (phantom errors in files you never touched), and runtime/tests read stale sibling zod schemas that silently strip new fields (plausible wrong values, not import errors). `pnpm build` is not always enough — incremental tsc can skip a package. When cross-package behavior looks broken after syncing main: delete the package dists and rebuild, and never blame a teammate's merged PR before reproducing on a clean rebuild. Both times main was green.

## Two noises under load that are the runner, not a test (2026-08-12; falsify: rerun the named file alone)

On a busy machine the CLI suite can emit a spurious `[vitest-worker]: Timeout calling "onTaskUpdate"` — that is vitest's own worker RPC timing out, not a test failure; the verdict lines above it are still authoritative. Related but distinct: `pnpm -r test` intermittently fails 3–13 CLI tests (`service`/`inbox`/`archaeology`) that pass in isolation and under `pnpm coverage` — parallel-run spawn starvation (see #782: a test 10× under its cap failing at load 17.9). `pnpm coverage` is the real CI gate; chasing either noise as a defect has wasted sessions.
