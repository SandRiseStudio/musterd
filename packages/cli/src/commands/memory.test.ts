import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { memoryCommand, renderMemoryLine } from './memory.js';
import { statusCommand } from './status.js';
import { teamCommand } from './team.js';

describe('memory command (ADR 093)', () => {
  let server: RunningServer;
  let dir: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-memory-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    process.env['MUSTERD_NO_NUDGE'] = '1';
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
    delete process.env['MUSTERD_NO_NUDGE'];
  });

  async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    try {
      return { code: await fn(), out: chunks.join('') };
    } finally {
      spy.mockRestore();
    }
  }

  // `team create` auto-binds the cwd identity (ADR 036), so commands resolve `nick` from the binding.
  async function setupTeam(): Promise<void> {
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
  }

  it('save → show round-trips the note; clear empties it', async () => {
    await setupTeam();
    const saved = await capture(() =>
      memoryCommand(
        parseArgs(['save', '--headline', 'mid-refactor, tests red', 'left', 'off', 'at', 'ws.ts']),
      ),
    );
    expect(saved.code).toBe(0);
    expect(saved.out).toContain('memory saved');
    expect(saved.out).toContain('"mid-refactor, tests red"');

    const shown = await capture(() => memoryCommand(parseArgs([])));
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('mid-refactor, tests red');
    expect(shown.out).toContain('left off at ws.ts'); // positionals join as the body

    const cleared = await capture(() => memoryCommand(parseArgs(['clear'])));
    expect(cleared.out).toContain('memory cleared');
    const after = await capture(() => memoryCommand(parseArgs(['show'])));
    expect(after.code).toBe(0);
    expect(after.out).toContain('no memory saved');
  });

  it('show is a normal exit-0 message when nothing is saved (not an error)', async () => {
    await setupTeam();
    const res = await capture(() => memoryCommand(parseArgs(['show'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('no memory saved for this seat');
  });

  it('save without --headline is a usage error; over-cap is rejected with the limit named', async () => {
    await setupTeam();
    await expect(memoryCommand(parseArgs(['save', 'body-only']))).rejects.toThrow(/--headline/);
    await expect(memoryCommand(parseArgs(['save', '--headline', 'x'.repeat(200)]))).rejects.toThrow(
      /limit is 120/,
    );
  });

  it('--json passes the raw note through on show', async () => {
    await setupTeam();
    await capture(() => memoryCommand(parseArgs(['save', '--headline', 'h1', 'b1'])));
    const res = await capture(() => memoryCommand(parseArgs(['show', '--json'])));
    const parsed = JSON.parse(res.out);
    expect(parsed).toEqual({ headline: 'h1', body: 'b1', saved_at: expect.any(Number) });
  });

  it('status prints the one-line pointer (headline + age, never the body) when a note exists', async () => {
    await setupTeam();
    await capture(() =>
      memoryCommand(parseArgs(['save', '--headline', 'mid-refactor', 'the secret body'])),
    );
    const res = await capture(() => statusCommand(parseArgs([])));
    // The header carries the *compact* form (it has five other things to say); `claim` keeps the long
    // prose one, where it is the only line on screen. Same facts, and the ADR 093 guarantee holds:
    // headline + age, never the body.
    expect(res.out).toContain('memory');
    expect(res.out).toContain('"mid-refactor"');
    expect(res.out).toContain('musterd memory');
    expect(res.out).not.toContain('the secret body');
  });

  it('status stays silent on the memory line when nothing is saved', async () => {
    await setupTeam();
    const res = await capture(() => statusCommand(parseArgs([])));
    expect(res.out).not.toContain('saved memory');
  });

  it('renderMemoryLine formats headline + age + the load pointer', () => {
    const line = renderMemoryLine(
      { headline: 'mid-refactor of ws.ts eviction, tests red', saved_at: 1000, size_bytes: 42 },
      1000 + 2 * 3600_000,
    );
    expect(line).toContain('saved memory from 2h ago: "mid-refactor of ws.ts eviction, tests red"');
    expect(line).toContain('`musterd memory` to load it');
  });

  it('the compact form states the same facts in one quiet line, clipped to width', () => {
    const env = {
      headline: 'mid-refactor of ws.ts eviction, tests red, and a great deal more besides',
      saved_at: 1000,
      size_bytes: 42,
    };
    const line = renderMemoryLine(env, 1000 + 2 * 3600_000, { compact: true, width: 60 });
    expect(line).toContain('memory');
    expect(line).toContain('2h');
    expect(line).toContain('musterd memory');
    expect(line).toContain('mid-refactor'); // the headline still leads
    expect(line).toContain('…'); // ...clipped, not wrapped — the header is a card, not a paragraph
    expect(line.length).toBeLessThanOrEqual(60);
    // the long prose form is NOT what the header prints
    expect(line).not.toContain('saved memory from');
  });
});
