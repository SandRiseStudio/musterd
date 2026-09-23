import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from './args.js';
import { HttpClient } from './client.js';
import { teamCommand } from './commands/team.js';
import { loadConfig } from './config.js';

/**
 * The guidance-epoch JOIN, exercised end to end (ADR 417, lane 01M2NTZ9WV): a real workspace on
 * disk, the CLI's own `HttpClient.claim`, a real server, and an assertion against the row the
 * daemon actually stored.
 *
 * This file exists because of a debt stated twice in this lane's own notes and paid here. Between
 * Task 2 and Task 4 the field was *sent* by the client and *dropped* by the route, and both sides
 * were green the whole time: the client tests stub `fetch` and assert the body, the server tests
 * hand-build a body and assert the row. Neither ever hands its output to the other, so neither can
 * see the seam between them. That is instance 5 of docs/wiki/resolved-then-dropped.md — the same
 * blind spot lane 01M2RTF2D0 walked into one field over, with `model_source`, and closed the same
 * way in `client.claimMirror.e2e.test.ts`.
 *
 * It also closes the second half the unit tests structurally cannot reach: the epoch is read off
 * the FILESYSTEM, so a test that passes a number in has not exercised the attestation at all. Here
 * the number comes from a stamp written into a real directory, exactly as `musterd init` writes it.
 */
describe('guidance epoch JOIN — the workspace on disk is the epoch the daemon stores (ADR 417)', () => {
  let server: RunningServer;
  let dir: string;
  let cwdDir: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-guidance-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'nick.json');
    // `team create` auto-binds the creating folder (ADR 036), so give it a throwaway one to absorb
    // that write — the trap that cost a live seat its credential on 2026-09-17.
    cwdDir = mkdtempSync(join(tmpdir(), 'musterd-guidance-cwd-'));
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

  /** Install a guidance file carrying `version`, the way `writeGuidance` stamps one. */
  function stamp(rel: string, version: number): void {
    const abs = join(cwdDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      `# musterd\n\n<!-- musterd:content v${version} sha256:${'a'.repeat(16)} -->\n`,
    );
  }

  /** Create a team with one agent seat and return the authority a claim needs. */
  async function fixture(): Promise<{ base: string; agentKey: string; grant: string }> {
    const quiet = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await teamCommand(parseArgs(['create', 'dawn', '--member', 'nick']));
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

  /** The epoch the daemon actually stored for a presence, straight out of its own database. */
  function storedEpoch(presenceId: string): number | null {
    return server.db
      .prepare<
        [string],
        { guidance_epoch: number | null }
      >('SELECT guidance_epoch FROM presence WHERE id = ?')
      .get(presenceId)!.guidance_epoch;
  }

  async function claim(base: string, agentKey: string, grant: string) {
    return new HttpClient({ server: base }).claim('dawn', {
      key: agentKey,
      target: { seat: 'Ada' },
      grant,
      surface: 'cli',
    });
  }

  it('the stamp in the workspace files is the epoch on the presence row', async () => {
    const { base, agentKey, grant } = await fixture();
    stamp('.claude/skills/musterd/SKILL.md', 26);
    stamp('.musterd/skill/SKILL.md', 26);

    const out = await claim(base, agentKey, grant);
    expect(out.state).toBe('occupied');
    if (out.state !== 'occupied') return;
    expect(storedEpoch(out.presenceId)).toBe(26);
  });

  /**
   * The ruling that makes the census worth running. A workspace whose files disagree ran the
   * WEAKEST rule in the set, and the weakest rule is the thing a currency census exists to find —
   * so the minimum crosses the wire, not the newest file, and not an average.
   */
  it('a workspace whose files disagree attests the lowest stamp it is running', async () => {
    const { base, agentKey, grant } = await fixture();
    stamp('.claude/skills/musterd/SKILL.md', 26);
    stamp('.claude/skills/musterd-orient/SKILL.md', 24);
    stamp('.musterd/skill/SKILL.md', 26);

    const out = await claim(base, agentKey, grant);
    expect(out.state).toBe('occupied');
    if (out.state !== 'occupied') return;
    expect(storedEpoch(out.presenceId)).toBe(24);
  });

  /**
   * An unprovisioned workspace has nothing to say, and the row must record that as NULL rather than
   * as 0 — which would read as the stalest workspace on the team rather than as an unmeasured one
   * (ADR 236: absence is not an assertion).
   */
  it('an unstamped workspace stores null, never 0', async () => {
    const { base, agentKey, grant } = await fixture();

    const out = await claim(base, agentKey, grant);
    expect(out.state).toBe('occupied');
    if (out.state !== 'occupied') return;
    expect(storedEpoch(out.presenceId)).toBeNull();
  });
});
