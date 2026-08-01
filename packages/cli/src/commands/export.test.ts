import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSeatFile, parseTeamFile } from '@musterd/protocol';
import { createServer, openDb, type RunningServer } from '@musterd/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { rosterToFiles, teamCommand, type RosterMember } from './team.js';

describe('rosterToFiles — db→file projection for `team export`', () => {
  it('writes canonical team + seat files, token-free', () => {
    const members: RosterMember[] = [
      { name: 'olive', kind: 'agent', role: 'reviewer', lifecycle: 'forever' },
      { name: 'david', kind: 'human', role: 'lead', lifecycle: 'forever' },
    ];
    const { teamToml, seatFiles } = rosterToFiles('alpha', members);
    expect(teamToml).toBe('slug = "alpha"\n');
    expect(seatFiles['olive.toml']).toBe('kind = "agent"\nrole = "reviewer"\n');
    expect(seatFiles['david.toml']).toBe('kind = "human"\nrole = "lead"\n');
    // No token, ever.
    expect(JSON.stringify(seatFiles)).not.toMatch(/mskd_|token/);
  });

  it('renders an until-lifecycle seat with a canonical ISO timestamp', () => {
    const ts = Date.parse('2026-07-01T00:00:00.000Z');
    const { seatFiles } = rosterToFiles('alpha', [
      { name: 'temp', kind: 'agent', role: 'intern', lifecycle: 'until', lifecycle_until: ts },
    ]);
    expect(seatFiles['temp.toml']).toBe(
      'kind = "agent"\nrole = "intern"\nlifecycle = "until"\nuntil = "2026-07-01T00:00:00.000Z"\n',
    );
    // Round-trips back to the same identity.
    const back = parseSeatFile(seatFiles['temp.toml']!, 'temp');
    expect(back).toEqual({
      kind: 'agent',
      role: 'intern',
      lifecycle: 'until',
      until: '2026-07-01T00:00:00.000Z',
      name: 'temp',
    });
  });

  it('handles an empty roster (team.toml, no seats)', () => {
    const { teamToml, seatFiles } = rosterToFiles('alpha', []);
    expect(parseTeamFile(teamToml)).toEqual({ slug: 'alpha', lifecycle: 'forever' });
    expect(Object.keys(seatFiles)).toEqual([]);
  });
});

/**
 * The export path end to end — because the leak was never in the projection, it was in the last line
 * of output. `rosterToFiles` above is already token-free; what shipped the credential was `team
 * export` telling you to `git add` a directory whose `.musterd/` also holds `binding.json`. So the
 * claim under test is the whole folder's: **a fresh export leaves somewhere `git add -A` is safe**.
 */
describe('`team export` guards the directory it tells you to commit (ADR 176)', () => {
  let server: RunningServer;
  let dir: string;
  let home: string;

  beforeEach(async () => {
    server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    process.env['MUSTERD_SERVER'] = `http://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), 'musterd-export-'));
    home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
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

  const exportTo = (at: string) =>
    capture(() => teamCommand(parseArgs(['export', 'dawn', '--to', at])));

  it('leaves a .gitignore naming the binding, alongside the roster it wrote', async () => {
    const { code } = await exportTo(home);
    expect(code).toBe(0);
    expect(existsSync(join(home, '.musterd', 'team.toml'))).toBe(true);
    const ignore = readFileSync(join(home, '.gitignore'), 'utf8');
    expect(ignore).toContain('.musterd/binding.json');
    expect(ignore).toContain('.musterd/pending/');
  });

  it('a credential in the exported home is excluded by the exclusions it wrote', async () => {
    // The end-to-end claim, stated the way the leak happened: the token is on disk in the folder the
    // command is about to call committable, and git must not see it.
    const musterd = join(home, '.musterd');
    mkdirSync(musterd, { recursive: true });
    writeFileSync(join(musterd, 'binding.json'), JSON.stringify({ agent_key: 'mscr_secret' }));
    await exportTo(home);
    const patterns = readFileSync(join(home, '.gitignore'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(patterns).toContain('.musterd/binding.json');
  });

  it('says the files are the source of truth and to commit them — once it is safe to', async () => {
    const { out } = await exportTo(home);
    expect(out).toContain('git add + commit');
  });

  it('withholds the commit instruction when it could not write the .gitignore', async () => {
    // The one behavioural branch worth pinning: the guard failing must not abort an export whose
    // roster is already on disk, but it must also not hand over an instruction it could not make
    // safe. A directory where `.gitignore` is itself a directory is unwritable in exactly that way.
    mkdirSync(join(home, '.gitignore'), { recursive: true });
    const { code, out } = await exportTo(home);
    expect(code).toBe(0);
    expect(existsSync(join(home, '.musterd', 'team.toml'))).toBe(true);
    expect(out).not.toContain('git add + commit');
    expect(out).toContain('holds a live credential');
  });

  it('reports the guard in --json so a script can tell whether the folder is committable', async () => {
    const { out } = await capture(() =>
      teamCommand(parseArgs(['export', 'dawn', '--to', home, '--json'])),
    );
    expect(JSON.parse(out).credentialExcluded).toBe(true);
  });
});
