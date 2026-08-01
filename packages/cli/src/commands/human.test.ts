import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { defaultTeamHome } from '../config.js';
import { humanCommand } from './human.js';
import { teamCommand } from './team.js';

/**
 * `musterd human <name>` — the team home (install-topology §4–5).
 *
 * What is worth pinning here is not the happy path's plumbing but the four claims the command makes
 * about *where a person's identity lives*: the floor is written where it says it is (and 0600),
 * a re-run is safe to type without thinking, a home belongs to exactly one team, and the
 * machine-global `current` write is announced rather than silent. The credential branches matter
 * too, because the middle one — on the roster, no local secret — is the state the dogfood machine
 * was actually in, and its only exit destroys a secret somebody else may hold.
 */
describe('human command', () => {
  let server: RunningServer;
  let dir: string;
  let home: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-human-'));
    home = join(dir, 'home');
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    // The command never writes at cwd — but pin it inside the fixture so a stray relative path can't
    // reach the real machine, and so `findBinding`'s walk-up can't see the developer's own binding.
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
  const readHomeBinding = (at = home) =>
    JSON.parse(readFileSync(join(at, '.musterd', 'binding.json'), 'utf8'));
  const run = (args: string[]) => capture(() => humanCommand(parseArgs(args)));
  const json = async (args: string[]) => JSON.parse((await run([...args, '--json'])).out);

  it('stands a new person in the team home: member, 0600 binding, vault, teamHome, online', async () => {
    const out = await json(['lin', '--team', 'dawn', '--home', home]);

    expect(out.member).toBe('lin');
    expect(out.home).toBe(home);
    expect(out.minted).toBe('added');
    expect(out.credential).toMatch(/^mscr_/);
    expect(out.online).toBe(true);

    // The floor: the binding lives at the home, and carries the person's own credential as the
    // seat's bearer secret (the `agent_key` field's shape, whatever the prefix).
    const binding = readHomeBinding();
    expect(binding.team).toBe('dawn');
    expect(binding.claim).toEqual({ mode: 'seat', name: 'lin' });
    expect(binding.agent_key).toBe(out.credential);
    expect(statSync(join(home, '.musterd', 'binding.json')).mode & 0o777).toBe(0o600);

    const config = readConfig();
    expect(config.teamHome.dawn).toBe(home);
    expect(config.identities.dawn).toMatchObject({ name: 'lin', key: out.credential });
    expect(config.knownIdentities).toContainEqual(
      expect.objectContaining({ team: 'dawn', name: 'lin', key: out.credential }),
    );
    // rosterHome is ADR 058's file-backed cutover signal and must NOT be flipped by giving a person
    // somewhere to stand — the two keys compose, they do not merge.
    expect(config.rosterHome).toEqual({});
  });

  it('guards the home against committing the credential it just wrote there', async () => {
    // `team export` guards this folder too, but the home is committable long before anyone exports a
    // roster into it: standing a person up writes an `mscr_` at a visible path under `~`, and `git
    // init` there is a perfectly ordinary next move. So the exclusion belongs to the home's creation.
    const out = await json(['lin', '--team', 'dawn', '--home', home]);
    const ignore = readFileSync(join(home, '.gitignore'), 'utf8');
    expect(ignore).toContain('.musterd/binding.json');
    expect(ignore).toContain('.musterd/pending/');
    // Stated as the property rather than the mechanism: the live credential is on disk under a path
    // this .gitignore excludes.
    expect(readHomeBinding().agent_key).toBe(out.credential);
  });

  it('is idempotent: a re-run reuses the recorded home and the same credential', async () => {
    const first = await json(['lin', '--team', 'dawn', '--home', home]);
    // No --home this time: the recorded teamHome must answer, not the ~/musterd default.
    const second = await json(['lin', '--team', 'dawn']);

    expect(second.home).toBe(home);
    expect(second.minted).toBeNull();
    expect(second.credential).toBeUndefined();
    expect(readHomeBinding().agent_key).toBe(first.credential);
    expect(readConfig().identities.dawn.key).toBe(first.credential);
  });

  it('refuses to write a home that already belongs to another team', async () => {
    mkdirSync(join(home, '.musterd'), { recursive: true });
    writeFileSync(
      join(home, '.musterd', 'binding.json'),
      JSON.stringify({
        server: process.env['MUSTERD_SERVER'],
        team: 'dusk',
        agent_key: 'mscr_someone_elses',
        surface: 'cli',
        claim: { mode: 'seat', name: 'ada' },
      }),
    );

    await expect(run(['lin', '--team', 'dawn', '--home', home])).rejects.toThrow(
      /already the team home for "dusk"/,
    );
    // And it left the other team's floor exactly as it found it.
    expect(readHomeBinding().agent_key).toBe('mscr_someone_elses');
  });

  it('reads the home itself, not an ancestor — a parent binding is not this floor', async () => {
    // `~/musterd/<team>` sits under `~`, which on a real machine may well carry a binding of its
    // own. A walking read (findBinding) would answer with the ancestor's team and refuse to write a
    // perfectly empty home — so the occupancy check must look at exactly one folder.
    const nested = join(home, 'dawn');
    mkdirSync(join(home, '.musterd'), { recursive: true });
    writeFileSync(
      join(home, '.musterd', 'binding.json'),
      JSON.stringify({
        server: process.env['MUSTERD_SERVER'],
        team: 'dusk',
        agent_key: 'mscr_ancestor',
        surface: 'cli',
        claim: { mode: 'seat', name: 'ada' },
      }),
    );

    const out = await json(['lin', '--team', 'dawn', '--home', nested]);
    expect(out.home).toBe(nested);
    expect(readHomeBinding(nested).team).toBe('dawn');
    expect(readHomeBinding(home).agent_key).toBe('mscr_ancestor'); // untouched
  });

  it('refuses to stand a person in an agent seat', async () => {
    await capture(() => teamCommand(parseArgs(['add', 'scout', '--kind', 'agent'])));

    await expect(run(['scout', '--team', 'dawn', '--home', home])).rejects.toThrow(
      /already on "dawn" as a agent, not a human/,
    );
  });

  describe('a member this machine holds no credential for', () => {
    beforeEach(async () => {
      // On the roster, credential shown once and gone — the state the dogfood machine was in.
      await capture(() => teamCommand(parseArgs(['add', 'lin', '--kind', 'human'])));
    });

    it('refuses without --rotate, and names both exits', async () => {
      await expect(run(['lin', '--team', 'dawn', '--home', home])).rejects.toThrow(
        /invalidates their existing credential/,
      );
      // Nothing was provisioned on the refusal — no half-written floor.
      expect(() => readHomeBinding()).toThrow();
      expect(readConfig().teamHome ?? {}).toEqual({});
    });

    it('reuses a credential held only in a recorded binding — never rotates over it', async () => {
      // The pre-team-home state: a credential landed in whatever folder a command was typed in, and
      // has no vault entry. It is held; a rotate here would destroy a working secret to "recover" it.
      const elsewhere = join(dir, 'elsewhere');
      mkdirSync(join(elsewhere, '.musterd'), { recursive: true });
      writeFileSync(
        join(elsewhere, '.musterd', 'binding.json'),
        JSON.stringify({
          server: process.env['MUSTERD_SERVER'],
          team: 'dawn',
          agent_key: 'mscr_held_here',
          surface: 'cli',
          claim: { mode: 'seat', name: 'lin' },
        }),
      );
      const config = readConfig();
      config.bindings[elsewhere] = { team: 'dawn', seat: 'lin', surface: 'cli' };
      writeFileSync(process.env['MUSTERD_CONFIG'] as string, JSON.stringify(config));

      const out = await json(['lin', '--team', 'dawn', '--home', home]);
      expect(out.minted).toBeNull();
      expect(out.credentialFrom).toBe('binding');
      expect(readHomeBinding().agent_key).toBe('mscr_held_here');
    });

    it('treats the team agent key in a human seat as holding nothing, not as a credential', async () => {
      // install-topology §6(a)'s dead binding: an `mskey_` occupied a human seat once, then 403'd on
      // every request. Carrying it forward would rebuild that bug inside the command meant to end it.
      const dead = join(dir, 'dead');
      const agentKey = readConfig().agentKeys.dawn as string;
      mkdirSync(join(dead, '.musterd'), { recursive: true });
      writeFileSync(
        join(dead, '.musterd', 'binding.json'),
        JSON.stringify({
          server: process.env['MUSTERD_SERVER'],
          team: 'dawn',
          agent_key: agentKey,
          surface: 'cli',
          claim: { mode: 'seat', name: 'lin' },
        }),
      );
      const config = readConfig();
      config.bindings[dead] = { team: 'dawn', seat: 'lin', surface: 'cli' };
      writeFileSync(process.env['MUSTERD_CONFIG'] as string, JSON.stringify(config));

      await expect(run(['lin', '--team', 'dawn', '--home', home])).rejects.toThrow(
        /holds no credential for them/,
      );
    });

    it('re-issues with --rotate and stands them up', async () => {
      const out = await json(['lin', '--team', 'dawn', '--home', home, '--rotate']);
      expect(out.minted).toBe('rotated');
      expect(out.credential).toMatch(/^mscr_/);
      expect(readHomeBinding().agent_key).toBe(out.credential);
      expect(out.online).toBe(true);
    });
  });

  it('sets the current team, and says which one it displaced', async () => {
    // `create dawn` set current=dawn; move it away so the switch is observable.
    await capture(() => teamCommand(parseArgs(['create', 'dusk', '--as', 'ada'])));
    expect(readConfig().current).toBe('dusk');

    const res = await run(['lin', '--team', 'dawn', '--home', home]);
    expect(readConfig().current).toBe('dawn');
    // Announced, never silent: this is a machine-global write made on the way past.
    expect(res.out).toContain('current team');
    expect(res.out).toContain('was dusk');
  });

  it('needs a name', async () => {
    await expect(run([])).rejects.toThrow(/usage: musterd human <name>/);
    await expect(run(['two words'])).rejects.toThrow(/usage: musterd human <name>/);
  });

  it('needs a team when the config has no current one', async () => {
    const config = readConfig();
    delete config.current;
    writeFileSync(process.env['MUSTERD_CONFIG'] as string, JSON.stringify(config));

    await expect(run(['lin', '--home', home])).rejects.toThrow(/no team — pass --team <slug>/);
  });

  it('defaults the home under ~/musterd/<team>, not the platform dotdir', () => {
    // The home is a place a person opens, so it is visible on purpose — see install-topology §4.
    expect(defaultTeamHome('dawn').endsWith(join('musterd', 'dawn'))).toBe(true);
    expect(defaultTeamHome('dawn')).not.toContain(join('.musterd'));
  });
});
