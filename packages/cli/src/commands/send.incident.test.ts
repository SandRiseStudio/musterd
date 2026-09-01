import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { loadConfig, rememberIdentity, saveConfig } from '../config.js';
import { claimAgentHttp } from '../test-auth.js';
import { inboxCommand } from './inbox.js';
import { lanesCommand } from './lane.js';
import { sendCommand } from './send.js';
import { teamCommand } from './team.js';

/**
 * Incident convergence increment 2 — the probe increment 1's eval never got.
 *
 * Increment 1's integration tests build the report envelope BY HAND
 * (`meta: { blocked_by: … }` posted straight to HTTP), so they proved the daemon clusters a
 * well-formed report and nothing about whether any seat could produce one. The measured answer was
 * that a CLI seat could not: zero reports were ever filed. This walks the whole path a seat actually
 * walks — real `musterd send` against a real daemon — and asserts the convergence at the far end.
 *
 * The gate on increment 2's routing/wake work is this test going green.
 */
describe('a CLI seat can converge a shared blocker (incident convergence inc 2)', () => {
  const GATE = 'ci:gates/A11y contrast';
  let server: RunningServer;
  let dir: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-incident-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'nick'])));
    // Three reporters, because clustering counts DISTINCT seats: two to trip the threshold and a
    // third to land on the already-open incident. The seats are given vault identities directly
    // rather than walked through the claim handshake — the claim ceremony is covered by claim.test,
    // and what is under test here is everything downstream of `musterd send`.
    for (const seat of ['izzo', 'dolly']) {
      await capture(() =>
        teamCommand(parseArgs(['add', seat, '--kind', 'agent', '--role', 'platform'])),
      );
      const config = loadConfig();
      const authority = await claimAgentHttp(
        process.env['MUSTERD_SERVER']!,
        'dawn',
        config.agentKeys['dawn'] as string,
        config.identities['dawn']!.key,
        seat,
      );
      rememberIdentity(config, {
        team: 'dawn',
        name: seat,
        key: authority.key,
        surface: 'cli',
        sessionLease: authority.sessionLease,
      });
      saveConfig(config);
    }
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

  /** Exactly what the failing gate tells a seat to type. */
  const report = (seat: string, extra: string[] = []) =>
    capture(() => sendCommand(parseArgs(['--as', seat, '--blocked-by', GATE, ...extra])));

  async function incidentLanes(): Promise<
    { id: string; title: string; owner_seat: string | null }[]
  > {
    const board = await capture(() => lanesCommand(parseArgs(['--json'])));
    const { lanes } = JSON.parse(board.out) as {
      lanes: { id: string; title: string; kind?: string | null; owner_seat: string | null }[];
    };
    return lanes.filter((l) => l.kind === 'incident');
  }

  it('one report pools without opening anything', async () => {
    expect((await report('izzo')).code).toBe(0);
    expect(await incidentLanes()).toHaveLength(0);
  });

  it('the second distinct seat converges the red into ONE owned-able incident lane', async () => {
    expect((await report('izzo', ['--ref', 'pr#828'])).code).toBe(0);
    expect(
      (await report('dolly', ['--ref', 'pr#830', '--sig', 'lc-office__caption 2.83'])).code,
    ).toBe(0);

    const incidents = await incidentLanes();
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.title).toBe(`incident: ${GATE}`);
    // Unowned on purpose — any seat may claim it, context beats role (spec §3).
    expect(incidents[0]!.owner_seat).toBeNull();
  });

  it('a third report is told to park behind the lane instead of debugging it', async () => {
    await report('izzo');
    await report('dolly');
    const [incident] = await incidentLanes();
    await report('nick');

    const inbox = await capture(() => inboxCommand(parseArgs(['--as', 'nick', '--json'])));
    expect(inbox.out).toContain(incident!.id);
    expect(inbox.out).toMatch(/park behind it/);
  });

  it('the same seat reporting twice does not fake a cluster', async () => {
    // CLUSTER_THRESHOLD counts DISTINCT seats — one seat retrying its own red is not two seats
    // hitting one defect, and treating it as one would open incidents nobody else is blocked by.
    await report('izzo');
    await report('izzo', ['--ref', 'pr#829']);
    expect(await incidentLanes()).toHaveLength(0);
  });

  it('a raised threshold holds the incident back until the third seat reports', async () => {
    await capture(() => teamCommand(parseArgs(['policy', '--incident-threshold', '3'])));
    await report('izzo');
    await report('dolly');
    expect(await incidentLanes()).toHaveLength(0);
    await report('nick');
    expect(await incidentLanes()).toHaveLength(1);
  });

  it('--incident off degrades to pre-increment-1 exactly', async () => {
    await capture(() => teamCommand(parseArgs(['policy', '--incident', 'off'])));
    await report('izzo');
    await report('dolly');
    expect(await incidentLanes()).toHaveLength(0);
    // And nothing was pooled either, so turning it back on does not spring an incident out of
    // reports filed while the team had it switched off.
    await capture(() => teamCommand(parseArgs(['policy', '--incident', 'on'])));
    await report('izzo');
    expect(await incidentLanes()).toHaveLength(0);
  });

  it('an ordinary status_update from both seats opens nothing', async () => {
    await capture(() =>
      sendCommand(parseArgs(['--as', 'izzo', '--act', 'status_update', 'shipping the lane board'])),
    );
    await capture(() =>
      sendCommand(parseArgs(['--as', 'dolly', '--act', 'status_update', 'still on the sweep'])),
    );
    expect(await incidentLanes()).toHaveLength(0);
  });
});
