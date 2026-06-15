# 013 — Coverage gates wired; cli/mcp enforced as ratchet floors

- Status: accepted
- Date: 2026-06-15

## Context

`06-testing.md` "Coverage gates" documents per-package line thresholds — protocol ≥95%, server ≥85%, cli + mcp ≥75% — but they were never wired into vitest (noted as a known drift in `implementation-plan.md` §3 and a §4.C hygiene item). Tests passed; coverage was unmeasured.

## Problem

Measuring actual line coverage (v8 provider, `packages/*/src/**`, excluding tests and pure barrels) shows:

| Package | Lines | Documented gate |
|---|---|---|
| protocol | ~100% | ≥95% ✅ |
| server | ~86% | ≥85% ✅ |
| cli | ~44% | ≥75% ❌ |
| mcp | ~57% | ≥75% ❌ |

protocol and server already meet their targets. cli and mcp do not: the gap is concentrated in the interactive `@clack`-driven onboarding wizard (`cli/src/onboard`, ~19%) and the MCP tool handlers (`mcp/src/tools`, ~39%) — surfaces that need behavioral tests against stdio/prompt I/O, a meaningful effort beyond a hygiene pass. The plan's §4.C item sanctions "wire coverage and **either enforce or amend** the gates."

## Decision

Wire vitest coverage (root `vitest.config.ts` `coverage` block, `pnpm coverage` script) with per-package glob thresholds, and split enforcement:

- **protocol (95) and server (85)** — enforced at the documented targets. They pass today, so this is pure regression prevention.
- **cli and mcp** — enforced as **regression-ratchet floors** at current coverage (cli 44, mcp 57), not the 75% target. The build fails if they slip; the 75% target stays documented as the bar to ratchet toward. Raising cli/mcp to 75% (onboarding + tool-handler tests) is tracked as a follow-up hygiene item, not a release blocker.

`coverage.exclude` drops `**/*.test.ts`, build output, and pure re-export barrels (`packages/*/src/index.ts`) so the denominator is shipped logic only.

## Consequences

- `pnpm coverage` is green and the gates are now machine-enforced; `06-testing.md` "Coverage gates" updated to describe the enforced floors, the protocol/server targets, and the cli/mcp ratchet with its 75% follow-up.
- A coverage regression in any package now fails the build, including the previously-unguarded protocol/server margins.
- The cli/mcp floors are deliberately below the documented target; they must only ever move up. Treat lowering them as requiring its own decision.
- No behavior or API impact; CI continues to run the same suite (now with `--coverage` available via `pnpm coverage`).
