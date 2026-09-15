import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enumerateGrokSessions, resetSessionScan } from './enumerate.js';

let home: string;

afterEach(() => {
  resetSessionScan();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('enumerateGrokSessions (ADR 352)', () => {
  it('attributes a summary.json by info.cwd and ignores a foreign workspace', () => {
    home = mkdtempSync(join(tmpdir(), 'musterd-grok-sessions-'));
    const mine = mkdtempSync(join(tmpdir(), 'musterd-grok-ws-'));
    const other = mkdtempSync(join(tmpdir(), 'musterd-grok-other-'));
    mkdirSync(join(mine, '.musterd'));
    mkdirSync(join(other, '.musterd'));
    writeFileSync(
      join(mine, '.musterd', 'binding.json'),
      '{"version":2,"server":"http://127.0.0.1:4849","team":"dawn"}',
    );
    writeFileSync(
      join(other, '.musterd', 'binding.json'),
      '{"version":2,"server":"http://127.0.0.1:4849","team":"dawn"}',
    );
    const write = (cwd: string, id: string) => {
      const dir = join(home, 'sessions', encodeURIComponent(cwd), id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'summary.json'),
        JSON.stringify({
          info: { id, cwd },
          last_active_at: '2026-09-02T17:00:00.000Z',
        }),
      );
    };
    write(mine, 'sess-mine');
    write(other, 'sess-other');
    const rows = enumerateGrokSessions(mine, home);
    expect(rows?.map((r) => r.id)).toEqual(['sess-mine']);
  });

  it('returns undefined when GROK_HOME/sessions cannot be read', () => {
    expect(
      enumerateGrokSessions('/tmp/no-such-ws', join(tmpdir(), 'no-grok-home-xyz')),
    ).toBeUndefined();
  });
});
