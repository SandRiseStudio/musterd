import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultHue, legacyHue } from '@musterd/protocol/hue';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { loadConfig, saveConfig } from '../config.js';
import { teamCommand } from './team.js';

/**
 * `musterd team hue` (ADR 374). On a DB-only team the daemon owns the hue and the command talks to
 * it; on a file-backed team the seat file owns it and the command edits the file — the same split
 * `team add` already makes. `--assign-missing` is the one-time pass that colours a roster that
 * predates hues, seeded from the hash the web painted before, so only colliding seats move.
 */
describe('team hue', () => {
  let server: RunningServer;
  let dir: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-hue-'));
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
  const team = (args: string[]) => capture(() => teamCommand(parseArgs(args)));

  describe('on a DB-only team, the daemon owns the hue', () => {
    it('`team add --hue` stores it; bare `team hue <name>` reads it back', async () => {
      const added = JSON.parse(
        (await team(['add', 'Lin', '--kind', 'agent', '--hue', '212', '--json'])).out,
      );
      expect(added.member.hue).toBe(212);
      const shown = await team(['hue', 'Lin']);
      expect(shown.code).toBe(0);
      expect(shown.out).toContain('212');
    });

    it('`team hue <name> <deg>` sets it, and a collision is refused by name', async () => {
      await team(['add', 'Lin', '--kind', 'agent', '--hue', '212']);
      await team(['add', 'Kai', '--kind', 'agent', '--hue', '40']);
      const set = await team(['hue', 'Lin', '300']);
      expect(set.code).toBe(0);
      expect(set.out).toContain('300');
      await expect(team(['hue', 'Lin', '42'])).rejects.toThrow(/"Kai" \(40\)/);
    });

    it('a seat added without a hue is given one, clear of its teammates', async () => {
      const a = JSON.parse((await team(['add', 'Lin', '--kind', 'agent', '--json'])).out);
      const b = JSON.parse((await team(['add', 'Kai', '--kind', 'agent', '--json'])).out);
      expect(typeof a.member.hue).toBe('number');
      expect(typeof b.member.hue).toBe('number');
      expect(a.member.hue).not.toBe(b.member.hue);
    });
  });

  describe('on a file-backed team, the seat file owns the hue', () => {
    let home: string;
    const seatPath = (name: string) => join(home, '.musterd', 'seats', `${name}.toml`);

    beforeEach(() => {
      home = join(dir, 'roster');
      mkdirSync(join(home, '.musterd', 'seats'), { recursive: true });
      writeFileSync(join(home, '.musterd', 'team.toml'), 'slug = "dawn"\n');
      writeFileSync(seatPath('miley'), 'kind = "agent"\nrole = "designer"\n');
      writeFileSync(seatPath('nick'), 'kind = "human"\nrole = "admin"\nhue = 40\n');
      saveConfig({ ...loadConfig(), rosterHome: { dawn: home } });
    });

    it('`team hue <name> <deg>` writes the file, and refuses a collision against the other seat files', async () => {
      const set = await team(['hue', 'miley', '212']);
      expect(set.code).toBe(0);
      expect(readFileSync(seatPath('miley'), 'utf8')).toBe(
        'kind = "agent"\nrole = "designer"\nhue = 212\n',
      );
      await expect(team(['hue', 'miley', '42'])).rejects.toThrow(/"nick" \(40\)/);
    });

    it('bare `team hue <name>` reads the file and says the file owns it', async () => {
      const shown = await team(['hue', 'nick']);
      expect(shown.out).toContain('40');
      expect(shown.out).toContain('seats/nick.toml');
    });

    it('`--assign-missing` seeds from the hash the web painted, moves only colliding seats, and leaves coloured seats alone', async () => {
      // dolly's default hash collides with nick's explicit 40 only if the wheel says so; pin the
      // behaviour with a seat whose legacy hue is known to sit on top of an existing one.
      const legacy = legacyHue('miley', 'agent');
      writeFileSync(seatPath('ryder'), `kind = "agent"\nrole = ""\nhue = ${legacy}\n`);
      const res = await team(['hue', '--assign-missing']);
      expect(res.code).toBe(0);
      // nick and ryder already had hues — untouched, byte for byte.
      expect(readFileSync(seatPath('nick'), 'utf8')).toBe(
        'kind = "human"\nrole = "admin"\nhue = 40\n',
      );
      expect(readFileSync(seatPath('ryder'), 'utf8')).toBe(
        `kind = "agent"\nrole = ""\nhue = ${legacy}\n`,
      );
      // miley had none: seeded from the legacy hash, and walked off ryder, who sits exactly there.
      const text = readFileSync(seatPath('miley'), 'utf8');
      const got = Number(/hue = (\d+)/.exec(text)![1]);
      expect(got).not.toBe(legacy);
      expect(res.out).toContain('miley');
      expect(res.out).toContain(String(got));
    });

    it('`--spread` seeds the same pass from the whole wheel instead of the kind band', async () => {
      // The point of the flag, stated as a falsifier rather than as a colour: with the default seed
      // an agent can only ever land in 150-280 (walked, but walked from inside the band); with
      // --spread it starts wherever the whole-wheel hash puts it. `escapee` hashes outside the agent
      // band, so the two seeds disagree — which is exactly the case the flag exists for.
      writeFileSync(seatPath('escapee'), 'kind = "agent"\nrole = ""\n');
      const res = await team(['hue', '--assign-missing', '--spread']);
      expect(res.code).toBe(0);
      const got = Number(/hue = (\d+)/.exec(readFileSync(seatPath('escapee'), 'utf8'))![1]);
      expect(got).toBe(defaultHue('escapee'));
      expect(got).not.toBe(legacyHue('escapee', 'agent'));
    });

    it('without `--spread` the same seat stays inside the legacy agent band', async () => {
      writeFileSync(seatPath('escapee'), 'kind = "agent"\nrole = ""\n');
      const res = await team(['hue', '--assign-missing']);
      expect(res.code).toBe(0);
      const got = Number(/hue = (\d+)/.exec(readFileSync(seatPath('escapee'), 'utf8'))![1]);
      expect(got).toBe(legacyHue('escapee', 'agent'));
    });
  });
});
