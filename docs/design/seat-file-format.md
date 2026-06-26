# Seat file format & the isomorphism guard — the foundation under ADR 058

> **Status: implemented** (2026-06-25, commit 96902fd) — `@musterd/protocol/src/seatfile.ts` ships
> the schemas + canonical serializer; `smol-toml` is in the lockfile; both guards are tested
> (`seatfile.test.ts` for the format layer, `projection/reconcile.test.ts` for the db round-trip);
> `musterd fmt --check` is the guard-2 CLI. The "Upstream corrections" below are applied.

> Fourth layer of the ADR 058 stack. The
> [projection](./projection-reconcile.md) and [verb](./seat-lifecycle-as-files.md) layers both lean
> on "the shared serializer," "canonical key order," and "the byte-equal round-trip test" without
> pinning them down. This doc specifies the on-disk schema, the serializer, and — most importantly —
> **corrects the round-trip guard**, which the upstream docs described too strongly.

## The correction: two guards, not one

ADR 058 §3 and projection-reconcile both say the invariant is "**file → projection → file** is
byte-equal." That is wrong as stated, because the durable files are **hand-edited** by humans and
agents (that is the entire point of the tier). A person who writes `role="reviewer"` where the
serializer emits `role = "reviewer"`, or who orders keys `role` before `kind`, is semantically
correct but byte-unequal — a byte-equal guard would flag a legitimate edit as drift. Byte-equality
against arbitrary human input is the wrong contract.

Disentangle into two independent guards:

1. **Correctness — semantic round-trip (load-bearing).** `parse(file) → project to db → serialize
   from db → parse` must `deepEqual` `parse(file)`. This is what proves the daemon is a faithful
   mirror of the files: nothing in the durable tier is lost or altered crossing into the projection
   and back. It tolerates whitespace and key order in the human's file because it compares *parsed
   structures*, not bytes.
2. **Tidiness — canonical formatting (cosmetic, gofmt-style).** `musterd fmt` rewrites
   `seats/*.toml` to canonical form; a `format:check` (sibling to ADR 043's arch-tree drift guard)
   asserts the committed files are *already* canonical, exactly like `prettier --check`. This keeps
   diffs minimal and blame clean. Byte-equality lives **here** — canonical-output vs. committed-file
   — and it is a formatting nicety, never the correctness contract.

Conflating them was the bug. The daemon's faithfulness rides on guard 1; guard 2 is just so PRs stay
readable. ADR 058 §3 and projection-reconcile are corrected to point here.

## Format choice: TOML (add `smol-toml`)

The repo carries **zod** and no serialization lib (SQL is a TS constant to dodge asset-copying, ADR
003). So the format is a real dependency decision:

- **TOML** — a 3-line seat file (`kind = "agent"` / `role = "reviewer"`) is the most hand-editable
  option; no braces, quotes-only-on-strings, no trailing-comma traps. This directly serves the "an
  agent/human reads and edits it fluently" thesis that justifies the whole durable tier. Cost: one
  dependency — `smol-toml` (spec-compliant, ESM, ~small, parse + stringify).
- **JSON** — zero new deps, but braces/commas/quotes make a 3-line file fussier to hand-edit and
  trailing-comma errors are a classic foot-gun; it quietly undercuts the thesis.

**Decision (ratified 2026-06-25): TOML + `smol-toml`.** Hand-editability is not a nice-to-have here
— it is the property the durable tier exists to provide; JSON saves a dependency by taxing the exact
thing we're optimizing. The single new runtime dep is accepted. `smol-toml` is **a dependency of
`@musterd/protocol`** (added with the format layer, commit 96902fd). The JSON fallback is recorded
only as the downgrade path if the dep is ever reverted.

## Schema

**`team.toml`** — one per workspace `.musterd/` (a workspace binds exactly one team):

```toml
slug      = "alpha"        # required; the team identity ([a-z0-9-]{1,32}, matches teams.ts SLUG_RE)
display   = "Team Alpha"   # optional
lifecycle = "forever"      # optional, default "forever"; the team's default member lifecycle
```

**`seats/<name>.toml`** — one per member. **The filename stem is the name** — it is *not* repeated
in the body:

```toml
kind      = "agent"        # required: "agent" | "human"
role      = "reviewer"     # optional, default ""
lifecycle = "until"        # optional; inherits team.lifecycle when omitted
until     = "2026-07-01T00:00:00Z"   # required iff lifecycle = "until"; ISO-8601
```

Two deliberate calls:

- **Name comes from the filename, never the body.** One source for the name; renaming a seat is
  `git mv seats/olive.toml seats/ollie.toml` (clean diff, clean blame). If a `name` key appears in
  the body it must match the stem or reconcile rejects the file (fail-closed, below). The stem is
  validated against the member-name rule (no whitespace, `members.ts`).
- **Timestamps are ISO-8601 in files, epoch-ms in the db.** Files are the human surface, so `until`
  is human-legible ISO; `reconcileTeam` converts to the `lifecycle_until INTEGER` epoch the schema
  stores. The durable representation and the internal representation differ on purpose — the same
  split the rest of musterd already makes.

The zod schemas live in `@musterd/protocol` next to `BindingSchema` (house style — `binding.ts`),
shared by the daemon (parse on reconcile) and the CLI (validate before writing a file):

```ts
export const TeamFileSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{1,32}$/),
  display: z.string().optional(),
  lifecycle: LifecycleSchema.default('forever'),
});
export const SeatFileSchema = z
  .object({
    kind: MemberKindSchema,
    role: z.string().default(''),
    lifecycle: LifecycleSchema.optional(),
    until: z.string().datetime().optional(),
    name: z.string().optional(), // if present, must equal the filename stem
  })
  .refine((s) => s.lifecycle !== 'until' || s.until, {
    message: 'lifecycle "until" requires an `until` timestamp',
  });
```

## Canonical form (what `fmt` emits, what `format:check` enforces)

Determinism comes from fixing every free choice:

- **Key order** — `team.toml`: `slug, display, lifecycle`. `seats/*.toml`: `kind, role, lifecycle,
  until`. (Schema order, so the serializer just walks the schema.)
- **Emission** — always emit `kind` and `role`; emit `lifecycle`/`until` **only when `lifecycle !=
  "forever"`** (a forever seat is the common case and stays a 2-line file). Omit `display` when
  empty. This makes "minimal" well-defined without consulting the team default at serialize time.
- **Style** — `key = value`, single spaces around `=`, double-quoted strings, one trailing newline,
  LF line endings, no blank lines. One seat per file (ADR 058 §2), so no array-of-tables ambiguity.

Because the serializer is total and deterministic, guard 2's byte-equality is well-posed:
`serialize(parse(committed)) === committed` for any canonical file.

## Validation & fail-closed reconcile

A malformed or schema-invalid seat file must **never** silently drop a seat or take down the team's
projection. Reconcile validates per-file and is **fail-closed per seat**:

- **Parse/schema error on `seats/<name>.toml`** → log loudly, **skip that seat, keep its last-known
  projection** (do not tombstone — a corrupt file is not a deletion). Surface the error count in
  `/health`. A typo in one seat never revokes that seat or disturbs the others.
- **`team.toml` invalid** → refuse to reconcile that team at all (the team identity itself is in
  doubt); keep the entire prior projection; log. Better a stale-but-coherent team than a half-applied
  one.
- **Name-stem ↔ body mismatch, or stem violates the name rule** → reject that file (skip-and-keep), as
  above.

This makes the file the source of truth *without* making a fat-fingered edit destructive — the
reconcile is monotonic in safety: ambiguity holds the last good state rather than guessing.

## Test design

- **`format.roundtrip.test.ts`** (guard 1) — property-style: for a set of seat/team fixtures
  (including every lifecycle, roles with spaces, unicode names), assert
  `parse(serialize(project(parse(f)))) deepEquals parse(f)`. Also fuzz whitespace/key-order variants
  of each fixture and assert they all project identically — proving guard 1 tolerates hand-edit
  noise.
- **`format.canonical.test.ts`** (guard 2) — assert `serialize(parse(canonical)) === canonical`
  byte-for-byte for the canonical fixtures, and that `fmt` is idempotent (`fmt(fmt(x)) === fmt(x)`).
- **`format.failclosed.test.ts`** — a corrupt `seats/x.toml` leaves x's prior projection intact and
  the sibling seats untouched; an invalid `team.toml` leaves the whole team's projection intact;
  both bump the health error count.

## Code seams

| Where | Change |
|---|---|
| `protocol/src/seatfile.ts` (new) | `TeamFileSchema`, `SeatFileSchema`, `serializeSeat`/`serializeTeam` (canonical), `seatNameFromPath`. Shared CLI + daemon. |
| `protocol/package.json` + lockfile | `smol-toml` added (ratified). |
| `server/src/projection/load.ts` | use `SeatFileSchema` + `smol-toml` parse; implement fail-closed per-seat skip-and-keep + health counter. |
| `server/src/projection/serialize.ts` | thin re-export of the protocol serializer (used by guard-1 test). |
| `cli/src/commands/fmt.ts` (new) | `musterd fmt` writes canonical; `--check` is the CI guard (sibling to ADR 043 `format:check`). |
| `cli/src/commands/{team,claim}.ts` | write seat files via the protocol serializer (canonical from birth, so `fmt` is a no-op on freshly-written files). |

## Upstream corrections (applied when this landed)

Both were applied in the implementation (commit 96902fd):

- **ADR 058 §3** — "byte-equal" replaced with the two-guard model: correctness = semantic round-trip;
  byte-equality = a separate `fmt`/`format:check` tidiness guard.
- **projection-reconcile.md → Isomorphism check** — same correction; its `:memory:` round-trip test
  is guard 1 (compare parsed structures), not a byte compare.

## Deferred

- **`team.toml` format versioning** — when the durable schema itself changes incompatibly, a
  `format_version` key + a file-migration step (parallel to `schema_meta`/`migrations.ts`); out of
  scope until the first breaking change.
- **Comments in seat files** — TOML allows `#` comments a human might add; guard 1 (semantic) ignores
  them, but `fmt` would strip them. Decide whether `fmt` preserves leading comments before promoting
  `fmt --check` to a blocking CI gate.
