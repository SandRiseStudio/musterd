/**
 * Test-runner settings that every config in this repo must agree on — defined once, because the
 * cost of them disagreeing was measured rather than imagined.
 *
 * ## Why this file exists
 *
 * `pnpm -r test` runs each package's OWN `vitest run` against its OWN `vitest.config.ts`, and a
 * package-local config inherits **nothing** from the root. So a value tuned once at the root
 * silently applied to `pnpm test` and to nothing else — including `pnpm -r test`, which is the
 * command a seat is most likely to run before pushing, and the one that puts the machine under the
 * heaviest load by starting every package's forks at once.
 *
 * Measured 2026-08-19 on `packages/cli` at the 5s default: a test needing 6s failed with
 * "Test timed out in 5000ms" under `vitest run`, while the identical test passed under the root
 * config. Five of five package configs were in that state.
 *
 * Keep the number here and import it. `tests/vitest-config-parity.test.ts` fails if any config
 * drifts off it, so the writer's scope and the checker's scope stay equal (the ADR 284 lesson).
 */

/**
 * Vitest's 5s default assumes unit tests. Much of this suite is not: it boots real daemons over real
 * sockets, builds real git repos, and spawns real CLIs. With `pool: 'forks'` those run one worker per
 * CPU, so on a memory-constrained machine they starve each other — measured on the dogfood box
 * (8 CPUs, 8 GB, swap 87% full): tests needing 341–562ms idle blew the 5s ceiling at 5.1–6.1s,
 * roughly a 10x slowdown, and the suite reported 302s of "collect" inside a 157s wall time. Four
 * different tests failed across two runs, never the same one twice, and two seats each spent time
 * proving the red suite was not theirs.
 *
 * A timeout exists to catch a HANG. None of these hang — they are starved, so the 5s ceiling was
 * firing on contention and calling it failure. 30s keeps that catch (a real hang still surfaces
 * inside one suite run) while absorbing the measured starvation with room over it. This is NOT a
 * licence to paper over a slow test: if something genuinely needs more than a second of real work,
 * that is worth knowing. The sibling fix in #482 went the other way for exactly that reason — a
 * fixed 80ms sleep there was a real clock-vs-condition race, and raising it would have been wrong.
 */
export const TEST_TIMEOUT_MS = 30_000;
