import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig, rememberIdentity, saveConfig } from '../config.js';
import { claimAgentHttp } from '../test-auth.js';
import { doneCommand } from './done.js';
import { laneCommand, lanesCommand } from './lane.js';
import { nextCommand } from './next.js';
import { sendCommand } from './send.js';
import { teamCommand } from './team.js';

/** Covers the orientation pair: `musterd next` (the brief) and `musterd done` (close + chain). */
describe('next / done commands', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-orient-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
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

  async function lastLaneId(): Promise<string> {
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as { lanes: { id: string }[] };
    return lanes[lanes.length - 1]!.id;
  }

  /**
   * The banner reached NO CLI seat through increments 1 and 2 — it was written into the MCP renderer
   * and never here, on the surface that most needs orientation. ADR 266 calls it "the cheapest,
   * highest-leverage piece" precisely because the measured waste was seats STARTING SESSIONS into a
   * shared red they assumed was theirs, and `musterd next` is where a CLI session starts.
   */
  it("next leads with an open incident, above the seat's own work", async () => {
    await capture(() =>
      sendCommand(parseArgs(['--as', 'nick', '--blocked-by', 'ci:gates/A11y contrast'])),
    );
    await capture(() => teamCommand(parseArgs(['add', 'izzo', '--kind', 'agent'])));
    const cfg = loadConfig();
    const authority = await claimAgentHttp(
      serverUrl,
      'dawn',
      cfg.agentKeys['dawn'] as string,
      cfg.identities['dawn']!.key,
      'izzo',
    );
    rememberIdentity(cfg, {
      team: 'dawn',
      name: 'izzo',
      key: authority.key,
      surface: 'cli',
      sessionLease: authority.sessionLease,
    });
    saveConfig(cfg);
    await capture(() =>
      sendCommand(parseArgs(['--as', 'izzo', '--blocked-by', 'ci:gates/A11y contrast'])),
    );

    const res = await capture(() => nextCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('incident: ci:gates/A11y contrast');
    expect(res.out).toMatch(/not yours/);
    // Above everything: it must come before the seat's own work, or they decide what they are
    // doing before learning the red is shared. (The incident lane ALSO shows under `up next` — it
    // is unowned and any seat may claim it, which is the design, so that is the anchor here.)
    expect(res.out.indexOf('incident:')).toBeLessThan(res.out.indexOf('up next'));
  });

  it('next renders the empty-brief hint when nothing is in flight', async () => {
    const res = await capture(() => nextCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('nothing in flight');
  });

  it('next renders carrying + up-next once lanes exist', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'carried', '--claim'])));
    await capture(() => laneCommand(parseArgs(['open', 'available'])));
    const res = await capture(() => nextCommand(parseArgs([])));
    expect(res.out).toContain('carrying');
    expect(res.out).toContain('carried');
    expect(res.out).toContain('up next');
  });

  it('next --json emits the raw brief', async () => {
    const res = await capture(() => nextCommand(parseArgs(['--json'])));
    const brief = JSON.parse(res.out) as { member: string; in_flight: unknown[] };
    expect(brief.member).toBe('nick');
    expect(Array.isArray(brief.in_flight)).toBe(true);
  });

  it('done auto-targets the caller single live lane and closes it', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'finish me', '--claim'])));
    const res = await capture(() => doneCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('done');
    expect(res.out).toContain('finish me');
  });

  it('done <id> closes a named lane', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'named', '--claim'])));
    const id = await lastLaneId();
    const res = await capture(() => doneCommand(parseArgs([id])));
    expect(res.out).toContain('done');
  });

  it('done errors when there is no live lane', async () => {
    await expect(doneCommand(parseArgs([]))).rejects.toThrow(/no live lane/);
  });

  it('done errors when the caller owns several live lanes', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'one', '--claim'])));
    await capture(() => laneCommand(parseArgs(['open', 'two', '--claim'])));
    await expect(doneCommand(parseArgs([]))).rejects.toThrow(/live lanes/);
  });

  it('done chains into up-next when other open lanes exist', async () => {
    // Another seat opens work so the brief has an up-next entry after we close ours.
    await new HttpClient({
      server: serverUrl,
      key: loadConfig().identities['dawn']!.key,
    }).openLane('dawn', { title: 'downstream' });
    await capture(() => laneCommand(parseArgs(['open', 'mine', '--claim'])));
    const res = await capture(() => doneCommand(parseArgs([])));
    expect(res.out).toContain('up next');
    expect(res.out).toContain('downstream');
  });

  /**
   * ADR 373 increment 4. The nine intentions the 2026-09-03 sweep found were all legible to a human
   * reading the file and invisible to every surface; `next` is where a CLI session starts, so this
   * is the surface that decides whether a captured intention is ever picked up.
   */
  it('leads the up-next section with recorded intentions, above the open lanes', async () => {
    await capture(() => laneCommand(parseArgs(['open', 'a backlog item'])));
    const team = server.db.prepare("SELECT id FROM teams WHERE slug = 'dawn'").get() as {
      id: string;
    };
    const nick = server.db
      .prepare("SELECT id FROM members WHERE team_id = ? AND name = 'nick'")
      .get(team.id) as { id: string };
    server.db
      .prepare(
        `INSERT INTO seeds
           (id, team_id, relay_id, source, body, captured_at, slack_user_id, submitted_by, state, created_at, updated_at)
         VALUES ('01SEEDNEXT0000000000000000', ?, 'repo:docs/decisions/354-x.md#left-for-a-sibling-lane',
                 'repo', 'Left for a sibling lane; this ADR fixes the attestation.', 1, NULL, ?, 'open', 1, 1)`,
      )
      .run(team.id, nick.id);

    const res = await capture(() => nextCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('recorded intentions nobody has started');
    expect(res.out).toContain('docs/decisions/354-x.md#left-for-a-sibling-lane');
    expect(res.out).toContain('musterd seed claim 01SEEDNEXT0000000000000000');
    // Above the open lanes: a Seed is the same question one step earlier.
    expect(res.out.indexOf('recorded intentions')).toBeLessThan(
      res.out.indexOf('open lanes you could pick up'),
    );
  });
});
