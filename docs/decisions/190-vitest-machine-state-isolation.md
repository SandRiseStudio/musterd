# 190 — Vitest must not write machine-wide musterd state

- Status: accepted
- Date: 2026-07-31

## Context

ADR 162 pinned `MUSTERD_CONFIG` in `vitest.config.ts` after the suite filled the
operator's binding registry with hundreds of dead temp dirs. That closed one
leak. It did not close the class.

On 2026-07-31 the wake shim at `~/.musterd/bin/musterd` was found exec'ing a
vitest worker entry (`tinypool/.../process.js`) — every woken-session hook died
silently for ~19 hours while `command -v musterd` still succeeded (PR #542). The
writer was a stale checkout's test run reaching `ensurePinnedMusterd` with no
isolation. Current `main` does not reproduce; the defect is that isolation is
still opt-in and unenforced.

Two gaps remained after ADR 162:

1. Many suites `delete process.env.MUSTERD_CONFIG` in `afterEach`, which unpins
   the vitest `env` pin for the rest of that worker. Later files that reach
   `configPath()` without their own pin write `~/.musterd` again.
2. `MUSTERD_HOST_REGISTRY` was never pinned. Same shape, different file.

## Problem

Machine-wide paths the CLI owns (`config.json`, `host-registry.json`, the wake
shim under `~/.musterd/bin/`) are reachable from un-injected production code.
Per-file `mkdtemp` + env is easy to forget, and forgetting is silent. Twice is a
pattern (ADR 108-era binding clobber; #542 shim poison).

## Decision

**(a) Isolation is the default.** A root vitest `setupFiles` entry
(`tests/setup/isolate-machine-state.ts`) pins `MUSTERD_CONFIG` and
`MUSTERD_HOST_REGISTRY` to a per-run temp dir at load, in `beforeEach`, and in
`afterEach` — so a suite's cleanup `delete` cannot leave the worker unprotected.
Suites that need a private config still set their own override in `beforeEach`
(that hook runs after the setup hook and wins for the test).

**(b) The invariant is self-enforcing.** `configPath()` and `hostRegistryPath()`
(via shared `machineStatePath`) throw when `VITEST` is set and the env override
is absent. A missing pin fails at the call site instead of writing the
operator's home. The loud break is intentional.

Hardening `pinnedBin` alone is not enough — that closes one shape; the next
shared file a test writes is the same class.

## Consequences

- Tests that clear `MUSTERD_CONFIG` / `MUSTERD_HOST_REGISTRY` without replacing
  them will throw on the next `configPath()` / `hostRegistryPath()` call. Fix:
  set a temp override, or stop clearing (the setup `afterEach` re-pins anyway).
- New machine-wide path resolvers should go through `machineStatePath` (or an
  equivalent VITEST guard) rather than raw `homedir()` joins.
- ADR 162's vitest `env` pin stays as a belt-and-suspenders start-of-worker pin;
  the setup file is what survives per-suite cleanup.

## Observability & Evaluation

n/a — test-harness invariant; no agent-facing runtime surface.
