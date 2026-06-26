# 059 — Multi-identity global config: stop the cross-agent token clobber

- Status: accepted — implemented 2026-06-25
- Date: 2026-06-25

## Context

ADR 018/055 fixed the **per-folder** identity layer: a `.musterd/binding.json` binds a folder to one
seat, and `claim … --token` adopts a seat into a folder without touching anyone else. But the **global**
config (`~/.musterd/config.json`) still keeps a single identity per team:

```jsonc
{ "current": "alpha", "identities": { "alpha": { "name": "David", "token": "…" } } }
```

`identities` is keyed by team slug → **one** identity per team. So when two agents on one machine use
the CLI without a per-folder binding (or run `join`), the second `join` *overwrites* the first:
`join alpha --as Pim` evicts David's cached token entirely. The 2026-06-25 dogfood hit this repeatedly —
the cached `alpha` identity drifted David→Pim→Olive, and `musterd send --as David` then failed with
`stored identity for "alpha" is Pim, not David`, because `resolve()` finds the single cached identity
for the team and rejects the `--as` mismatch (`helpers.ts`, the "single-slot-per-team" hazard its own
comment names). A previously-valid identity became unusable not because it was revoked, but because
another agent joined.

## Problem

Let one machine hold **multiple** identities per team so that (a) joining as one member never loses
another member's token, and (b) `--as <name>` always resolves any previously-known identity — without
the high-churn schema break of re-keying `identities` (asserted as `Record<team, Identity>` across ~10
test sites).

## Decision

### 1. A known-identities vault, additive to `identities`

`identities: Record<teamSlug, Identity>` stays as the **active/default identity per team** (unchanged
shape, backward compatible — the `current`-team default and existing readers keep working). Add a
**vault**: `knownIdentities: StoredIdentity[]` (`StoredIdentity = Identity & { team }`) — every identity
this machine has ever joined/claimed, keyed by (team, name), upserted on each `join` / `team add` /
`team create` / `init`. A token, once stored, is never evicted by another member joining the same team.

On load, the vault is **backfilled** from `identities` (so an old config's single identity is in the
vault immediately), and `identities[team]` is always also upserted into the vault on write — the vault
is a superset, never out of sync.

### 2. `--as`-aware resolution

`gather()` surfaces the vault entries as `config`-source candidates (in addition to the active
`identities`). `resolve()`/`resolveRead()` change their match from "first source for this team" to
"source for this team **and**, when `--as <name>` is given, this name":

```ts
const match = sources.find((s) => s.team === team && (!asName || s.identity.name === asName));
```

So `--as David` finds David's vault entry even when `identities["alpha"]` is Pim. The old
"stored identity is X, not Y" rejection is gone — a name that was ever joined just resolves. A `--as`
for a never-seen name still fails, now with `no identity for team "alpha" as David`.

### 3. What stays the same

- The **per-folder binding** remains the way to make a folder *act* without `--as` (ADR 036): an
  ambient vault identity is still not "explicit" enough to act on its own. The vault widens *which*
  identities `--as` can name; it does not relax the act-requires-explicit rule.
- `current` stays a team slug (the active team). Acting always requires explicit identity, so a
  per-team "current member" is unnecessary.

## Consequences

- Two agents on one machine can each `join`/be cached without clobbering the other's token; `--as`
  switches between them freely. The drift that plagued the dogfood is gone.
- No breaking change to `identities` — existing configs load and convert transparently; existing
  readers/tests are untouched.
- Mild redundancy (the active identity lives in both `identities` and the vault), accepted for a local
  config file and kept consistent on every write. A future cleanup could collapse `identities` into a
  pure "current pointer" over the vault, once the test churn is worth it.
- Builds on ADR 018/055 (per-folder binding), ADR 036 (active-identity-to-act).
