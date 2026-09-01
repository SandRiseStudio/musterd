# Review rules for musterd

These are the rules the automated PR reviewer applies (`.github/workflows/review.yml`). They are also
the checklist for a human or seat doing a manual review.

The reviewer runs on a **cheap model, single-pass, on a small slice of PRs** — only diffs touching
`packages/protocol/src` or `packages/server/src`. Its budget is a handful of findings, so it must
spend them on semantic invariants no test can catch. It is advisory: it comments, it never blocks a
merge.

## Already enforced — never report

`gates` runs `build → typecheck → test → coverage → format:check`, and `pnpm lint` runs ESLint.
Anything below is already a hard failure, so reporting it is wasted budget:

- TypeScript errors, ESLint, Prettier, test failures, coverage floors (protocol ≥95%, server ≥85%).
- Drift guards: `roadmap`, `roadmap-truth`, `arch-trees`, `obs-evals`, `adr-numbers`, `guidance`,
  `vocab`, `perf` (web byte budgets).
- **Cross-package imports** — `no-restricted-imports` blocks `@musterd/server` in CLI/MCP code.
- **`console.*` in `packages/server/src`** — `no-console`.
- **ADR-gated changes** — `change-adr:check` fails a protocol-schema change or a new runtime
  dependency with no ADR, and fails an edit to an accepted ADR's `## Decision`.

No style preferences, no refactors for taste, no comments on code outside the diff.

## Blockers

1. **Unparsed external input.** WS frames, HTTP bodies, argv, and MCP tool args must pass a
   `@musterd/protocol` zod schema before reaching logic. Flag raw `JSON.parse` results, `req.body`,
   and `as` casts standing in for a parse.
2. **Leaked secrets.** `mskey_`, `msgr_`, `mscr_`, or session tokens reaching a log line, error
   message, trace attribute, or HTTP response. The server stores only `sha256`.
3. **Member/session conflation.** Presence is _where_ a Member is attached; the Member outlives it.
   Flag member state keyed by connection, or a Member reaped when a Presence drops.
4. **Doc/code disagreement.** Behavior described in `SPEC.md`, `docs/architecture/00–07`, or
   `AGENTS.md` must be updated in the same PR.

## Where the real bugs are

Concurrency and state, in rough order of risk. This is what the reviewer exists for:

- **Seat/lane ownership** — a claim that steals a live seat, displacement escaping its workspace
  scope, a released lane resolved twice.
- **Presence reaping** — evicting a live Member, or leaving a dead Presence attached.
- **Delivery** — per-recipient status marked delivered when it wasn't; an act double-delivered on
  reconnect.
- **SQLite** — transaction boundaries, and writes that assume a read is still current.

Also worth a hard look: `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on, so an
index access or optional property that merely _looks_ safe often isn't.

## Conventions with teeth

- Errors: `MusterdError(code, message)` / `CliError(code, message)`, serialized only at the transport
  boundary. Flag swallowed errors, errors surfaced without their code, and validation errors that
  don't name the failing field and reason.
- The five glossary terms — Team, Member, Presence, Surface, Act — have no synonyms. Flag `room`,
  `user`, `session`-meaning-Member, `event`-meaning-Act.
- `any` needs a `// reason:` comment.

## A finding is not a fix request ([ADR 338](../docs/decisions/338-a-finding-is-not-a-fix-request.md))

The test for a blocking finding (a REQUIRED, for a seat review): would the spec have demanded it
**before anyone opened the diff?** Discovery adds information, not obligation.

- REQUIRED is reserved for four categories: **honesty** (a false claim in the PR or its docs),
  **leaked secrets**, a **probe-measured regression** (reproduced against this head — reasoning
  about a failure is a note, reproducing it is a REQUIRED), and a **named pin** (a falsifier in the
  lane or spec, an ADR clause, a doc/code disagreement, or a rule the PR's own text states — quoted
  or cited in the finding itself). A category claim with no probe and no pin is a note.
- Everything else — hypotheticals, edge cases the spec never named, hardening ideas — is **noted,
  not blocking**. A note worth keeping becomes a Seed or a lane with the finder's name on it.
- Authors **decline** a REQUIRED outside the four categories, citing ADR 338, and do not expand the
  lane to clear it. Taking a noted finding anyway is allowed — as a recorded decision, measured
  first, never as compliance.
- AppSec is exempt: probe-measured security findings accepted by nick stay REQUIRED regardless of
  what the spec named. Demonstrated, not merely labeled.

## Output

Few high-confidence findings, not a list. For each, give the input and the resulting failure — a
concrete scenario, not a category. Clean against the above: say so in one line and stop.
