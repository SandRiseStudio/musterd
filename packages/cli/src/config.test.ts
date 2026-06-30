import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, rememberIdentity, removeBinding, saveBinding, type Config } from './config.js';

describe('binding registry (ADR 020)', () => {
  let dir: string;
  let configPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-config-'));
    configPath = join(dir, 'config.json');
    process.env['MUSTERD_CONFIG'] = configPath;
  });
  afterEach(() => {
    delete process.env['MUSTERD_CONFIG'];
  });

  const binding = {
    server: 'http://localhost:4849',
    team: 'dawn',
    agent_key: 'mskey_secret',
    surface: 'claude-code' as const,
    claim: { mode: 'seat' as const, name: 'Ada' },
  };

  it('records a keyless seat ref keyed by absolute folder path', () => {
    saveBinding(dir, binding);
    const cfg = loadConfig();
    const ref = cfg.bindings[resolve(dir)];
    expect(ref).toEqual({ team: 'dawn', seat: 'Ada', surface: 'claude-code' });
    // The registry must never carry the agent key — secrets live only in the 0600 binding file.
    expect(JSON.stringify(cfg.bindings)).not.toContain('mskey_secret');
  });

  it('the on-disk config never contains the agent key', () => {
    saveBinding(dir, binding);
    expect(readFileSync(configPath, 'utf8')).not.toContain('mskey_secret');
  });

  it('loadConfig defaults bindings to {} for a config written before the registry existed', () => {
    // An older config without the `bindings` field still loads cleanly.
    writeFileSync(configPath, JSON.stringify({ server: 'http://localhost:4849', identities: {} }));
    expect(loadConfig().bindings).toEqual({});
  });

  it('removeBinding (ADR 058 unbind) deletes the binding file + drops its registry entry', () => {
    const p = saveBinding(dir, binding);
    expect(existsSync(p)).toBe(true);
    expect(loadConfig().bindings[resolve(dir)]).toBeDefined();

    const removed = removeBinding(dir);
    expect(removed).toBe(true);
    expect(existsSync(p)).toBe(false);
    expect(loadConfig().bindings[resolve(dir)]).toBeUndefined();

    // Idempotent: removing an already-unbound folder is a clean no-op (false), not an error.
    expect(removeBinding(dir)).toBe(false);
  });
});

describe('multi-identity vault (ADR 059)', () => {
  let dir: string;
  let configPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-vault-'));
    configPath = join(dir, 'config.json');
    process.env['MUSTERD_CONFIG'] = configPath;
  });
  afterEach(() => delete process.env['MUSTERD_CONFIG']);

  it('backfills the vault from a legacy single-slot config on load', () => {
    // A config written before the vault existed: one identity per team, no knownIdentities.
    writeFileSync(
      configPath,
      JSON.stringify({
        server: 'http://localhost:4849',
        current: 'alpha',
        identities: { alpha: { name: 'David', token: 'mskd_d', surface: 'cli' } },
      }),
    );
    const cfg = loadConfig();
    // Legacy `token` is coerced to `key` on load (v0.3, ADR 075).
    expect(cfg.knownIdentities).toEqual([
      { team: 'alpha', name: 'David', key: 'mskd_d', surface: 'cli' },
    ]);
  });

  it('rememberIdentity keeps a second member on the same team (the clobber that ADR 059 fixes)', () => {
    const cfg: Config = {
      server: 'http://localhost:4849',
      identities: {},
      knownIdentities: [],
      bindings: {},
      agentKeys: {},
      rosterHome: {},
    };
    rememberIdentity(cfg, { team: 'alpha', name: 'David', key: 'mskey_d', surface: 'cli' });
    rememberIdentity(cfg, { team: 'alpha', name: 'Pim', key: 'mskey_p', surface: 'cli' });
    // Joining as Pim must NOT evict David's key — both resolvable by --as.
    expect(cfg.knownIdentities.map((i) => i.name).sort()).toEqual(['David', 'Pim']);
    // Re-remembering the same (team, name) upserts in place rather than duplicating.
    rememberIdentity(cfg, { team: 'alpha', name: 'David', key: 'mskey_d2', surface: 'cli' });
    const davids = cfg.knownIdentities.filter((i) => i.name === 'David');
    expect(davids).toEqual([{ team: 'alpha', name: 'David', key: 'mskey_d2', surface: 'cli' }]);
  });
});
