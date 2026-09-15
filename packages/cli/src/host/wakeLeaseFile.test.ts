import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BINDING_DIR,
  WAKE_LEASE_FILE,
  WakeLeaseFileSchema,
  type WakeLeaseFile,
} from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearWakeLeaseFile, writeWakeLeaseFile } from './wakeLeaseFile.js';

/**
 * The actuator's half of the wake-lease channel (ADR 354), against a real tmpdir.
 *
 * Why this file exists at all: `codex.ts`'s tests inject `writeWakeLease`/`clearWakeLease` doubles,
 * so every assertion there proves the CALL and nothing about the implementation — the
 * boundary-injection shape (docs/wiki/boundary-injection.md), caught by ryder reviewing #1187. The
 * behaviour with the most at stake — `clearWakeLeaseFile` refusing to delete a file that carries a
 * DIFFERENT lease — had no test that could fail if the comparison inverted, and the symptom of that
 * inversion (a slow settle stealing a newer wake's lease) is worse than the bug ADR 354 fixed.
 */

let ws: string;
const NOW = 1_800_000_000_000;
const lease = (id: string): WakeLeaseFile => ({
  lease_id: id,
  provenance: 'wake',
  harness: 'codex',
  spawner_pid: 4242,
  started_at: NOW,
  expires_at: NOW + 1_800_000,
});
const path = () => join(ws, BINDING_DIR, WAKE_LEASE_FILE);

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'musterd-wake-lease-writer-'));
});
afterEach(() => {
  try {
    chmodSync(join(ws, BINDING_DIR), 0o700);
  } catch {
    /* may not exist */
  }
  rmSync(ws, { recursive: true, force: true });
});

describe('writeWakeLeaseFile', () => {
  it('writes a file the reader schema accepts, creating .musterd if absent, owner-only', () => {
    expect(existsSync(join(ws, BINDING_DIR))).toBe(false);
    writeWakeLeaseFile(ws, lease('A'));
    const parsed = WakeLeaseFileSchema.parse(JSON.parse(readFileSync(path(), 'utf8')));
    expect(parsed).toEqual(lease('A'));
    expect(statSync(path()).mode & 0o777).toBe(0o600);
  });

  it('tightens a pre-existing world-readable file — writeFileSync alone would not', () => {
    // A file left 0644 by an older build must not stay 0644 just because it already existed:
    // `mode` on writeFileSync applies only at creation.
    mkdirSync(join(ws, BINDING_DIR), { recursive: true });
    writeFileSync(path(), '{}', { mode: 0o644 });
    expect(statSync(path()).mode & 0o777).toBe(0o644);
    writeWakeLeaseFile(ws, lease('A'));
    expect(statSync(path()).mode & 0o777).toBe(0o600);
  });

  it('is best-effort: an unwritable workspace does not throw — the env channel is still in place', () => {
    mkdirSync(join(ws, BINDING_DIR), { recursive: true });
    chmodSync(join(ws, BINDING_DIR), 0o500);
    expect(() => writeWakeLeaseFile(ws, lease('A'))).not.toThrow();
    expect(existsSync(path())).toBe(false);
  });
});

describe('clearWakeLeaseFile — removes only the lease it was asked about', () => {
  it('removes the file when it carries the same lease', () => {
    writeWakeLeaseFile(ws, lease('A'));
    clearWakeLeaseFile(ws, 'A');
    expect(existsSync(path())).toBe(false);
  });

  it('LEAVES the file when it carries a different lease — a slow settle must not steal a newer wake’s', () => {
    // The sharpest edge in ADR 354: wake A settles late, after wake B has already written its own
    // file in the same workspace. A's clear must be a no-op, or B's adapter reads nothing and B
    // dies exactly the way every codex wake died before the fix.
    writeWakeLeaseFile(ws, lease('A'));
    writeWakeLeaseFile(ws, lease('B'));
    clearWakeLeaseFile(ws, 'A');
    expect(existsSync(path())).toBe(true);
    expect(JSON.parse(readFileSync(path(), 'utf8')).lease_id).toBe('B');
  });

  it('is a no-op on a missing or unreadable file', () => {
    expect(() => clearWakeLeaseFile(ws, 'A')).not.toThrow();
    mkdirSync(join(ws, BINDING_DIR), { recursive: true });
    writeFileSync(path(), '{not json');
    expect(() => clearWakeLeaseFile(ws, 'A')).not.toThrow();
    expect(existsSync(path())).toBe(true);
  });
});
