import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolve, resolveRead } from './helpers.js';

/**
 * Binding-only identity (ADR 442 §6). A folder acts as the member it is bound to, or as nobody.
 *
 * The incident this pins (2026-09-22): a session in an unbound folder ran `musterd inbox --as nick`
 * and read nick's inbox. A plain `musterd inbox` from the same folder would have done the same thing
 * through the global-config fallback, which is why both closes ship together.
 */
describe('binding-only identity (ADR 442)', () => {
  let root: string;
  let cwd: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = [
    'MUSTERD_CONFIG',
    'MUSTERD_TEAM',
    'MUSTERD_AGENT_KEY',
    'MUSTERD_CLAIM',
    'MUSTERD_SERVER',
    'MUSTERD_GRANT',
    'MUSTERD_SESSION_LEASE',
  ];

  /** A global config whose vault holds a HUMAN — the identity the incident reached. */
  const writeVaultWithHuman = () => {
    const path = join(root, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        server: 'http://127.0.0.1:1',
        current: 'dawn',
        identities: { dawn: { name: 'nick', key: 'mscr_human000000000000000', surface: 'cli' } },
        knownIdentities: [
          { team: 'dawn', name: 'nick', key: 'mscr_human000000000000000', surface: 'cli' },
        ],
      }),
    );
    process.env['MUSTERD_CONFIG'] = path;
  };

  /** A seat Workspace bound as `dolly`. */
  const seatWorkspace = (): string => {
    const dir = join(root, 'seat');
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'binding.json'),
      JSON.stringify({
        version: 2,
        server: 'http://127.0.0.1:1',
        team: 'dawn',
        claim: { mode: 'seat', name: 'dolly' },
        seat_credential: 'msac_seat0000000000000000',
      }),
    );
    return dir;
  };

  const unbound = (): string => {
    const dir = join(root, 'unbound');
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-identity-')));
    cwd = process.cwd();
    for (const k of ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    writeVaultWithHuman();
  });

  afterEach(() => {
    process.chdir(cwd);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('an unbound folder with a human in the vault resolves nobody', () => {
    process.chdir(unbound());
    const r = resolveRead({});
    expect(r.identity).toBeUndefined();
    expect(r.explicit).toBe(false);
    expect(() => resolve({})).toThrow(/no identity in this folder/);
  });

  it('--as is rejected, for acting and read commands alike', () => {
    process.chdir(unbound());
    expect(() => resolve({ as: 'nick' })).toThrow(/--as was removed \(ADR 442\)/);
    expect(() => resolveRead({ as: 'nick' })).toThrow(/--as was removed \(ADR 442\)/);
    process.chdir(seatWorkspace());
    expect(() => resolve({ as: 'nick' })).toThrow(/--as was removed/);
  });

  it('a seat Workspace resolves its seat, never the vault human', () => {
    process.chdir(seatWorkspace());
    const r = resolve({});
    expect(r.identity.name).toBe('dolly');
    expect(r.identitySource).toBe('binding');
  });

  it('a nested subfolder of a seat Workspace resolves the seat', () => {
    const deep = join(seatWorkspace(), 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    process.chdir(deep);
    expect(resolve({}).identity.name).toBe('dolly');
  });

  it('a symlink into a seat Workspace resolves the seat', () => {
    const link = join(root, 'link-to-seat');
    symlinkSync(seatWorkspace(), link);
    process.chdir(link);
    expect(resolve({}).identity.name).toBe('dolly');
  });

  it('a symlink to a Workspace inside an unbound folder does not bind that folder', () => {
    const parent = unbound();
    symlinkSync(seatWorkspace(), join(parent, 'seat-link'));
    process.chdir(parent);
    expect(resolveRead({}).identity).toBeUndefined();
  });

  it('a MUSTERD_CLAIM=seat env identity still resolves (service homes, tests)', () => {
    process.chdir(unbound());
    process.env['MUSTERD_TEAM'] = 'dawn';
    process.env['MUSTERD_AGENT_KEY'] = 'msac_env00000000000000000';
    process.env['MUSTERD_CLAIM'] = 'seat:host';
    const r = resolve({});
    expect(r.identity.name).toBe('host');
    expect(r.identitySource).toBe('env');
  });

  it('an unbound read still knows the team, so public reads (status) keep working', () => {
    process.chdir(unbound());
    expect(resolveRead({}).team).toBe('dawn');
  });
});
