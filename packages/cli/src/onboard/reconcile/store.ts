import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  FragmentLedgerSchema,
  HarnessLockRecordSchema,
  ReconcileJournalSchema,
  type FragmentLedger,
  type HarnessLockRecord,
  type LocalLoad,
  type LocalStateIssue,
  type ReconcileJournal,
} from '@musterd/protocol';
import type { z } from 'zod';
import { parentDir, type FsSeam } from './context.js';

/**
 * Canonical validated stores for the multi-harness reconciler (ADR 282). One rule, one place:
 * every writer validates the COMPLETE intended object through the strict current schema before a
 * byte moves, serializes with stable key order and a trailing newline, and publishes atomically —
 * same-directory 0600 tmp file, fsync, rename, fsync of the parent directory. A rejected object
 * leaves the previous file (and any prepared journal) byte-identical, because rejection happens
 * before the first filesystem call.
 */

/** JSON with objects' keys sorted at every depth — so equal values hash and diff identically. */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Map Zod issues to the transportable shape — paths and messages only, never file contents. */
function toIssues(error: z.ZodError): LocalStateIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '<root>',
    message: issue.message,
  }));
}

/**
 * Read + classify one local-state file (ADR 282 `LocalLoad`): absent → `missing`; invalid JSON,
 * unknown version/key, or malformed value → `invalid`; a shape the optional `legacy` recognizer
 * accepts → `legacy`. `legacy` requires recognition — nothing is legacy by default.
 */
export function readLocalFile<S extends z.ZodTypeAny>(
  fs: FsSeam,
  path: string,
  schema: S,
  opts?: { legacy?: (value: unknown) => boolean },
): LocalLoad<z.infer<S>> {
  const raw = fs.readFile(path);
  if (raw === null) return { kind: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', issues: [{ path: '<file>', message: 'not valid JSON' }] };
  }
  const result = schema.safeParse(parsed);
  if (result.success) return { kind: 'valid', value: result.data as z.infer<S> };
  if (opts?.legacy?.(parsed)) return { kind: 'legacy', value: parsed };
  return { kind: 'invalid', issues: toIssues(result.error) };
}

/**
 * Validate the complete intended object, then publish atomically. `kind` names the file kind in
 * the rejection diagnostic (never contents). Rejection throws BEFORE any filesystem call.
 */
export function publishLocalFile<S extends z.ZodTypeAny>(
  fs: FsSeam,
  path: string,
  schema: S,
  value: unknown,
  kind: string,
): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = toIssues(result.error)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
    throw new Error(
      `refusing to write an invalid ${kind} — ${detail}. The strict reader would classify this ` +
        'write as invalid, turning a local bug into a hard operational failure (ADR 286 §3).',
    );
  }
  const data = canonicalJson(result.data);
  const dir = parentDir(path);
  fs.mkdirp(dir);
  const tmp = `${path}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  fs.writeFile(tmp, data, 0o600);
  fs.fsyncFile(tmp);
  fs.rename(tmp, path);
  fs.fsyncDir(dir);
}

/** Hash a container key for use as a filename — no path bytes from the key reach the filesystem. */
function keyHash(containerKey: string): string {
  return createHash('sha256').update(containerKey, 'utf8').digest('hex');
}

export function ledgerPath(machineConfigRoot: string): string {
  return join(machineConfigRoot, 'harness-ledger.json');
}

export function journalPath(machineConfigRoot: string, containerKey: string): string {
  return join(machineConfigRoot, 'harness-journal', `${keyHash(containerKey)}.json`);
}

export function lockPath(machineConfigRoot: string, containerKey: string): string {
  return join(machineConfigRoot, 'harness-locks', `${keyHash(containerKey)}.lock`);
}

export function loadLedger(fs: FsSeam, machineConfigRoot: string): LocalLoad<FragmentLedger> {
  return readLocalFile(fs, ledgerPath(machineConfigRoot), FragmentLedgerSchema);
}

export function saveLedger(fs: FsSeam, machineConfigRoot: string, ledger: FragmentLedger): void {
  publishLocalFile(
    fs,
    ledgerPath(machineConfigRoot),
    FragmentLedgerSchema,
    ledger,
    'harness-ledger',
  );
}

export function loadJournal(
  fs: FsSeam,
  machineConfigRoot: string,
  containerKey: string,
): LocalLoad<ReconcileJournal> {
  return readLocalFile(fs, journalPath(machineConfigRoot, containerKey), ReconcileJournalSchema);
}

export function saveJournal(
  fs: FsSeam,
  machineConfigRoot: string,
  journal: ReconcileJournal,
): void {
  publishLocalFile(
    fs,
    journalPath(machineConfigRoot, journal.containerKey),
    ReconcileJournalSchema,
    journal,
    'harness-journal',
  );
}

export function removeJournal(fs: FsSeam, machineConfigRoot: string, containerKey: string): void {
  fs.rm(journalPath(machineConfigRoot, containerKey));
}

export function loadLockRecord(
  fs: FsSeam,
  machineConfigRoot: string,
  containerKey: string,
): LocalLoad<HarnessLockRecord> {
  return readLocalFile(fs, lockPath(machineConfigRoot, containerKey), HarnessLockRecordSchema);
}

export function saveLockRecord(
  fs: FsSeam,
  machineConfigRoot: string,
  containerKey: string,
  record: HarnessLockRecord,
): void {
  publishLocalFile(
    fs,
    lockPath(machineConfigRoot, containerKey),
    HarnessLockRecordSchema,
    record,
    'harness-lock',
  );
}

export function removeLockRecord(
  fs: FsSeam,
  machineConfigRoot: string,
  containerKey: string,
): void {
  fs.rm(lockPath(machineConfigRoot, containerKey));
}
