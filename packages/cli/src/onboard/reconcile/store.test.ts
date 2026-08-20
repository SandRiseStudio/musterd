import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FragmentLedger, ReconcileJournal } from '@musterd/protocol';
import { memoryFs, nodeFs } from './context.js';
import {
  canonicalJson,
  journalPath,
  ledgerPath,
  loadJournal,
  loadLedger,
  loadLockRecord,
  lockPath,
  publishLocalFile,
  readLocalFile,
  removeJournal,
  saveJournal,
  saveLedger,
} from './store.js';
import { z } from 'zod';

const root = '/machine/.musterd';

const ledger: FragmentLedger = {
  version: 1,
  fragments: {
    'folder:/w/a#hooks': {
      harness: 'claude-code',
      scope: 'folder',
      containerKey: 'folder:/w/a:.claude/settings.json',
      fragmentKey: 'hooks.musterd',
      fingerprint: 'f'.repeat(64),
      owners: ['/w/a'],
      adapterVersion: 2,
    },
  },
};

const journal: ReconcileJournal = {
  version: 1,
  operationId: 'op-1',
  action: 'create',
  harness: 'claude-code',
  containerKey: 'folder:/w/a:.claude/settings.json',
  resourceKey: 'folder:/w/a#hooks',
  oldFingerprint: null,
  intendedFingerprint: 'f'.repeat(64),
  oldOwners: [],
  intendedOwners: ['/w/a'],
  worktreeRoot: '/w/a',
  phase: 'prepared',
};

describe('classified local reads (LocalLoad, ADR 282)', () => {
  it('absent file → missing', () => {
    const fs = memoryFs();
    expect(loadLedger(fs, root).kind).toBe('missing');
    expect(loadJournal(fs, root, 'ck').kind).toBe('missing');
    expect(loadLockRecord(fs, root, 'ck').kind).toBe('missing');
  });

  it('current valid version → valid, with the parsed value', () => {
    const fs = memoryFs();
    saveLedger(fs, root, ledger);
    const got = loadLedger(fs, root);
    expect(got.kind).toBe('valid');
    if (got.kind === 'valid')
      expect(got.value.fragments['folder:/w/a#hooks']?.owners).toEqual(['/w/a']);
  });

  it('invalid JSON → invalid, and the issues never quote file contents', () => {
    const fs = memoryFs();
    fs.writeFile(ledgerPath(root), '{ not json', 0o600);
    const got = loadLedger(fs, root);
    expect(got.kind).toBe('invalid');
    if (got.kind === 'invalid') {
      expect(got.issues.length).toBeGreaterThan(0);
      expect(JSON.stringify(got.issues)).not.toContain('not json');
    }
  });

  it('unknown version → invalid, never legacy', () => {
    const fs = memoryFs();
    fs.writeFile(ledgerPath(root), JSON.stringify({ ...ledger, version: 99 }), 0o600);
    expect(loadLedger(fs, root).kind).toBe('invalid');
  });

  it('unknown keys and malformed values → invalid', () => {
    const fs = memoryFs();
    fs.writeFile(ledgerPath(root), JSON.stringify({ ...ledger, extra: 1 }), 0o600);
    expect(loadLedger(fs, root).kind).toBe('invalid');
    fs.writeFile(journalPath(root, 'ck'), JSON.stringify({ ...journal, action: 'adopt' }), 0o600);
    expect(loadJournal(fs, root, 'ck').kind).toBe('invalid');
  });

  it('a recognized previous shape → legacy only when the caller supplies a recognizer', () => {
    const fs = memoryFs();
    const CurrentSchema = z.object({ version: z.literal(2), name: z.string() }).strict();
    fs.writeFile('/machine/.musterd/thing.json', JSON.stringify({ name: 'old' }), 0o600);
    const withRecognizer = readLocalFile(fs, '/machine/.musterd/thing.json', CurrentSchema, {
      legacy: (value) =>
        typeof value === 'object' && value !== null && !('version' in value) && 'name' in value,
    });
    expect(withRecognizer.kind).toBe('legacy');
    const without = readLocalFile(fs, '/machine/.musterd/thing.json', CurrentSchema);
    expect(without.kind).toBe('invalid');
  });
});

describe('canonical atomic writes', () => {
  it('canonicalJson sorts keys at every depth and ends with a newline', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } });
    const b = canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
  });

  it('validates before any write, writes a same-directory 0600 tmp, fsyncs, renames, fsyncs the dir', () => {
    const fs = memoryFs();
    saveLedger(fs, root, ledger);
    const path = ledgerPath(root);
    const ops = fs.log.filter((op) => op.op !== 'mkdirp');
    expect(ops.map((op) => op.op)).toEqual(['writeFile', 'fsyncFile', 'rename', 'fsyncDir']);
    const write = ops[0]! as { op: 'writeFile'; path: string; mode: number };
    expect(write.path.startsWith(`${path}.`)).toBe(true);
    expect(write.path.endsWith('.tmp')).toBe(true);
    expect(write.mode).toBe(0o600);
    const rename = ops[2]! as { op: 'rename'; from: string; to: string };
    expect(rename.from).toBe(write.path);
    expect(rename.to).toBe(path);
    const dirSync = ops[3]! as { op: 'fsyncDir'; path: string };
    expect(path.startsWith(dirSync.path)).toBe(true);
  });

  it('a rejected object throws and leaves the old file and prepared journal byte-identical', () => {
    const fs = memoryFs();
    saveLedger(fs, root, ledger);
    saveJournal(fs, root, journal);
    const ledgerBytes = fs.readFile(ledgerPath(root));
    const journalBytes = fs.readFile(journalPath(root, journal.containerKey));
    const before = fs.log.length;
    expect(() =>
      saveLedger(fs, root, { ...ledger, version: 99 } as unknown as FragmentLedger),
    ).toThrow(/harness-ledger/);
    expect(fs.log.length).toBe(before); // no fs call at all after a schema rejection
    expect(fs.readFile(ledgerPath(root))).toBe(ledgerBytes);
    expect(fs.readFile(journalPath(root, journal.containerKey))).toBe(journalBytes);
  });

  it('the thrown diagnostic names the file kind and schema issues, never contents or secrets', () => {
    const fs = memoryFs();
    const poisoned = {
      ...journal,
      operationId: '',
      containerKey: 'folder:/w/a:mskey_secret_container',
    };
    let message = '';
    try {
      saveJournal(fs, root, poisoned as unknown as ReconcileJournal);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('harness-journal');
    expect(message).toContain('operationId');
    expect(message).not.toContain('mskey_secret_container');
  });

  it('journal round-trip: save → load valid → remove → missing', () => {
    const fs = memoryFs();
    saveJournal(fs, root, journal);
    expect(loadJournal(fs, root, journal.containerKey).kind).toBe('valid');
    removeJournal(fs, root, journal.containerKey);
    expect(loadJournal(fs, root, journal.containerKey).kind).toBe('missing');
  });

  it('journal and lock paths hash the container key — no path bytes from the key reach the filesystem', () => {
    const key = 'repo:/Users/someone/secret-project:.mcp.json';
    expect(journalPath(root, key)).not.toContain('secret-project');
    expect(lockPath(root, key)).not.toContain('secret-project');
    expect(journalPath(root, key)).toMatch(/harness-journal\/[0-9a-f]{64}\.json$/);
    expect(lockPath(root, key)).toMatch(/harness-locks\/[0-9a-f]{64}\.lock$/);
  });

  it('the default (real) seam round-trips through the actual filesystem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-store-'));
    saveLedger(nodeFs, dir, ledger);
    expect(JSON.parse(readFileSync(ledgerPath(dir), 'utf8')).version).toBe(1);
    writeFileSync(ledgerPath(dir), '{ nope', 'utf8');
    expect(loadLedger(nodeFs, dir).kind).toBe('invalid');
  });
});
