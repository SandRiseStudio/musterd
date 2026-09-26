import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeEnvelope, type TraceReport } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { HttpClient } from '../client.js';
import { loadConfig } from '../config.js';
import { setColorEnabled } from '../render/theme.js';
import { sweepSeriesPath } from '../session/sweep-series.js';
import { goalCommand } from './goal.js';
import { renderTraceReport, reportCommand } from './report.js';
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
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--member', 'nick'])));
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
    expect(res.out).toContain('peer demand');
    expect(res.out).toContain('challenges received');
    expect(res.out).toContain('steering');
    expect(res.out).toContain('time to unblock');
    expect(res.out).toContain('ignored help');
    expect(res.out).toContain('stalled threads');
    expect(res.out).toContain('circular handoffs');
    expect(res.out).toContain('model diversity');

    const asJson = await capture(() => reportCommand(parseArgs(['coordination', '--json'])));
    const parsed = JSON.parse(asJson.out) as {
      coordination: unknown;
      peer_demand: { window_days: number };
      mast: unknown;
      steering: unknown;
    };
    expect(parsed.coordination).toBeDefined();
    expect(parsed.peer_demand.window_days).toBe(7);
    expect(parsed.mast).toBeDefined();
    expect(parsed.steering).toBeDefined();
  });
});

describe('report trace (ADR 445 increment 4)', () => {
  let server: RunningServer;
  let dir: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-report-trace-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await captureOut(() => teamCommand(parseArgs(['create', 'dawn', '--member', 'nick'])));
    setColorEnabled(false);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['MUSTERD_SERVER'];
    delete process.env['MUSTERD_CONFIG'];
  });

  async function captureOut(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
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

  const sample: TraceReport = {
    window_days: 7,
    seats: ['ryder', 'izzo'],
    coverage: [
      {
        harness: 'claude-code',
        sessions: 3,
        sessions_with_r2: 2,
        post_tool_use: 40,
        r2_tool_uses: 50,
        coverage: 0.8,
      },
      {
        harness: 'codex',
        sessions: 1,
        sessions_with_r2: 0,
        post_tool_use: 9,
        r2_tool_uses: 0,
        coverage: null,
      },
    ],
    tool_mix: [
      { harness: 'claude-code', tool: 'Bash', calls: 30, errors: 2, avg_duration_ms: 412 },
      { harness: 'codex', tool: 'apply_patch', calls: 4, errors: 0, avg_duration_ms: null },
    ],
    lane_cost: [
      {
        lane: '01M3FDM0HTR4AFBSRDSHYCHP94',
        title: 'ADR 445 increment 4 — views over trace_events',
        state: 'claimed',
        seat: 'ryder',
        goal_id: 'research-corpus',
        turns: 12,
        input_tokens: 120_000,
        output_tokens: 8_500,
        cache_read_tokens: 900_000,
      },
    ],
    unattributed: { turns: 2, input_tokens: 300, output_tokens: 40, cache_read_tokens: 0 },
  };

  it('renders coverage, tool mix and cost per lane in the report vocabulary', () => {
    const out: string[] = [];
    renderTraceReport(sample, 'dawn', (s) => void out.push(s));
    const text = out.join('');
    expect(text).toContain('trace — dawn · last 7d · 2 seats readable');
    expect(text).toContain('claude-code — 80% (40 / 50) · 3 sessions, 2 with R2');
    expect(text).toContain('codex — no R2 tool calls (9 / 0) · 1 session, 0 with R2');
    expect(text).toContain('Bash claude-code — 30 calls · 2 errors · avg 412ms');
    expect(text).toContain('apply_patch codex — 4 calls');
    expect(text).toContain('01M3FDM0HT ADR 445 increment 4 — views over trace_events');
    expect(text).toContain('ryder · claimed · 12 turns · in 120,000 · out 8,500 · cache 900,000');
    expect(text).toContain('unattributed — 2 turns outside any lane window · in 300 · out 40');
  });

  it('--json returns the daemon report end to end; a bad --days is a usage error', async () => {
    const http = new HttpClient({
      server: process.env['MUSTERD_SERVER']!,
      key: loadConfig().identities['dawn']!.key,
      seat: 'nick',
    });

    // seed one structural row through the real tap route
    await http.request('POST', '/teams/dawn/trace/events', {
      events: [
        {
          harness: 'claude-code',
          session_digest: 'abcdef012345',
          ts: Date.now(),
          kind: 'PostToolUse',
          tool_name: 'Bash',
        },
      ],
    });
    const { code, out } = await captureOut(() => reportCommand(parseArgs(['trace', '--json'])));
    expect(code).toBe(0);
    const json = JSON.parse(out) as TraceReport;
    expect(json.window_days).toBe(7);
    expect(json.coverage).toEqual([
      {
        harness: 'claude-code',
        sessions: 1,
        sessions_with_r2: 0,
        post_tool_use: 1,
        r2_tool_uses: 0,
        coverage: null,
      },
    ]);
    expect(json.tool_mix[0]).toMatchObject({ tool: 'Bash', calls: 1 });
    await expect(reportCommand(parseArgs(['trace', '--days', 'x']))).rejects.toThrow(/usage/);
  });
});
