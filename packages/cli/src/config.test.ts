import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, rememberIdentity, saveBinding, type Config } from './config.js';

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
    member: 'Ada',
    token: 'mskd_secret',
    surface: 'claude-code' as const,
  };

  it('records a tokenless ref keyed by absolute folder path', () => {
    saveBinding(dir, binding);
    const cfg = loadConfig();
    const ref = cfg.bindings[resolve(dir)];
    expect(ref).toEqual({ team: 'dawn', member: 'Ada', surface: 'claude-code' });
    // The registry must never carry the token — secrets live only in the 0600 binding file.
    expect(JSON.stringify(cfg.bindings)).not.toContain('mskd_secret');
  });

  it('the on-disk config never contains the token', () => {
    saveBinding(dir, binding);
    expect(readFileSync(configPath, 'utf8')).not.toContain('mskd_secret');
  });

  it('loadConfig defaults bindings to {} for a config written before the registry existed', () => {
    // An older config without the `bindings` field still loads cleanly.
    writeFileSync(configPath, JSON.stringify({ server: 'http://localhost:4849', identities: {} }));
    expect(loadConfig().bindings).toEqual({});
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
    expect(cfg.knownIdentities).toEqual([
      { team: 'alpha', name: 'David', token: 'mskd_d', surface: 'cli' },
    ]);
  });

  it('rememberIdentity keeps a second member on the same team (the clobber that ADR 059 fixes)', () => {
    const cfg: Config = {
      server: 'http://localhost:4849',
      identities: {},
      knownIdentities: [],
      bindings: {},
    };
    rememberIdentity(cfg, { team: 'alpha', name: 'David', token: 'mskd_d', surface: 'cli' });
    rememberIdentity(cfg, { team: 'alpha', name: 'Pim', token: 'mskd_p', surface: 'cli' });
    // Joining as Pim must NOT evict David's token — both resolvable by --as.
    expect(cfg.knownIdentities.map((i) => i.name).sort()).toEqual(['David', 'Pim']);
    // Re-remembering the same (team, name) upserts in place rather than duplicating.
    rememberIdentity(cfg, { team: 'alpha', name: 'David', token: 'mskd_d2', surface: 'cli' });
    const davids = cfg.knownIdentities.filter((i) => i.name === 'David');
    expect(davids).toEqual([{ team: 'alpha', name: 'David', token: 'mskd_d2', surface: 'cli' }]);
  });
});
