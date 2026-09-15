# 304 — Roster files report their unknown keys; the schemas stay permissive

Status: accepted 2026-08-21 (dolly; warn-not-fail decided by nick in-session)
Lane: 01M0K23V0HAWBQ24JB4TS2TE6T (detector + `fmt --check`), 01M0K2ZZGFCWY8NF2G8M73BMDA (reconcile)

## Problem

The roster schemas (`TeamFileSchema`, `SeatFileSchema`, `RoleFileSchema`) are zod objects with the
default `.strip()` behaviour, so a key they do not know is **silently discarded on parse**. Two
consumers then act on the stripped value:

- **`musterd fmt`** rewrites the file from the parsed object, so the key is **deleted from disk**.
- **The daemon's reconcile** projects the seat without it, so the field never reaches the database.

Neither said anything. Measured 2026-08-21 on the live roster: `seats/autorefresh.toml` carries an
authored 587-character `charter` paragraph. `charter` is in `RoleFileSchema` but **not**
`SeatFileSchema`, so reconcile has been dropping it since 2026-08-05 and `musterd fmt` would erase
it on its first run. Found by ryder, falsifying a claim of mine (#977) that the hazard was latent.

A second, worse instance of the same silence sat beside it: `ReconcileResult.errors` — the
fail-closed parse errors that `load.ts` calls "never silently dropped" — was read by **no production
caller at all**. Every reader was a test. A corrupt `seats/*.toml` was excluded from the projection
and nobody was told.

## Constraint

Making the schemas `.strict()` would reject the file outright. On the live roster today that means
**refusing `autorefresh`'s seat** over a field nothing reads — taking a working seat offline to
complain about dead prose. The roster is also hand-edited by humans and by `role create`, and files
legitimately predate schema additions.

## Decision

**Report unknown keys; never reject on them. The schemas stay `.strip()`.**

1. `unknownRosterKeys(kind, text)` (`packages/protocol/src/seatfile.ts`) returns the top-level keys a
   roster file carries that its schema does not know. It is **derived from the schema shape**, never
   a hand-kept list — a denylist would be the same stale proxy this exists to catch. It adds no wire
   field and changes no schema: it is a query over the contract, not a change to it.

2. **`musterd fmt --check` reports data loss separately from cosmetic drift**, and prints the loss
   *first*. The drift line ends with "run `musterd fmt`", and running it is exactly what destroys
   these keys; a reader who acts on the wrong line loses the data the guard was warning about. A
   **write** run warns before rewriting — the last moment anyone can see the keys.

3. **Reconcile warns and still projects.** `TeamSpec.warnings` / `ReconcileResult.warnings` carry the
   dropped keys; the seat lands without them, exactly as before.

4. **`reconcileAll` logs what a pass found** — `reconcile_entry_error` for a skipped entry,
   `reconcile_key_dropped` for a dropped field, one structured line each, tagged so a reader can tell
   them apart. This is the part that was missing entirely, not merely imprecise.

The promise in `load.ts` is restated rather than left ambiguous: **"never silently dropped" was true
of _entries_ and false of _fields_.** The entry survived; part of it did not.

## Consequences

- A key from a future schema version, or a typo'd real one, is now visible from two directions
  before it is lost: `fmt --check` before a human formats, and the daemon on every reconcile.
- `musterd fmt` on a roster is **not a safe no-op** and the docstring says so. Diff the writes on a
  copy before running it anywhere that matters.
- Unknown keys remain silently *ineffective* — reporting them does not make them work. The two
  honest resolutions for `autorefresh`'s `charter` are to add it to `SeatFileSchema` or to delete it
  deliberately; this ADR does neither, on purpose.
- `dataLoss` is a strict **subset** of `drifted` — an unknown key is absent from the serialized form,
  so its file's bytes always differ. The `--check` exit condition therefore needs no extra term.
  Verified by mutation (removing the term killed no test), and pinned by a test asserting the subset
  relation, so a schema that ever round-trips an unknown key breaks loudly rather than the exit code
  going quietly blind.

## Observability & Evaluation

**Traces.** `reconcile_key_dropped` and `reconcile_entry_error` in the daemon log
(`~/.musterd/daemon.log`), one line per finding per pass, each carrying `root`, `team`, and `detail`.
`musterd fmt --check --json` emits `dataLoss: [{file, keys}]` beside `drifted`.

**Eval.** Dataset: `reconcile_key_dropped` lines in the daemon log, and the `dataLoss` array from a
`fmt --check --json` run against each roster home. Pre-registered expectation at acceptance
(2026-08-21): exactly one finding on the live roster — `seats/autorefresh.toml` / `charter` — and
zero `reconcile_entry_error` lines, since no roster file currently fails to parse. Measured on a copy
at that date: 15 seats projected, 0 errors, 1 warning. A count above 1 means either a new unknown key
was introduced or a schema dropped a field it used to accept; a count of 0 means `charter` was
resolved (schema-added or deleted) and this ADR's instance is closed.

**Experiment.** After 30 days (2026-09-20), read the daemon log for `reconcile_key_dropped`. If the
`autorefresh`/`charter` line is still the only finding and still unresolved, the warning is being
seen and ignored, and warn-not-fail is under-powered for this case — revisit whether a key that has
been reported for a month should escalate. If new distinct findings appear, the detector is earning
its keep on drift it was built to catch. If the log is empty because nothing reconciled, that is an
instrument-silence result about the daemon, not about this rule.
