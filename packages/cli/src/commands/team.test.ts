import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(res.out).toContain('review loop: off');
    expect(res.out).toContain('dispatch loop: off');
  });

  it('turns the dispatch loop on and reads it back', async () => {
    const set = await capture(() => teamCommand(parseArgs(['policy', '--dispatch-loop', 'on'])));
    expect(set.code).toBe(0);
    expect(set.out).toContain('dispatch loop on');

    const show = await capture(() => teamCommand(parseArgs(['policy', '--json'])));
    expect(JSON.parse(show.out).loops).toEqual({ review: false, dispatch: true, sweep: false });
  });

  it('turns the review loop on and reads it back', async () => {
    const set = await capture(() => teamCommand(parseArgs(['policy', '--review-loop', 'on'])));
    expect(set.code).toBe(0);
    expect(set.out).toContain('review loop on');

    const show = await capture(() => teamCommand(parseArgs(['policy', '--json'])));
    expect(JSON.parse(show.out).loops).toEqual({ review: true, dispatch: false, sweep: false });
  });

  it('changes the dispatch loop without clobbering another policy knob', async () => {
    await capture(() => teamCommand(parseArgs(['policy', '--reseat-known-agents', 'on'])));
    await capture(() => teamCommand(parseArgs(['policy', '--dispatch-loop', 'on'])));

    const show = await capture(() => teamCommand(parseArgs(['policy', '--json'])));
    expect(JSON.parse(show.out).standing_reseat_known_agents).toBe(true);
    expect(JSON.parse(show.out).loops).toEqual({ review: false, dispatch: true, sweep: false });
  });

  it('changes the review loop without clobbering dispatch', async () => {
    await capture(() => teamCommand(parseArgs(['policy', '--dispatch-loop', 'on'])));
    await capture(() => teamCommand(parseArgs(['policy', '--review-loop', 'on'])));

    const show = await capture(() => teamCommand(parseArgs(['policy', '--json'])));
    expect(JSON.parse(show.out).loops).toEqual({ review: true, dispatch: true, sweep: false });
  });

  it('rejects a dispatch-loop value other than on or off', async () => {
    await expect(teamCommand(parseArgs(['policy', '--dispatch-loop', 'maybe']))).rejects.toThrow(
      /--dispatch-loop <on\|off>/,
    );
  });

  it('rejects a review-loop value other than on or off', async () => {
    await expect(teamCommand(parseArgs(['policy', '--review-loop', 'maybe']))).rejects.toThrow(
      /--review-loop <on\|off>/,
    );
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

  // ADR 244: the operable setter the daemon field shipped without. Read-merge-write, same as
  // every other policy knob — a raw POST of only stakes_defaults would wipe loops/reseat/secrets.
  it('sets a stakes-default rule, shows it, and clears it with off', async () => {
    const set = await capture(() =>
      teamCommand(parseArgs(['policy', '--stakes-default', 'packages/web/**=low'])),
    );
    expect(set.code).toBe(0);
    expect(set.out).toContain('packages/web/** → low');

    const show = await capture(() => teamCommand(parseArgs(['policy'])));
    expect(show.out).toContain('stakes defaults:');
    expect(show.out).toContain('packages/web/** → low');

    const json = JSON.parse(
      (await capture(() => teamCommand(parseArgs(['policy', '--json'])))).out,
    );
    expect(json.stakes_defaults).toEqual([{ surface: 'packages/web/**', stakes: 'low' }]);

    await capture(() => teamCommand(parseArgs(['policy', '--stakes-default', 'off'])));
    const cleared = JSON.parse(
      (await capture(() => teamCommand(parseArgs(['policy', '--json'])))).out,
    );
    expect(cleared.stakes_defaults).toEqual([]);
  });

  it('upserts the same surface in place and appends a new one', async () => {
    await capture(() =>
      teamCommand(parseArgs(['policy', '--stakes-default', 'packages/web/**=low'])),
    );
    await capture(() =>
      teamCommand(parseArgs(['policy', '--stakes-default', 'packages/web/**=normal'])),
    );
    await capture(() =>
      teamCommand(parseArgs(['policy', '--stakes-default', 'packages/cli/**=high'])),
    );
    const json = JSON.parse(
      (await capture(() => teamCommand(parseArgs(['policy', '--json'])))).out,
    );
    expect(json.stakes_defaults).toEqual([
      { surface: 'packages/web/**', stakes: 'normal' },
      { surface: 'packages/cli/**', stakes: 'high' },
    ]);
  });

  it('setting a stakes-default does not clobber other policy knobs', async () => {
    await capture(() => teamCommand(parseArgs(['policy', '--reseat-known-agents', 'on'])));
    await capture(() => teamCommand(parseArgs(['policy', '--review-loop', 'on'])));
    await capture(() =>
      teamCommand(parseArgs(['policy', '--stakes-default', 'packages/web/**=low'])),
    );
    const after = JSON.parse(
      (await capture(() => teamCommand(parseArgs(['policy', '--json'])))).out,
    );
    expect(after.standing_reseat_known_agents).toBe(true);
    expect(after.loops).toEqual({ review: true, dispatch: false, sweep: false });
    expect(after.stakes_defaults).toEqual([{ surface: 'packages/web/**', stakes: 'low' }]);
  });

  it('rejects a stakes-default that is not surface=low|normal|high or off', async () => {
    await expect(
      teamCommand(parseArgs(['policy', '--stakes-default', 'packages/web/**'])),
    ).rejects.toThrow(/--stakes-default/);
    await expect(
      teamCommand(parseArgs(['policy', '--stakes-default', 'packages/web/**=tiny'])),
    ).rejects.toThrow(/--stakes-default/);
  });
});

/**
 * `musterd team credential <name>` — the lost-credential recovery verb (§6(b) of install-topology).
 *
 * The behaviours worth pinning are the local repairs, because they are what makes the rotate usable
 * with nothing pasted: the vault + active identity + the folder binding all go stale the instant the
 * server re-mints, and a rotate for *someone else* must leave every one of them alone.
 */
describe('team credential command', () => {
  let server: RunningServer;
  let dir: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-cred-'));
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

  const readConfig = () =>
    JSON.parse(readFileSync(process.env['MUSTERD_CONFIG'] as string, 'utf8'));
  const readBinding = () => JSON.parse(readFileSync(join(dir, '.musterd', 'binding.json'), 'utf8'));

  it('re-issues my own credential and repairs the vault, the active identity, and this binding', async () => {
    const before = readConfig();
    const lost = before.identities.dawn.key as string;

    const res = await capture(() =>
      teamCommand(parseArgs(['credential', 'nick', '--team', 'dawn', '--json'])),
    );
    expect(res.code).toBe(0);
    const out = JSON.parse(res.out);
    expect(out.credential).toMatch(/^mscr_/);
    expect(out.credential).not.toBe(lost);
    expect(out.repaired).toEqual({ identity: true, binding: true });

    const after = readConfig();
    expect(after.identities.dawn.key).toBe(out.credential);
    expect(after.knownIdentities.find((i: any) => i.name === 'nick').key).toBe(out.credential);
    // …and the binding, which is what `musterd board` reads to sign this human in (ADR 170).
    expect(readBinding().agent_key).toBe(out.credential);
  });

  it('prints the credential once, and says what it rewrote', async () => {
    const res = await capture(() =>
      teamCommand(parseArgs(['credential', 'nick', '--team', 'dawn'])),
    );
    expect(res.out).toMatch(/mscr_/);
    expect(res.out).toMatch(/shown once/i);
    expect(res.out).toMatch(/saved identity/i);
    expect(res.out).toMatch(/musterd board/);
  });

  it("rotating someone else's credential touches nothing local", async () => {
    await capture(() => teamCommand(parseArgs(['add', 'Lin', '--kind', 'human'])));
    const before = readConfig();
    const beforeBinding = readBinding();

    const res = await capture(() =>
      teamCommand(parseArgs(['credential', 'Lin', '--team', 'dawn', '--json'])),
    );
    const out = JSON.parse(res.out);
    expect(out.member).toBe('Lin');
    expect(out.repaired).toEqual({ identity: false, binding: false });
    // Lin was never a local identity, so nothing was created for her and nick's stayed put.
    expect(readConfig()).toEqual(before);
    expect(readBinding()).toEqual(beforeBinding);
  });

  it('refuses an agent seat with the daemon reason, and writes nothing locally', async () => {
    await capture(() => teamCommand(parseArgs(['add', 'Ada', '--kind', 'agent'])));
    const before = readConfig();
    await expect(
      capture(() => teamCommand(parseArgs(['credential', 'Ada', '--team', 'dawn', '--json']))),
    ).rejects.toThrow(/agent seat/i);
    expect(readConfig()).toEqual(before);
  });

  it('needs a name and a team', async () => {
    // The verb's own usage line, not the subcommand-dispatch one — otherwise this passes even when
    // `credential` isn't a verb at all.
    await expect(capture(() => teamCommand(parseArgs(['credential'])))).rejects.toThrow(
      /usage: musterd team credential <name>/,
    );
  });
});

/**
 * `musterd team export --to` and its default (ADR 176 increment 3).
 *
 * install-topology §4 answered migration-bootstrap.md's open question — "which repo owns the roster
 * when several touch one team?" — by saying **no repo does**: the roster's home is the *team's*
 * home. Exporting into whatever folder you happened to stand in is how that question arose. So the
 * destination defaults to the team home when one exists.
 *
 * The two things that must NOT change are the reason `teamHome` and `rosterHome` are separate keys
 * at all: exporting still records `rosterHome` (ADR 058's file-authoritative cutover signal), and
 * having a home never implies the flip — nor does exporting invent a home.
 */
describe('team export — the roster lands in the team home', () => {
  let server: RunningServer;
  let dir: string;
  let home: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-export-'));
    home = join(dir, 'home');
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    await capture(() => teamCommand(parseArgs(['create', 'dawn', '--as', 'ada'])));
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

  const readConfig = () =>
    JSON.parse(readFileSync(process.env['MUSTERD_CONFIG'] as string, 'utf8'));
  const setTeamHome = () => {
    const c = readConfig();
    c.teamHome = { dawn: home };
    writeFileSync(process.env['MUSTERD_CONFIG'] as string, JSON.stringify(c));
  };
  const exportJson = async (args: string[]) =>
    JSON.parse((await capture(() => teamCommand(parseArgs(['export', ...args, '--json'])))).out);

  it('defaults into the team home, and says that is why', async () => {
    setTeamHome();

    const out = await exportJson(['dawn']);

    expect(out.rosterHome).toBe(home);
    expect(out.destination).toBe('teamHome');
    expect(existsSync(join(home, '.musterd', 'team.toml'))).toBe(true);
    // Not in the folder the command was typed in.
    expect(existsSync(join(dir, '.musterd', 'team.toml'))).toBe(false);
  });

  it('still records rosterHome — the ADR 058 cutover signal survives the new default', async () => {
    setTeamHome();

    await exportJson(['dawn']);

    expect(readConfig().rosterHome.dawn).toBe(home);
  });

  it('an explicit --to wins over the team home', async () => {
    setTeamHome();
    const elsewhere = join(dir, 'elsewhere');

    const out = await exportJson(['dawn', '--to', elsewhere]);

    expect(out.rosterHome).toBe(elsewhere);
    expect(out.destination).toBe('flag');
    expect(existsSync(join(elsewhere, '.musterd', 'team.toml'))).toBe(true);
    expect(existsSync(join(home, '.musterd', 'team.toml'))).toBe(false);
  });

  it('falls back to this folder when the team has no home — unchanged for everyone else', async () => {
    const out = await exportJson(['dawn']);

    expect(out.rosterHome).toBe(dir);
    expect(out.destination).toBe('cwd');
    expect(existsSync(join(dir, '.musterd', 'team.toml'))).toBe(true);
  });

  it('never invents a team home as a side effect of exporting', async () => {
    // The keys compose, they do not merge: `rosterHome` is the cutover signal, `teamHome` is where a
    // person stands. Exporting must not quietly provision the second.
    await exportJson(['dawn']);

    expect(readConfig().teamHome ?? {}).toEqual({});
  });
});
