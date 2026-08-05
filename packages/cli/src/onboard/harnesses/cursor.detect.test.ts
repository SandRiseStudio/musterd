import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cursor } from './cursor.js';

/**
 * The doctor's baked-env inspection could see only Claude Code, because `claude mcp get` was the one
 * entry anything ever read back. Everything it flags — a stale claim, a legacy model snapshot, a
 * per-seat grant or agent key in a shared slot — was unreportable for Cursor by construction.
 *
 * Measured 2026-08-03 on the dogfood machine: one seat's `.cursor/mcp.json`, written before ADR 165
 * stopped baking env, carried `MUSTERD_AGENT_KEY` and `MUSTERD_GRANT` (per-seat secrets) alongside a
 * stale `MUSTERD_SURFACE` — the value that made that seat report the wrong harness for a full day
 * (PR #607). The doctor had nothing to say about any of it.
 */

let dir: string;
let prev: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-cursor-detect-'));
  mkdirSync(join(dir, '.cursor'), { recursive: true });
  prev = process.cwd();
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(prev);
  rmSync(dir, { recursive: true, force: true });
});

const writeEntry = (env: Record<string, string>, args = ['/x/packages/mcp/dist/index.js']): void =>
  writeFileSync(
    join(dir, '.cursor', 'mcp.json'),
    JSON.stringify({ mcpServers: { musterd: { command: 'node', args, env } } }, null, 2),
  );

describe('cursor detect reads its own entry back', () => {
  it('is the measured entry: secrets and a stale surface, all now reportable', () => {
    writeEntry({
      MUSTERD_SERVER: 'http://127.0.0.1:4849',
      MUSTERD_TEAM: 'revive',
      MUSTERD_AGENT_KEY: 'mskey_secret',
      MUSTERD_GRANT: 'msgr_secret',
      MUSTERD_SURFACE: 'cursor',
      MUSTERD_AUTOJOIN: '1',
    });
    return cursor.detect().then((d) => {
      expect(d.registeredAgentKey).toBe('mskey_secret');
      expect(d.registeredGrant).toBe('msgr_secret');
      expect(d.registeredSurface).toBe('cursor');
      expect(d.registeredAutojoin).toBe('1');
      // MUSTERD_SERVER / MUSTERD_TEAM are merely redundant, not drift — they are identical across
      // every seat, so they are deliberately not in the inspected set.
      expect(d.registeredModel).toBeUndefined();
    });
  });

  it('reports the launch args, so an adapter from another seat is spottable', async () => {
    writeEntry({}, ['/other-seat/packages/mcp/dist/index.js']);
    const d = await cursor.detect();
    expect(d.registeredArgs).toEqual(['/other-seat/packages/mcp/dist/index.js']);
  });

  it('says nothing about an entry provisioning wrote today (ADR 165: it carries no env)', async () => {
    writeEntry({});
    const d = await cursor.detect();
    expect(d.registeredAgentKey).toBeUndefined();
    expect(d.registeredSurface).toBeUndefined();
    expect(d.registeredGrant).toBeUndefined();
  });

  it('drops a present-but-blank value rather than reporting a baked empty string', async () => {
    // An env key set to '' is not a baked value; flagging it sends the reader hunting for nothing.
    writeEntry({ MUSTERD_SURFACE: '', MUSTERD_GRANT: '   ' });
    const d = await cursor.detect();
    expect(d.registeredSurface).toBeUndefined();
    expect(d.registeredGrant).toBeUndefined();
  });

  it('reports nothing when the folder has no cursor entry at all', async () => {
    const d = await cursor.detect();
    expect(d.registeredSurface).toBeUndefined();
    expect(d.registeredArgs).toBeUndefined();
  });

  // Cursor's detect already falls back to the GLOBAL `~/.cursor/mcp.json`, but `configure` only ever
  // writes the project file — so drift read from the global one was reported with the project file's
  // repair. That is the same false-prescription shape ADR 168 is about, one file over: `musterd wire`
  // would report success having rewritten a file that was never the problem.
  describe('an entry read from the global config', () => {
    let home: string;
    let prevHome: string | undefined;
    beforeEach(() => {
      home = join(dir, 'home');
      mkdirSync(join(home, '.cursor'), { recursive: true });
      prevHome = process.env['HOME'];
      process.env['HOME'] = home;
    });
    afterEach(() => {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
    });

    it('is reported with the file it lives in, which no repair here rewrites', async () => {
      writeFileSync(
        join(home, '.cursor', 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            musterd: { command: 'node', args: [], env: { MUSTERD_SURFACE: 'cursor' } },
          },
        }),
      );
      const d = await cursor.detect();
      expect(d.configured).toBe(true);
      expect(d.registeredSurface).toBe('cursor');
      expect(d.registeredElsewhere).toBe(join(home, '.cursor', 'mcp.json'));
    });

    it('leaves it unset for a project entry — the file configure writes', async () => {
      writeEntry({ MUSTERD_SURFACE: 'cursor' });
      const d = await cursor.detect();
      expect(d.registeredElsewhere).toBeUndefined();
    });
  });
});
