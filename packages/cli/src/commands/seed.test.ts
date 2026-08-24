import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig, saveBinding } from '../config.js';
import { seedCommand } from './seed.js';
import { teamCommand } from './team.js';

describe('seed command', () => {
  let server: RunningServer;
  let dir: string;
  const seedId = '01SEED00000000000000000000';

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-seed-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));

    const config = loadConfig();
    await new HttpClient({
      server: process.env['MUSTERD_SERVER']!,
      key: config.identities['dawn']!.key,
      seat: 'nick',
    }).addMember('dawn', { name: 'Ada', kind: 'agent' });
    saveBinding(dir, {
      version: 2,
      server: process.env['MUSTERD_SERVER']!,
      team: 'dawn',
      agent_key: config.agentKeys['dawn']!,
      claim: { mode: 'seat', name: 'Ada' },
    });

    const team = server.db.prepare("SELECT id FROM teams WHERE slug = 'dawn'").get() as {
      id: string;
    };
    const member = server.db
      .prepare("SELECT id FROM members WHERE team_id = ? AND name = 'nick'")
      .get(team.id) as { id: string };
    server.db
      .prepare(
        `INSERT INTO seeds
          (id, team_id, relay_id, source, body, captured_at, slack_user_id, submitted_by, state, created_at, updated_at)
         VALUES (?, ?, 'relay-cli-1', 'slack', 'Try a shared Seed tray', ?, 'U123', ?, 'open', ?, ?)`,
      )
      .run(seedId, team.id, Date.now(), member.id, Date.now(), Date.now());
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
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: never) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      return { code: await fn(), out: chunks.join('') };
    } finally {
      spy.mockRestore();
    }
  }

  function bind(name: 'Ada' | 'nick'): void {
    const config = loadConfig();
    saveBinding(dir, {
      version: 2,
      server: process.env['MUSTERD_SERVER']!,
      team: 'dawn',
      agent_key: name === 'Ada' ? config.agentKeys['dawn']! : config.identities['dawn']!.key,
      claim: { mode: 'seat', name },
    });
  }

  function briefFile(): string {
    const path = join(dir, 'brief.json');
    writeFileSync(
      path,
      JSON.stringify({
        problem: 'Ideas disappear before anyone can explore them',
        context: 'The Team needs a shared pre-Lane tray',
        external_evidence: ['Slack relay observation'],
        approaches: [{ approach: 'Shared Seeds', tradeoffs: 'Adds a small lifecycle' }],
        constraints: ['Keep Lanes unchanged'],
        risks: ['Tray clutter'],
        unknowns: ['Capture volume'],
        recommendation: 'Ship the bounded shared tray',
        proposed_lane: { title: 'Build the Seed tray', detail: 'Add CLI, MCP, and web Surfaces' },
      }),
    );
    return path;
  }

  it('lists the active tray and can return protocol JSON', async () => {
    const tray = await capture(() => seedCommand(parseArgs(['list'])));
    expect(tray.out).toContain(`${seedId} open`);
    expect(tray.out).toContain('Try a shared Seed tray');

    const json = await capture(() => seedCommand(parseArgs(['list', '--json'])));
    expect(JSON.parse(json.out)).toMatchObject({ seeds: [{ id: seedId, state: 'open' }] });
  });

  it('claims an open Seed for exploration', async () => {
    const result = await capture(() => seedCommand(parseArgs(['claim', seedId])));

    expect(result).toEqual({
      code: 0,
      out: `✓ Seed ${seedId} — exploring as Ada\n`,
    });
  });

  it('runs the attributed clarification round trip', async () => {
    await capture(() => seedCommand(parseArgs(['claim', seedId])));
    const asked = await capture(() =>
      seedCommand(parseArgs(['ask', seedId, 'Which Surface should lead?'])),
    );
    expect(asked.out).toBe(`✓ Seed ${seedId} — waiting for nick\n`);

    bind('nick');
    const answered = await capture(() =>
      seedCommand(parseArgs(['answer', seedId, 'Start with the CLI Surface.'])),
    );
    expect(answered.out).toBe(`✓ Seed ${seedId} — clarified\n`);
  });

  it('submits an exhaustive brief and promotes the Seed to a Lane', async () => {
    await capture(() => seedCommand(parseArgs(['claim', seedId])));
    const result = await capture(() =>
      seedCommand(parseArgs(['brief', seedId, '--file', briefFile()])),
    );

    expect(result.out).toMatch(new RegExp(`^✓ Seed ${seedId} — promoted to Lane 01`));
  });

  it('concludes exploration without opening a Lane', async () => {
    await capture(() => seedCommand(parseArgs(['claim', seedId])));
    const result = await capture(() =>
      seedCommand(parseArgs(['conclude', seedId, 'Useful, but not now.', '--file', briefFile()])),
    );

    expect(result.out).toBe(`✓ Seed ${seedId} — completed\n`);
  });

  it('manually promotes an open Seed and hides it from the default tray', async () => {
    const promoted = await capture(() =>
      seedCommand(parseArgs(['promote', seedId, '--title', 'Open a bounded Lane'])),
    );
    expect(promoted.out).toMatch(new RegExp(`^✓ Seed ${seedId} — promoted to Lane 01`));

    const tray = await capture(() => seedCommand(parseArgs(['list'])));
    expect(tray.out).toBe("no active Seeds — send an idea through the Team's Slack capture\n");
    const history = await capture(() => seedCommand(parseArgs(['list', '--history'])));
    expect(history.out).toContain(`${seedId} promoted`);
  });
});
