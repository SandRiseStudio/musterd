import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enumerateOpencodeSessions, resetSessionScan } from './enumerate.js';

/**
 * ADR 321 §6. OpenCode enumeration shells its own CLI JSON surface, so these tests inject a
 * fixture binary through OPENCODE_BIN — a recorded `session list --format json` payload is the
 * evidence boundary under test, exactly what production parses.
 */
describe('enumerateOpencodeSessions (ADR 321)', () => {
  let ws: string;
  let binDir: string;
  let origBin: string | undefined;

  /** A workspace is anything with a .musterd/binding.json on the walk-up. */
  const workspace = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'adr321-ws-'));
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(join(dir, '.musterd', 'binding.json'), '{}');
    return dir;
  };

  const fakeBin = (stdout: string, exit = '0'): string => {
    const path = join(binDir, `fake-opencode-${Math.random().toString(36).slice(2)}`);
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s' '${stdout.replace(/'/g, `'\\''`)}'\nexit ${exit}\n`,
    );
    chmodSync(path, 0o755);
    return path;
  };

  beforeEach(() => {
    ws = workspace();
    binDir = mkdtempSync(join(tmpdir(), 'adr321-bin-'));
    origBin = process.env['OPENCODE_BIN'];
    resetSessionScan();
  });
  afterEach(() => {
    if (origBin === undefined) delete process.env['OPENCODE_BIN'];
    else process.env['OPENCODE_BIN'] = origBin;
    rmSync(ws, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    resetSessionScan();
  });

  it('attributes by the recorded directory, walked up to the workspace', () => {
    process.env['OPENCODE_BIN'] = fakeBin(
      JSON.stringify([
        {
          id: 'ses_mine',
          title: 't',
          updated: Date.now(),
          created: Date.now(),
          directory: join(ws, 'sub', 'dir'),
        },
        {
          id: 'ses_other',
          title: 't',
          updated: Date.now(),
          created: Date.now(),
          directory: '/elsewhere',
        },
      ]),
    );
    expect(enumerateOpencodeSessions(ws)?.map((f) => f.id)).toEqual(['ses_mine']);
  });

  it('returns [] when the CLI answers but holds nothing for this workspace', () => {
    process.env['OPENCODE_BIN'] = fakeBin(JSON.stringify([]));
    expect(enumerateOpencodeSessions(ws)).toEqual([]);
  });

  it('a nonzero exit or unparseable output is "cannot tell" (undefined), never "no sessions"', () => {
    process.env['OPENCODE_BIN'] = fakeBin('', '1');
    expect(enumerateOpencodeSessions(ws)).toBeUndefined();

    resetSessionScan();
    process.env['OPENCODE_BIN'] = fakeBin('<html>not json</html>');
    expect(enumerateOpencodeSessions(ws)).toBeUndefined();
  });

  it('rows missing identity or ownership fields are skipped, not guessed into this workspace', () => {
    process.env['OPENCODE_BIN'] = fakeBin(
      JSON.stringify([
        { id: 'ses_ok', updated: 1, directory: ws },
        { updated: 2, directory: ws }, // no id
        { id: 'ses_nodir', updated: 3 }, // no directory
      ]),
    );
    expect(enumerateOpencodeSessions(ws)?.map((f) => f.id)).toEqual(['ses_ok']);
  });

  it('newest session first — the liveness judgement reads row order', () => {
    const now = Date.now();
    process.env['OPENCODE_BIN'] = fakeBin(
      JSON.stringify([
        { id: 'ses_old', updated: now - 60_000, directory: ws },
        { id: 'ses_new', updated: now - 1_000, directory: ws },
      ]),
    );
    expect(enumerateOpencodeSessions(ws)?.[0]?.id).toBe('ses_new');
  });
});
