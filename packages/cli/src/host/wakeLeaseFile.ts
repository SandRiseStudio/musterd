import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BINDING_DIR, WAKE_LEASE_FILE, type WakeLeaseFile } from '@musterd/protocol';

/**
 * The actuator's half of the wake-lease file channel (ADR 354): written beside `binding.json` right
 * after a harness child is spawned, naming that child's pid, and cleared when the run settles. The
 * adapter's half (`packages/mcp/src/wakeLeaseFile.ts`) honours it only from a process whose parent
 * is that pid, and only while unexpired — so the write here is safe to make before verification
 * concludes, and a crash that leaves the file behind is bounded by `expires_at`.
 *
 * Best-effort on purpose: a workspace the actuator cannot write to must not fail the wake — the env
 * channel is still in place, and on a harness that forwards it the file is redundant anyway.
 */
export function writeWakeLeaseFile(workspace: string, lease: WakeLeaseFile): void {
  try {
    mkdirSync(join(workspace, BINDING_DIR), { recursive: true });
    writeFileSync(join(workspace, BINDING_DIR, WAKE_LEASE_FILE), JSON.stringify(lease) + '\n', {
      mode: 0o600,
    });
  } catch {
    /* best-effort: the env channel is still in place */
  }
}

/**
 * Remove the file — but only if it still carries THIS lease. A slower settle must not delete the
 * file a newer wake in the same workspace just wrote.
 */
export function clearWakeLeaseFile(workspace: string, leaseId: string): void {
  const path = join(workspace, BINDING_DIR, WAKE_LEASE_FILE);
  try {
    const current = JSON.parse(readFileSync(path, 'utf8')) as { lease_id?: unknown };
    if (current.lease_id !== leaseId) return;
    rmSync(path, { force: true });
  } catch {
    /* already gone, or unreadable — nothing to clear */
  }
}
