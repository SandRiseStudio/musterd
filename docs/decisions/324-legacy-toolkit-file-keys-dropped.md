# 324 — Legacy toolkit file keys leave the reader: `.musterd/toolkits/` is the only home

- Status: accepted
- Date: 2026-08-25
- Related: ADR 296 (terminology architecture — the last tier-2 residue executed here), ADR 272
  (roles route work, toolkits configure workspaces), ADR 322 (the wire-mirror drop this follows)
- Lane: 01M0XA5RCEQBM19S735RYC4GWM (stanley)

## Context

The workspace-equipment concept was named three times: `role`-keyed files in `.musterd/roles/`
(pre-ADR-272), `profile`-keyed files in `.musterd/profiles/` (pre-ADR-296), and the canonical
`toolkit`-keyed file in `.musterd/toolkits/` (ADR 296 tier 2) — the only shape ever written. The
two older shapes stayed accepted on read, on-touch with no calendar bound, the same posture the
wire mirror carried until ADR 322 dropped it.

Unlike the wire mirror, this residue is user-authored disk state, not fleet state: the risk of
dropping it is an un-migrated file, not a version-skewed peer.

## Decision

The precondition holds vacuously, verified 2026-08-25: zero legacy toolkit JSON files exist on
this machine — no `.musterd/profiles/` directory anywhere, no `*.json` in any `.musterd/roles/`
(the team's `roles/` holds only the roster-role TOML library, a different subsystem), and in fact
no user-authored toolkit files at all; every seat runs on built-ins. And with the launch goal in
flight and zero external installs, dropping now means public users never meet the legacy homes.
So the legacy reads drop, in full:

1. **Legacy homes removed.** `TOOLKIT_HOMES` is the canonical `.musterd/toolkits/` only;
   `legacyUserProfilesDir` / `legacyUserRolesDir` are deleted. `.musterd/roles/` now belongs
   solely to the roster-role TOML library.
2. **Legacy key adoption removed.** `parseToolkit` accepts the `toolkit` name key only; the
   `adoptLegacyToolkitKey` preprocess (`profile` / `role` in-file keys) is deleted.
3. **The unknown-toolkit error names only the canonical home** — a stale file is user state, so
   the message stays a repair hint (`no built-in and no .musterd/toolkits/<name>.json`) rather
   than a bare failure.

No feature-epoch bump: these are local file reads, not wire tokens — nothing skews between
daemon and client versions.

Deliberately kept, because they are different seams:

- the provisioning **manifest** reader's legacy `role` key acceptance (`provisioned.json` — its
  write side went strict in v3; its read side is removal-set state on machines this ADR's
  precondition was not checked for);
- the MCP coercion **input alias** family at the tool boundary (typo-courtesy, ADR 322 kept the
  same).

## Observability & Evaluation

- **Traces:** the drop is observable on disk and in the CLI — `musterd toolkit list` never
  lists a file outside `.musterd/toolkits/`, and `toolkit show <name>` for a legacy-home file
  exits 4 with the unknown-toolkit repair hint. The precondition inventory (no legacy files on
  any seat workspace or the team dir) is recorded on lane 01M0XA5RCEQBM19S735RYC4GWM.
- **Eval:** `toolkit.test.ts` pins the dropped shape — the legacy `role`/`profile` name keys are
  rejected by `parseToolkit`, a file in either legacy home is invisible to load and list, and a
  legacy-home file no longer shadows a built-in. Falsifier: any seat provisioning failure after
  this lands whose cause is a toolkit file in `.musterd/profiles/` or `.musterd/roles/`
  invalidates the vacuous-precondition claim and reverts the drop.
- **Experiment:** n/a — a dead-code removal has no behavior to A/B; the falsifier is binary and
  the tests carry it.

## Consequences

- A hand-restored legacy file (for example, from a backup) is silently invisible rather than
  loaded — the cost of zod's strip posture; the repair is a one-word key rename plus a move to
  `.musterd/toolkits/`, and the unknown-toolkit error points there.
- The rename-era tests asserting legacy loads are rewritten to assert the drop; the round-trip
  fixture proof (built-ins render identical workspaces) is unaffected — built-ins never lived in
  a legacy home.
- External installs post-launch start from a one-home world; no migration doc is ever needed.
