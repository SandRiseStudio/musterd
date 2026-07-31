# 195 — No literal NUL in tracked TypeScript source

- Status: accepted
- Date: 2026-07-31
- Builds on: [ADR 182](182-the-writer-validates-what-the-reader-parses.md) (writer validates what
  the reader parses — applied here to the source files themselves)
- Lane: `01KYR30ZT4C01NB2BC050EHN2K`

## Context

A literal `NUL` (`\x00`) byte in a `.ts` file makes common investigator tools lie by omission:
`file` reports `data`, and grep/ripgrep return **silence** for the whole file — not "binary file
matches", not an error. The symbol looks absent. This cost real time on lane `01KYQ913P5` (two
empty greps on a ~300-line file before the cause was visible), and it is the third instance of
the same defect:

1. `packages/protocol/src/enforcement.ts` — gateFingerprint delimiter (fixed as `\u0000`)
2. `packages/cli/src/host/loop.ts` — group key delimiter (#520)
3. `packages/mcp/src/toolTelemetry.ts` — tool×outcome map key (this lane)

`.gitattributes` already carries `*.ts diff`, so review diffs are safe; the remaining harm is
every text tool an investigator reaches for.

## Problem

Escaping one file does not stop instance #4. The writer (a teammate, or an agent) can reintroduce
a literal NUL as a "delimiter" because it is byte-correct at runtime and looks fine in some
editors. Nothing in CI asks whether the source is still *text*.

## Decision

1. **Replace the remaining literal** in `toolTelemetry.ts` with the `\u0000` escape —
   byte-identical at runtime, text on disk.
2. **Gate it:** `pnpm source-nul:check` (`scripts/check-source-nul.ts`) walks
   `packages/**/*.ts` and `scripts/**/*.ts` and fails on any byte `0x00`. Wired into
   `format:check` so it rides the same CI path as the other source hygiene gates.

## Consequences

- Investigators can `rg` / `file` every `.ts` file again.
- A future delimiter that needs a NUL at runtime must be written `\u0000` (or built at runtime
  from `String.fromCharCode(0)`); a literal in the source fails the build.
- No protocol / schema change.

## Observability & Evaluation

- **Traces:** n/a — source hygiene gate, not a runtime path.
- **Eval:** dataset = the three known files that once carried a literal NUL. Baseline: with the
  byte present, `file packages/mcp/src/toolTelemetry.ts` reports `data` and `rg record
  packages/mcp/src/toolTelemetry.ts` is empty. Score: after the fix, `file` reports text and the
  check script exits 0; planting a literal `\x00` in any tracked `.ts` under `packages/` or
  `scripts/` fails `pnpm source-nul:check`.
- **Experiment:** the check script itself — run red on a deliberately poisoned fixture locally,
  green on `main` after the escape lands.
