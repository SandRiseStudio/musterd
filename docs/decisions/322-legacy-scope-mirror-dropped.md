# 322 — `surface_globs` leaves the wire: the ADR 296 tier-2 mirror drops at epoch 16

- Status: accepted
- Date: 2026-08-25
- Related: ADR 296 (terminology architecture — tier 2 executed here), ADR 138 (skew posture),
  ADR 148 (`behind` hint)
- Lane: 01M0X0QQ09PZ5R12VY58JHZF52 (stanley) · PR #1061

## Context

Tier 2 of ADR 296 renamed a lane's paths from `surface_globs` to `scope` on the wire at epoch 14
(#1041), carrying a skew mirror in both directions: clients dual-sent the legacy key beside `scope`
(`mirrorLegacyScopeOnSend`), the daemon dual-populated the full Lane shape and adopted the legacy
key on read (`adoptLegacyScopeKey` / `adoptLegacyScopeInput`), and the schema kept a deprecated
`surface_globs` field so an epoch-13 client still parsed. The mirror's own documentation set its
end: it drops in a later epoch, **on-touch — no calendar bound** — once the fleet is past the
rename.

## Decision

The fleet is past the rename: on 2026-08-25 every seat workspace dist attested
`FEATURE_EPOCH = 14` (dolly/gptbot self-rebuilt; izzo/ryder/sloane/grokbot advanced to main and
rebuilt). So the mirror drops, in full:

1. **Dual-send removed.** CLI and MCP clients send canonical `scope` only.
2. **Dual-populate removed.** `LaneSchema` loses the deprecated `surface_globs` field and its
   preprocess; the daemon's lane projection no longer carries the mirror key.
3. **Legacy read adoption removed.** `OpenLaneSchema` / `UpdateLaneSchema` no longer adopt
   `surface_globs`; a legacy-only body reads as scopeless rather than erroring (zod strips unknown
   keys — the ADR 138 fail-toward-tolerance posture, and an epoch-14 client never sends
   legacy-only anyway: it dual-sends, so `scope` is always present).
4. **Feature epoch 16** as the capability marker (ADR 321 took 15 while this was in review; the
   binding precondition was always the rename epoch, not the previous number). Skew holds in both
   directions without the mirror: any epoch-14+ counterpart already reads and writes canonical
   `scope` — 14 dual-sends it, 15 sends it canonically.

Deliberately kept, because they were never the wire mirror:

- the `lanes.surface_globs` **DB column** — internal storage, ADR 296 tier 3 territory;
- the MCP coercion **input alias** (`surface_globs` → `scope`) — a typo-courtesy at the tool
  boundary, same family as its other aliases.

## Observability & Evaluation

- **Traces:** the drop is observable on the wire — a lane fetched from an epoch-16 daemon
  carries no `surface_globs` key, and the roster's `behind` hint (ADR 148) marks any seat still
  attesting an older epoch. Fleet attestation was verified per-workspace
  (`packages/protocol/dist/feature-epoch.js`) before the drop landed, recorded on lane
  01M0X0QQ09PZ5R12VY58JHZF52.
- **Eval:** `lanes.scope.test.ts` pins the dropped shape (canonical-only parse, no mirror key on
  the parsed Lane, legacy-only bodies read scopeless), and the integration suite exercises
  canonical `scope` in both directions. Falsifier: an epoch-14+ client failing to open a scoped
  lane against an epoch-16 daemon (or vice versa) within the one-epoch window invalidates the
  skew claim above.
- **Experiment:** n/a — a mirror removal has no behavior to A/B; the falsifier is binary and the
  tests carry it.

## Consequences

- An epoch-13-or-older client (two or more behind) that sends only the legacy key now opens
  scopeless lanes — outside the one-epoch skew contract, and the empty scope contends as the
  unscoped wildcard (ADR 083), failing toward a false positive rather than silence.
- The mirror's tests are rewritten to assert the drop (canonical-only parse, no mirror key on the
  parsed shape, legacy-only body reads scopeless); fixtures and integration bodies moved to
  `scope`.
