import { z } from 'zod';

/**
 * The wake-lease FILE — a second channel for the ADR 241 correlation token, for harnesses that do
 * not let the first one through (ADR 354).
 *
 * The actuator hands a woken child two facts in its environment: `MUSTERD_PROVENANCE=wake` and
 * `MUSTERD_WAKE_LEASE=<id>`. Every process the child spawns inherits them — hooks, one-shot CLI
 * commands, and on Claude Code the MCP adapter too, which is how a woken session's presence row
 * comes to carry the lease that ADR 241 verifies against. Codex does not forward its environment to
 * the MCP servers it launches: measured 2026-09-02 on codex-cli 0.150.1, a stdio server starts with
 * twelve variables (HOME, PATH, USER, SHELL, TMPDIR, LANG, LOGNAME, TERM and four more), none of them
 * `MUSTERD_*`. On that harness the adapter attested `provenance: session` and no lease, the actuator
 * read the seat as held by another session, and killed the review it had spawned ninety seconds
 * earlier. Every codex wake from 2026-08-27 to 2026-09-02 ended that way.
 *
 * So the actuator ALSO writes this file beside `binding.json` at spawn, and the adapter reads it —
 * under two conditions that keep it an attestation rather than a default (ADR 236):
 *
 *  1. only when the environment is silent on BOTH provenance and lease — env always wins, so the
 *     harnesses that forward it behave exactly as before;
 *  2. only when `spawner_pid` is the adapter's own parent process — the codex the actuator spawned.
 *     A human session opened in the same workspace during the wake window has a different parent
 *     and reads nothing, which is the whole reason the pid is in the file.
 *
 * `expires_at` bounds the file's life to the work order; the actuator clears it when the run
 * settles, and a stale file past its expiry is ignored even if it survives a crash.
 */
export const WAKE_LEASE_FILE = 'wake-lease.json';

export const WakeLeaseFileSchema = z.object({
  /** The daemon-minted lease id (ADR 241) — opaque, never a session id or a token. */
  lease_id: z.string().min(1).max(64),
  /** Only ever `wake`: the file exists to carry the one provenance the env could not. */
  provenance: z.literal('wake'),
  /** Which backend wrote it — for the audit, and so a mismatched harness can refuse it. */
  harness: z.string().min(1).max(32),
  /** The pid of the harness process the actuator spawned; the adapter honours the file only when
   *  this is its own parent. */
  spawner_pid: z.number().int().positive(),
  started_at: z.number().int().nonnegative(),
  /** Past this the file is dead even if nothing cleared it. */
  expires_at: z.number().int().nonnegative(),
});
export type WakeLeaseFile = z.infer<typeof WakeLeaseFileSchema>;
