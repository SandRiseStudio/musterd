# 07 — Conventions

> **Living document.** This is the initial direction, not gospel. It will evolve. If you (the executing agent) find an error, contradiction, or better approach during implementation: (1) do not silently deviate — record the issue and your proposed change in `docs/decisions/NNN-<slug>.md` (a short ADR: context, problem, decision, consequences), (2) make the smallest correct change, (3) update the affected doc in the same commit. Docs and code must never disagree at the end of a commit.

## Language & toolchain

- **TypeScript**, strict. Node 22, ESM (`"type":"module"`). Target `ES2022`, `moduleResolution: "bundler"` (or `nodenext`; pick one repo-wide — record in ADR if you change).
- Package manager: **pnpm workspaces** (`pnpm-workspace.yaml` lists `packages/*`).
- Build: `tsc` per package emitting to `dist/` (or `tsup` if bundling helps the CLI/MCP bins — ADR if added). `@musterd/protocol` is consumed as source-or-dist via workspace `*`.
- Test: vitest. Static gates: **strict `tsc --noEmit`** plus **ESLint** (flat config, `@typescript-eslint` + `import`) and **Prettier** (ADR 013, which supersedes ADR 004's deferral). The "Lint / format rules" below are now machine-enforced: `pnpm lint` (and `pnpm format:check`) must be clean.

## tsconfig (root `tsconfig.base.json`, extended per package)

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

## Lint / format rules (the ones that matter)

- No `any` without a `// reason:` comment. Prefer `unknown` + narrowing.
- All external input parsed through `@musterd/protocol` zod schemas at the boundary; never trust a raw frame/body/argv.
- No default exports except a package's bin entry. Named exports everywhere.
- Imports ordered: node builtins → external → `@musterd/*` → relative. Prettier handles formatting; don't hand-format.

## Error handling pattern

- One error type per package surface: server `MusterdError(code: ErrorCode, message)`; CLI `CliError(code, message)`. Both carry a code from the `02-protocol` error-code enum (CLI maps code → exit per `04-cli.md`).
- Throw `MusterdError` at the point of detection; transports catch at the boundary and serialize (`toHttp()` / `toFrame()` / CLI `→ stderr + exit`). Never `console.log` an error and continue.
- Validation errors always reference *what* failed (field + reason), surfaced from zod's issues.

## Logging format

- Server: structured single-line JSON to stdout: `{ "ts":<ms>, "level":"info|warn|error", "msg":..., "team?":..., "member?":..., "act?":..., "conn?":... }`. One log line per meaningful event (connect, send, deliver, reap, error). No PII beyond member names (which are not secret); **never log tokens**.
- CLI: human output to stdout, errors to stderr; `--json` switches stdout to machine JSON. Debug logs behind `MUSTERD_DEBUG=1` to stderr.

## Commit message format

```
<area>: <imperative summary>      # area ∈ protocol|server|cli|mcp|docs|spec|build|test
                                  # e.g. "server: route team/broadcast envelopes"
<body: what & why, not how>
<footer: "Refs ADR-00N" when a decision/deviation is involved>
```

Each commit keeps **docs and code in agreement** (the living-doc rule). A commit that changes behavior described in a doc must update that doc in the same commit. A commit that deviates from a doc must include/reference the ADR.

## ADRs (`docs/decisions/NNN-<slug>.md`)

Sequential, never renumbered. Template:

```md
# NNN — <title>
- Status: accepted
- Date: YYYY-MM-DD
## Context
## Problem
## Decision
## Consequences
```

Known ADRs to write while implementing (because the docs already flagged simplifications): **001 — members table folds memberships** (`01-data-model.md`), plus any dep additions (`hono`, `cac`/`mri`, `tsup`) and any protocol-schema change.

## Definition of done (per task)

A task/milestone is done only when **all** are true:
1. Code compiles (`pnpm -r build`) with no TS errors.
2. Strict typecheck clean (`pnpm -r exec tsc --noEmit`); `pnpm lint` and `pnpm format:check` clean (ESLint + Prettier, ADR 013).
3. `pnpm test` green, including the relevant acceptance scenario(s); `pnpm coverage` meets the gates (`06-testing.md`).
4. Docs touched by the change are updated in the same commit; no doc/code disagreement.
5. Any deviation from these docs has an ADR.
6. For CLI changes: output still matches the Figma terminal frames (snapshot tests pass).

## Naming

- Terminology: only the glossary terms (`brand.md` §5) — Team, Member, Presence, Surface, Act — for the concepts they name, in identifiers and prose. No synonyms (`room`, `user`, `session`-for-member, `event`-for-act).
- Files: kebab-case. Types/interfaces: PascalCase. Functions/vars: camelCase. Constants: SCREAMING_SNAKE for true constants (`HEARTBEAT_INTERVAL_MS`).
- Package names: `@musterd/protocol`, `@musterd/server`, `@musterd/mcp`, `@musterd/cli`. The CLI keeps the bin name `musterd`; its package is scoped because unscoped `musterd` is blocked on npm (ADR 009).
