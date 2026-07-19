import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { teamCommand } from './team.js';

/**
 * CLI coverage for `musterd team policy` (ADR 146) — the operable surface that flips a team into
 * dogfood-mode re-seat. The read → merge → POST semantics (one knob without clobbering the rest) and
 * the on/off parsing are what this exercises; the server-side re-seat behaviour is covered in the
 * server package's claim tests.
 */
describe('team policy command', () => {
  let server: RunningServer;
  let dir: string;
  let serverUrl: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    serverUrl = `http://127.0.0.1:${port}`;
    process.env['MUSTERD_SERVER'] = serverUrl;
    dir = mkdtempSync(join(tmpdir(), 'musterd-team-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    // Creator becomes the admin and auto-binds this folder, so `team policy` resolves nick without --as.
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

  it('shows the policy with re-seat off by default', async () => {
    const res = await capture(() => teamCommand(parseArgs(['policy'])));
    expect(res.code).toBe(0);
    expect(res.out).toContain('team policy — dawn');
    expect(res.out).toContain('re-seat known agents: off');
  });

  it('turns re-seat on and reads it back', async () => {
    const set = await capture(() =>
      teamCommand(parseArgs(['policy', '--reseat-known-agents', 'on'])),
    );
    expect(set.code).toBe(0);
    expect(set.out).toContain('re-seat known agents on');

    const show = await capture(() => teamCommand(parseArgs(['policy', '--json'])));
    expect(JSON.parse(show.out).standing_reseat_known_agents).toBe(true);
  });

  it('turning re-seat on does not clobber the residency wake defaults (read-merge-write)', async () => {
    const before = JSON.parse(
      (await capture(() => teamCommand(parseArgs(['policy', '--json'])))).out,
    );
    await capture(() => teamCommand(parseArgs(['policy', '--reseat-known-agents', 'on'])));
    const after = JSON.parse(
      (await capture(() => teamCommand(parseArgs(['policy', '--json'])))).out,
    );
    expect(after.residency).toEqual(before.residency);
    expect(after.standing_reseat_known_agents).toBe(true);
  });

  it('can turn re-seat back off', async () => {
    await capture(() => teamCommand(parseArgs(['policy', '--reseat-known-agents', 'on'])));
    await capture(() => teamCommand(parseArgs(['policy', '--reseat-known-agents', 'off'])));
    const show = await capture(() => teamCommand(parseArgs(['policy', '--json'])));
    expect(JSON.parse(show.out).standing_reseat_known_agents).toBe(false);
  });

  it('rejects a non-on/off value', async () => {
    await expect(
      teamCommand(parseArgs(['policy', '--reseat-known-agents', 'maybe'])),
    ).rejects.toThrow(/on\|off/);
  });

  // ADR 149: the ask stream's Slack delivery knob — a secret URL, masked on display, cleared with `off`.
  it('sets the ask Slack webhook, masks it on display, and clears it with off', async () => {
    const url = 'https://hooks.slack.com/services/T000/B000/secretpath';
    const set = await capture(() => teamCommand(parseArgs(['policy', '--ask-slack-webhook', url])));
    expect(set.code).toBe(0);
    expect(set.out).toContain('hooks.slack.com');
    expect(set.out).not.toContain('secretpath'); // the path is the secret — never echoed

    const show = await capture(() => teamCommand(parseArgs(['policy'])));
    expect(show.out).toContain('ask slack webhook: ');
    expect(show.out).toContain('set → hooks.slack.com');
    expect(show.out).not.toContain('secretpath');

    await capture(() => teamCommand(parseArgs(['policy', '--ask-slack-webhook', 'off'])));
    const cleared = await capture(() => teamCommand(parseArgs(['policy', '--json'])));
    expect(JSON.parse(cleared.out).ask_slack_webhook).toBeUndefined();
  });

  it('setting the webhook does not clobber the other policy knobs (read-merge-write)', async () => {
    await capture(() => teamCommand(parseArgs(['policy', '--reseat-known-agents', 'on'])));
    await capture(() =>
      teamCommand(parseArgs(['policy', '--ask-slack-webhook', 'https://hooks.example.com/x'])),
    );
    const after = JSON.parse(
      (await capture(() => teamCommand(parseArgs(['policy', '--json'])))).out,
    );
    expect(after.standing_reseat_known_agents).toBe(true);
    expect(after.ask_slack_webhook).toBe('https://hooks.example.com/x');
  });

  it('rejects a non-https webhook value', async () => {
    await expect(
      teamCommand(parseArgs(['policy', '--ask-slack-webhook', 'http://plain.example.com/x'])),
    ).rejects.toThrow(/https url \| off/);
  });

  // ADR 150 — the enforcement class table setter (the affordance the cell-D experiment declares its
  // block classes with).
  const policyJson = async () =>
    JSON.parse((await capture(() => teamCommand(parseArgs(['policy', '--json'])))).out);

  it('declares a contended-surface class (Gate A), default posture block', async () => {
    await capture(() => teamCommand(parseArgs(['policy', '--enforce-surface', 'src/tariff.ts'])));
    const { enforcement } = await policyJson();
    expect(enforcement.classes).toEqual([
      {
        class: 'src/tariff.ts',
        kind: 'contended-surface',
        match: ['src/tariff.ts'],
        posture: 'block',
      },
    ]);
  });

  it('comma-separates multiple surfaces; --enforce-posture applies to the set', async () => {
    await capture(() =>
      teamCommand(
        parseArgs([
          'policy',
          '--enforce-surface',
          'src/tariff.ts,src/config.ts',
          '--enforce-posture',
          'warn',
        ]),
      ),
    );
    const { enforcement } = await policyJson();
    expect(enforcement.classes.map((c: { class: string }) => c.class)).toEqual([
      'src/tariff.ts',
      'src/config.ts',
    ]);
    expect(enforcement.classes.every((c: { posture: string }) => c.posture === 'warn')).toBe(true);
  });

  it('declares a costly-action class (Gate B) via class=glob', async () => {
    await capture(() =>
      teamCommand(parseArgs(['policy', '--enforce-action', 'force-push=git push --force*'])),
    );
    const { enforcement } = await policyJson();
    expect(enforcement.classes[0]).toEqual({
      class: 'force-push',
      kind: 'costly-action',
      match: ['git push --force*'],
      posture: 'block',
    });
  });

  it('upserts by class name (re-declaring replaces) and merges across calls', async () => {
    await capture(() => teamCommand(parseArgs(['policy', '--enforce-surface', 'src/tariff.ts'])));
    await capture(() =>
      teamCommand(parseArgs(['policy', '--enforce-action', 'merge=gh pr merge*'])),
    );
    // Re-declare src/tariff.ts as warn — replaces, not duplicates.
    await capture(() =>
      teamCommand(
        parseArgs(['policy', '--enforce-surface', 'src/tariff.ts', '--enforce-posture', 'warn']),
      ),
    );
    const { enforcement } = await policyJson();
    expect(enforcement.classes).toHaveLength(2);
    const tariff = enforcement.classes.find((c: { class: string }) => c.class === 'src/tariff.ts');
    expect(tariff.posture).toBe('warn');
  });

  it('--enforce-clear empties the table without clobbering other knobs', async () => {
    await capture(() => teamCommand(parseArgs(['policy', '--reseat-known-agents', 'on'])));
    await capture(() => teamCommand(parseArgs(['policy', '--enforce-surface', 'src/tariff.ts'])));
    await capture(() => teamCommand(parseArgs(['policy', '--enforce-clear'])));
    const after = await policyJson();
    expect(after.enforcement.classes).toEqual([]);
    expect(after.standing_reseat_known_agents).toBe(true); // untouched
  });

  it('rejects a bad posture and a malformed action entry', async () => {
    await expect(
      teamCommand(parseArgs(['policy', '--enforce-surface', 'x', '--enforce-posture', 'loud'])),
    ).rejects.toThrow(/warn \| block/);
    await expect(
      teamCommand(parseArgs(['policy', '--enforce-action', 'no-equals-sign'])),
    ).rejects.toThrow(/class.*=.*glob|force-push/);
  });

  it('the human-readable view lists declared classes', async () => {
    await capture(() => teamCommand(parseArgs(['policy', '--enforce-surface', 'src/tariff.ts'])));
    const show = await capture(() => teamCommand(parseArgs(['policy'])));
    expect(show.out).toContain('enforcement:');
    expect(show.out).toContain('src/tariff.ts');
  });
});
