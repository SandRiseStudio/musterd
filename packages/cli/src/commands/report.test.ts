import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeEnvelope } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig } from '../config.js';
import { sweepSeriesPath } from '../session/sweep-series.js';
import { goalCommand } from './goal.js';
import { reportCommand } from './report.js';
import { teamCommand } from './team.js';

describe('report command', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;
  let adminKey: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-report-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
    adminKey = loadConfig().identities['dawn']!.key;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
  });

  /** Write the ADR 166 sweep series where `report` reads it (under this test's MUSTERD_CONFIG). */
  function writeSweep(rows: Record<string, unknown>[]): void {
    const path = sweepSeriesPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }

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

  it('renders the team digest by default', async () => {
    const res = await capture(() => reportCommand(parseArgs([])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('report — dawn');
    expect(res.out).toContain('flow');
    expect(res.out).toContain('coordination');
    expect(res.out).toContain('steering');
    expect(res.out).toContain('waiting on');
  });

  it('--altitude ic renders the goals board', async () => {
    await capture(() => goalCommand(parseArgs(['declare', 'A goal', '--goal-id', 'g'])));
    const res = await capture(() => reportCommand(parseArgs(['--altitude', 'ic'])));
    expect(res.out).toContain('goals');
    expect(res.out).toContain('A goal');
  });

  it('--altitude exec renders milestones + exceptions', async () => {
    const res = await capture(() => reportCommand(parseArgs(['--altitude', 'exec'])));
    expect(res.out).toContain('milestones');
    expect(res.out).toContain('exceptions');
    expect(res.out).toContain('none — on track');
  });

  it('says nothing about liveness when the sweep has never run or found nothing', async () => {
    // Silence at zero is the design: ADR 166's target for this metric is zero, and a line printed
    // on every report stops reading as an exception.
    const clean = await capture(() => reportCommand(parseArgs([])));
    expect(clean.out).not.toContain('liveness');
    writeSweep([{ at: Date.now(), demoted: 0, workspaces: [] }]);
    const still = await capture(() => reportCommand(parseArgs([])));
    expect(still.out).not.toContain('liveness');
  });

  it('surfaces a demoted workspace on both team and exec, and marks a confirmed repeat', async () => {
    writeSweep([
      { at: Date.now() - 600_000, demoted: 1, workspaces: [{ workspace: '/w/a', demoted: true }] },
      {
        at: Date.now(),
        demoted: 2,
        workspaces: [
          { workspace: '/w/a', demoted: true },
          { workspace: '/w/b', demoted: true },
        ],
      },
    ]);
    const team = await capture(() => reportCommand(parseArgs([])));
    expect(team.out).toContain('liveness-demoted (confirmed)');
    expect(team.out).toContain('repeat  /w/a');
    expect(team.out).toContain('first  /w/b');

    const exec = await capture(() => reportCommand(parseArgs(['--altitude', 'exec'])));
    expect(exec.out).toContain('liveness-demoted');
    // It is an exception, so the all-clear must not also print.
    expect(exec.out).not.toContain('none — on track');
  });

  it('--json emits the raw report', async () => {
    const res = await capture(() => reportCommand(parseArgs(['--json'])));
    const report = JSON.parse(res.out) as { team: string; goals: unknown[] };
    expect(report.team).toBe('dawn');
    expect(Array.isArray(report.goals)).toBe(true);
  });

  it('rejects an unknown altitude', async () => {
    await expect(reportCommand(parseArgs(['--altitude', 'bogus']))).rejects.toThrow(/usage/);
  });

  it('report delivery lists the open directed ledger (empty)', async () => {
    const res = await capture(() => reportCommand(parseArgs(['delivery'])));
    expect(res.out).toContain('open directed acts');
    expect(res.out).toContain('none');
  });

  it('report delivery surfaces an unanswered directed act, and <id> shows its journey', async () => {
    const admin = new HttpClient({ server: serverUrl, key: adminKey });
    await admin.addMember('dawn', { name: 'Ada', kind: 'agent' });
    const envelope = makeEnvelope({
      id: ulid(),
      team: 'dawn',
      from: 'nick',
      to: { kind: 'member', name: 'Ada' },
      act: 'request_help',
      body: 'need a hand',
      thread: null,
      meta: null,
    });
    await admin.send('dawn', envelope);
    const list = await capture(() => reportCommand(parseArgs(['delivery'])));
    expect(list.out).toContain('request_help');
    expect(list.out).toContain('Ada');
    const one = await capture(() => reportCommand(parseArgs(['delivery', envelope.id, '--json'])));
    const ledger = JSON.parse(one.out) as { id: string; recipients: unknown[] };
    expect(ledger.id).toBe(envelope.id);
    expect(ledger.recipients.length).toBeGreaterThan(0);
  });

  it('report coordination renders the MAST page (and --json)', async () => {
    const res = await capture(() => reportCommand(parseArgs(['coordination'])));
    expect(res.out).toContain('coordination — dawn');
    expect(res.out).toContain('steering');
    expect(res.out).toContain('time to unblock');
    expect(res.out).toContain('ignored help');
    expect(res.out).toContain('stalled threads');
    expect(res.out).toContain('circular handoffs');
    expect(res.out).toContain('model diversity');

    const asJson = await capture(() => reportCommand(parseArgs(['coordination', '--json'])));
    const parsed = JSON.parse(asJson.out) as {
      coordination: unknown;
      mast: unknown;
      steering: unknown;
    };
    expect(parsed.coordination).toBeDefined();
    expect(parsed.mast).toBeDefined();
    expect(parsed.steering).toBeDefined();
  });
});
