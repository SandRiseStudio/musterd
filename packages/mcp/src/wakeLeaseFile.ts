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
  // The workspace ROOT (what `resolveBindingDir` returns), never the `.musterd` dir itself — this
  // joins `BINDING_DIR` on. Named so the call site reads right without checking (ryder, #1187).
  workspaceRoot: string,
  // `ancestors` is a thunk: the walk costs one `ps` per hop and must run only once a file has
  // been found and parsed — the common case (no file) pays nothing.
  deps: { now: number; ancestors: () => readonly number[] },
): WakeLeaseFromFile | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(workspaceRoot, BINDING_DIR, WAKE_LEASE_FILE), 'utf8');
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
  // name a process in OUR ancestry — the one the actuator spawned — and it must still be inside the
  // wake it was written for. Ancestry rather than the parent alone because the harness the actuator
  // spawns is not always the one that launches us: `codex` is a Node wrapper that spawns the native
  // binary, so the actuator's child is our grandparent (the live falsifier for #1187 refused on
  // exactly that hop). Expiry is checked first — it is free, and a dead file must not cost a `ps`.
  if (deps.now >= lease.expires_at) return undefined;
  if (!deps.ancestors().includes(lease.spawner_pid)) return undefined;
  return { lease_id: lease.lease_id, harness: lease.harness };
}
