import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BINDING_DIR, WAKE_LEASE_FILE, WakeLeaseFileSchema } from '@musterd/protocol';

/** What the adapter learns from a wake-lease file it is entitled to honour. */
export interface WakeLeaseFromFile {
  lease_id: string;
  harness: string;
}

/**
 * Read the actuator-written wake lease (ADR 354) from `<workspace>/.musterd/wake-lease.json`, and
 * honour it only if it names THIS process's parent and has not expired. Undefined otherwise — a
 * missing, malformed, expired, or foreign file is silence, never an error: this sits on the mount
 * path of every adapter, and the common case (no file at all) must cost one failed `readFileSync`.
 *
 * The caller decides whether it is even allowed to look — `loadMcpConfig` asks only when the
 * environment carried neither `MUSTERD_PROVENANCE` nor `MUSTERD_WAKE_LEASE`.
 */
export function readWakeLeaseFile(
  workspace: string,
  deps: { now: number; ppid: number },
): WakeLeaseFromFile | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(workspace, BINDING_DIR, WAKE_LEASE_FILE), 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = WakeLeaseFileSchema.safeParse(parsed);
  if (!result.success) return undefined;
  const lease = result.data;
  // The two conditions that make this an attestation and not a default (ADR 236): the file must
  // name the process that spawned us, and it must still be inside the wake it was written for.
  if (lease.spawner_pid !== deps.ppid) return undefined;
  if (deps.now >= lease.expires_at) return undefined;
  return { lease_id: lease.lease_id, harness: lease.harness };
}
