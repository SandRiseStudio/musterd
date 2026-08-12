# 255 — Concurrent saves of ~/.musterd/config.json must not drop identities or bindings

- Status: accepted
- Date: 2026-08-12
- Deciders: nick (directed), wanderer (carried)

## Context

`~/.musterd/config.json` is the machine-wide CLI vault: per-team identities, the ADR 059
known-identities vault, the ADR 020 binding registry, agent keys, roster/team homes, plus
`server` and `current`. Every `musterd` process that claims, joins, inits, unbinds, or
records a binding does `loadConfig()` → mutate one map → `saveConfig(config)`.

`saveConfig` rewrote the whole file from that in-memory snapshot. Two processes that
loaded the same bytes, each added a different key, and saved, last-write-wins the
snapshot: the first writer's identities, bindings, or vault entries disappear. The
binding file next to it already refused this shape (ADR 131 inc 4: tmp+rename plus a
merge-guard). The global config did not.

This is the same class ADR 059 closed for *sequential* joins on one team (one slot
clobbering another) and ADR 162 closed for *test residue* filling the registry. Neither
covered two live CLI processes racing the file.

## Problem

A busy machine runs many short CLI processes at once (`claim`, `saveBinding` from
autojoin, `team create`, hooks). Each holds a stale full snapshot. Last-write-wins of
that snapshot is silent data loss of credentials and of the only global index of where
seats are bound.

Atomic rename alone does not fix it: two complete snapshots still replace each other.
A lock around the existing save does not fix it either, unless the load is inside the
lock — and callers load, do network, then save.

## Decision

**`saveConfig` 3-way-merges under an exclusive lock, then writes tmp+rename at 0600.**

1. **`loadConfig` stamps a snapshot** on the returned object (`WeakMap`). Callers keep
   passing that same object; no API change.
2. **`saveConfig` locks** (`config.json.lock`, `wx` create, stale-pid steal, 5s cap),
   re-reads disk, and 3-way-merges maps (`identities`, `bindings`, `agentKeys`,
   `rosterHome`, `teamHome`) and the vault (keyed by team+name) against
   snapshot / caller / disk:
   - key we added → ours
   - key we deleted → gone
   - key we did not touch → disk (so a concurrent add or a concurrent `current` change
     survives)
3. **Scalars `server` and `current`** use the same rule: if we did not change them, keep
   disk. A concurrent `team create` that set `current` is not reverted by a later
   `saveBinding`.
4. **A Config constructed from scratch has no snapshot and replaces** — `musterd reset`
   still wipes. That write is still locked and atomic.
5. **No new dependency.** The lock is `wx` + pid liveness (`process.kill(pid, 0)`), the
   same tmp+rename shape `saveBinding` already uses.

A writer that loaded *before* a `reset` and saves *after* can resurrect maps. Reset is
interactive, refuses a live daemon, and is the rare path; the common path is concurrent
claim/bind/join.

## Consequences

- Overlapping `load` → mutate different maps → `save` keeps both writers' keys.
- `removeBinding` / uninstall / registry prune still delete: the caller's snapshot
  records the missing key as a deletion.
- `musterd reset` still replaces. Callers that `saveConfig({ ...loadConfig(), … })`
  (spread, new object) also replace — they drop the snapshot. Existing callers pass the
  loaded object through.
- Surface overlap with the `team create` global-repoint lane is additive: this ADR does
  not change *whether* create rewrites `server`/`current`; it stops a concurrent bind
  from reverting them.

## Observability & Evaluation

- **Traces.** None added. This is a local file-durability contract; it does not emit a
  coordination act or a span.
- **Eval.** Direct assertion in `packages/cli/src/config.test.ts` (`saveConfig concurrent
  writers`): (1) identity add + binding add both survive; (2) binding deletion still
  lands against a stale snapshot that still has the key; (3) a writer that did not touch
  `current` keeps a concurrent current-team change; (4) constructed `saveConfig` (reset)
  replaces. Dataset is those overlapping snapshots. Baseline: the same tests failing
  because the second `writeFileSync` dropped the first writer's keys.
- **Experiment.** None. This is a file-merge contract, not a model-behavior claim.
