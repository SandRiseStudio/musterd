import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from './args.js';
import { HttpClient } from './client.js';
import { teamCommand } from './commands/team.js';
import { loadConfig } from './config.js';

/**
 * The JOIN, exercised end to end: the CLI's own `HttpClient.claim` against a real server, asserting
 * the row the daemon actually stored (ADR 301, lane 01M2RTF2D0).
 *
 * This file exists because of what the lane's two halves could NOT prove between them.
 * `client.claim.test.ts` stubs `fetch` and asserts the POST body carries `model_source`;
 * `server/.../claim-http.test.ts` (#1549) hand-builds a body with `model_source` and asserts the
 * presence row. Both are green against a client and a server that disagree about the field's name,
 * because neither ever hands its output to the other — the exact blind spot recorded as instance 5
 * of docs/wiki/resolved-then-dropped.md, written the same day and then walked into twice.
 *
 * The live check that first caught this was a read of the daemon's `presence` table after running
 * the built CLI. That is not repeatable in CI, and a one-off manual probe is not a guard — so the
 * same assertion lives here, over an in-memory server, where it runs on every push.
 */
describe('claim mirror JOIN — the CLI client is believed by a real server (ADR 301)', () => {
  let server: RunningServer;
  let dir: string;
  let cwdDir: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-mirror-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'nick.json');
    // `team create` auto-binds the creating folder (ADR 036), so give it a throwaway one to absorb
    // that write. Learned the hard way on 2026-09-17: run it in a live seat worktree and it
    // overwrites that workspace's binding, seat credential and all.
    cwdDir = mkdtempSync(join(tmpdir(), 'musterd-mirror-cwd-'));
    vi.spyOn(process, 'cwd').mockReturnValue(cwdDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwdDir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
  });

  /** Create a team with one agent seat and return the authority a claim needs. */
  async function fixture(): Promise<{ base: string; agentKey: string; grant: string }> {
    const quiet = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await teamCommand(parseArgs(['create', 'dawn', '--as', 'nick']));
      await teamCommand(parseArgs(['add', 'Ada', '--kind', 'agent']));
    } finally {
      quiet.mockRestore();
    }
    const cfg = loadConfig();
    const base = process.env['MUSTERD_SERVER']!;
    const res = await fetch(`${base}/teams/dawn/grants`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.identities['dawn']!.key}`,
      },
      body: JSON.stringify({ scope: 'seat', target: 'Ada', lifetime: 'standing' }),
    });
    const { token } = (await res.json()) as { token: string };
    return { base, agentKey: cfg.agentKeys['dawn']!, grant: token };
  }

  /** The tier the daemon actually stored for a presence, straight out of its own database. */
  function storedTier(presenceId: string): { model: string | null; model_source: string | null } {
    return server.db
      .prepare<
        [string],
        { model: string | null; model_source: string | null }
      >('SELECT model, model_source FROM presence WHERE id = ?')
      .get(presenceId)!;
  }

  it('a tier the client resolved is the tier the daemon stores', async () => {
    const { base, agentKey, grant } = await fixture();
    const out = await new HttpClient({
      server: base,
      model: 'claude-fable-5',
      modelSource: 'observed',
    }).claim('dawn', { key: agentKey, target: { seat: 'Ada' }, grant, surface: 'cli' });

    expect(out.state).toBe('occupied');
    if (out.state !== 'occupied') return;
    expect(storedTier(out.presenceId)).toEqual({
      model: 'claude-fable-5',
      model_source: 'observed',
    });
  });

  /**
   * The rung that makes the tier worth carrying at all: a provisioning snapshot must not arrive
   * looking like a measurement. Same id, different evidence class, and the row can tell them apart.
   */
  it('a declaration is stored as a declaration, not as an observation', async () => {
    const { base, agentKey, grant } = await fixture();
    const out = await new HttpClient({
      server: base,
      model: 'claude-fable-5',
      modelSource: 'binding',
    }).claim('dawn', { key: agentKey, target: { seat: 'Ada' }, grant, surface: 'cli' });

    expect(out.state).toBe('occupied');
    if (out.state !== 'occupied') return;
    expect(storedTier(out.presenceId).model_source).toBe('binding');
  });

  /** An older client that sends no tier still occupies, and its row records null rather than a
   *  plausible-looking guess (ADR 236 — absence is not an assertion). */
  it('a client that resolved no tier leaves the row null, and still occupies', async () => {
    const { base, agentKey, grant } = await fixture();
    vi.stubEnv('MUSTERD_MODEL', '');
    vi.stubEnv('ANTHROPIC_MODEL', '');
    const out = await new HttpClient({ server: base, model: 'claude-fable-5' }).claim('dawn', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant,
      surface: 'cli',
    });

    expect(out.state).toBe('occupied');
    if (out.state !== 'occupied') return;
    expect(storedTier(out.presenceId)).toEqual({ model: 'claude-fable-5', model_source: null });
    vi.unstubAllEnvs();
  });
});
