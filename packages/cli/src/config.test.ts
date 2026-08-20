import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  excludeCredentialFromGit,
  findBinding,
  findWorkspaceSpec,
  loadBinding,
  loadConfig,
  loadWorkspace,
  rememberIdentity,
  removeBinding,
  saveBinding,
  saveConfig,
  type Config,
} from './config.js';

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
    version: 2 as const,
    server: 'http://localhost:4849',
    team: 'dawn',
    agent_key: 'mskey_secret',
    claim: { mode: 'seat' as const, name: 'Ada' },
  };

  it('records a keyless seat ref keyed by absolute folder path', () => {
    saveBinding(dir, binding);
    const cfg = loadConfig();
    const ref = cfg.bindings[resolve(dir)];
    expect(ref).toEqual({ team: 'dawn', seat: 'Ada' });
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

describe('saveConfig concurrent writers (ADR 255)', () => {
  let dir: string;
  let configPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-cfg-race-'));
    configPath = join(dir, 'config.json');
    process.env['MUSTERD_CONFIG'] = configPath;
    writeFileSync(
      configPath,
      JSON.stringify({
        server: 'http://localhost:4849',
        current: 'alpha',
        identities: { alpha: { name: 'Ada', key: 'mskey_a', surface: 'cli' } },
        knownIdentities: [{ team: 'alpha', name: 'Ada', key: 'mskey_a', surface: 'cli' }],
        bindings: { '/tmp/one': { team: 'alpha', seat: 'Ada', surface: 'cli' } },
        agentKeys: { alpha: 'mskey_team_a' },
        rosterHome: {},
        teamHome: {},
      }) + '\n',
    );
  });
  afterEach(() => delete process.env['MUSTERD_CONFIG']);

  it('keeps an identity one writer added when another writer adds a binding', () => {
    // Two CLI processes each load, mutate a different map, and save. Last-write-wins of the
    // whole file drops the first writer's keys — the bug that emptied identities/bindings
    // on a busy machine. Both additions must survive.
    const a = loadConfig();
    const b = loadConfig();
    a.identities['beta'] = { name: 'wanderer', key: 'mskey_w', surface: 'cli' };
    rememberIdentity(a, { team: 'beta', name: 'wanderer', key: 'mskey_w', surface: 'cli' });
    b.bindings['/tmp/two'] = { team: 'alpha', seat: 'Pim', surface: 'cli' };
    saveConfig(a);
    saveConfig(b);

    const cfg = loadConfig();
    expect(cfg.identities['beta']).toEqual({
      name: 'wanderer',
      key: 'mskey_w',
      surface: 'cli',
    });
    expect(cfg.bindings['/tmp/two']).toEqual({
      team: 'alpha',
      seat: 'Pim',
      surface: 'cli',
    });
    expect(cfg.identities['alpha']?.name).toBe('Ada');
    expect(cfg.bindings['/tmp/one']?.seat).toBe('Ada');
    expect(cfg.knownIdentities.map((i) => i.name).sort()).toEqual(['Ada', 'wanderer']);
  });

  it('a binding deletion still lands when a concurrent writer adds an identity', () => {
    const a = loadConfig();
    const b = loadConfig();
    delete a.bindings['/tmp/one'];
    b.identities['beta'] = { name: 'wanderer', key: 'mskey_w', surface: 'cli' };
    saveConfig(a);
    saveConfig(b);

    const cfg = loadConfig();
    expect(cfg.bindings['/tmp/one']).toBeUndefined();
    expect(cfg.identities['beta']?.name).toBe('wanderer');
  });

  it('a writer that did not touch `current` keeps a concurrent current-team change', () => {
    // team create sets current; a concurrent saveBinding rewrites the file from a stale
    // snapshot. The new current must not revert.
    const a = loadConfig();
    const b = loadConfig();
    a.current = 'beta';
    a.agentKeys['beta'] = 'mskey_team_b';
    b.bindings['/tmp/two'] = { team: 'alpha', seat: 'Pim', surface: 'cli' };
    saveConfig(a);
    saveConfig(b);

    const cfg = loadConfig();
    expect(cfg.current).toBe('beta');
    expect(cfg.agentKeys['beta']).toBe('mskey_team_b');
    expect(cfg.bindings['/tmp/two']?.seat).toBe('Pim');
  });

  it('a constructed saveConfig (reset) replaces rather than merging with disk', () => {
    saveConfig({
      server: 'http://localhost:4849',
      identities: {},
      knownIdentities: [],
      bindings: {},
      agentKeys: {},
      rosterHome: {},
      teamHome: {},
    });
    const cfg = loadConfig();
    expect(cfg.identities).toEqual({});
    expect(cfg.bindings).toEqual({});
    expect(cfg.current).toBeUndefined();
    expect(cfg.knownIdentities).toEqual([]);
    expect(cfg.agentKeys).toEqual({});
  });

  it('leaves no tmp or lock file behind', () => {
    const a = loadConfig();
    a.identities['beta'] = { name: 'wanderer', key: 'mskey_w', surface: 'cli' };
    saveConfig(a);
    expect(existsSync(`${configPath}.${process.pid}.tmp`)).toBe(false);
    expect(existsSync(`${configPath}.lock`)).toBe(false);
  });
});

describe('saveBinding merge-guard + atomic write (ADR 131 inc 4)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-saveb-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
  });
  afterEach(() => delete process.env['MUSTERD_CONFIG']);

  const base = {
    version: 2 as const,
    server: 'http://s1',
    team: 'dawn',
    claim: { mode: 'seat' as const, name: 'scout' },
    agent_key: 'mskey_1',
  };
  const capture = { harness: 'claude-code', id: 'sid-1', started_at: 123 };
  const onDisk = () =>
    JSON.parse(readFileSync(join(dir, '.musterd', 'binding.json'), 'utf8')) as Record<
      string,
      unknown
    >;

  it('a session-less write preserves the on-disk capture (the every-wake clobber sequence)', () => {
    // The hook captures…
    saveBinding(dir, { ...base, session: capture });
    // …then a stale-state writer (the adapter's autojoin persist, `musterd agent`) rewrites the
    // binding it read before the capture existed. The capture must survive.
    saveBinding(dir, { ...base, grant: 'msgr_new' });
    expect(onDisk()['session']).toEqual(capture);
    expect(onDisk()['grant']).toBe('msgr_new');
  });

  it('an explicit session on the argument wins over the on-disk one', () => {
    saveBinding(dir, { ...base, session: capture });
    const newer = { ...capture, id: 'sid-2' };
    saveBinding(dir, { ...base, session: newer });
    expect(onDisk()['session']).toEqual(newer);
  });

  it('an observation-less write preserves the on-disk model observation', () => {
    // Same clobber shape as the capture above, one field over: `musterd claim` / `musterd agent`
    // rebuild the binding from state read before the hook observed anything. If the observation is
    // lost here, attestation silently falls back to the stale declaration — the bug this closes.
    const observation = { model: 'claude-opus-4-8', harness: 'claude-code', observed_at: 1 };
    saveBinding(dir, { ...base, model_observed: observation });
    saveBinding(dir, { ...base, model: 'grok-4.5' });
    expect(onDisk()['model_observed']).toEqual(observation);
    expect(onDisk()['model']).toBe('grok-4.5');
  });

  it('an explicit observation on the argument wins over the on-disk one (newest-wins)', () => {
    saveBinding(dir, {
      ...base,
      model_observed: { model: 'claude-sonnet-5', harness: 'claude-code', observed_at: 1 },
    });
    const newer = { model: 'claude-opus-4-8', harness: 'claude-code', observed_at: 2 };
    saveBinding(dir, { ...base, model_observed: newer });
    expect(onDisk()['model_observed']).toEqual(newer);
  });

  it('an explicit drop clears the on-disk observation (ADR 268) — omit still means preserve', () => {
    // The capture writer that learns the session id changed cannot say "no observation" by
    // omitting the field: omit is the claim/agent clobber shape and the merge-guard restores it.
    // Drop is a different intent, at this call site (ADR 247).
    const observation = { model: 'grok-4.6', harness: 'cursor' as const, observed_at: 1 };
    saveBinding(dir, { ...base, model_observed: observation });
    saveBinding(dir, { ...base, model: 'grok-4.5' }, { drop: { model_observed: true } });
    expect(onDisk()['model_observed']).toBeUndefined();
    expect(onDisk()['model']).toBe('grok-4.5');
    // And a later omit still must not invent an observation that is gone.
    saveBinding(dir, { ...base });
    expect(onDisk()['model_observed']).toBeUndefined();
  });

  it('leaves no tmp file behind (atomic rename)', () => {
    saveBinding(dir, base);
    const entries = readFileSync(join(dir, '.musterd', 'binding.json'), 'utf8');
    expect(entries).toContain('"team": "dawn"');
    expect(existsSync(join(dir, '.musterd', `binding.json.${process.pid}.tmp`))).toBe(false);
  });

  /**
   * The asymmetry that let #508 happen: the write side took whatever it was handed, while the read
   * side parsed strictly and turned any failure into `null`. A type-correct caller could therefore
   * write a binding that `findBinding` would refuse to read ever again — and since `null` also means
   * "no binding here", the seat simply went quiet. Measured: a fractional `started_at` from
   * `statSync().birthtimeMs` against `z.number().int()`.
   *
   * TypeScript cannot close this: every Zod refinement (`.int()`, `.min()`, `.regex()`, brands) is
   * invisible to the type it validates. Only the writer checking the same schema the reader uses can.
   */
  it('refuses to write a binding the reader could not parse', () => {
    // `started_at: number` type-checks; `z.number().int()` rejects it at runtime.
    const bad = { ...base, session: { ...capture, started_at: 1785352706039.4507 } };
    expect(() => saveBinding(dir, bad)).toThrow(/session\.started_at/);
  });

  it('leaves the previous good binding intact when it refuses a bad write', () => {
    // The property that matters most: a refused write must not be worse than no write. The seat
    // keeps the identity it had, and the next capture can heal it.
    saveBinding(dir, { ...base, session: capture });
    const good = onDisk();
    expect(() => saveBinding(dir, { ...base, session: { ...capture, started_at: 1.5 } })).toThrow();
    expect(onDisk()).toEqual(good);
    expect(existsSync(join(dir, '.musterd', `binding.json.${process.pid}.tmp`))).toBe(false);
  });
});

/**
 * `excludeCredentialFromGit` — the guard behind `team export`'s "git add + commit them" (ADR 176).
 *
 * The bug it closes was found on the real machine: the export writes the roster into the same
 * `.musterd/` that holds `binding.json` and a live `mscr_`, then tells you to commit the directory.
 * So the property under test is not "a file appeared" but **a fresh export leaves a folder where
 * `git add -A` stages no secret** — and the two ways to get that wrong are failing open on a
 * commented-out exclusion, and clobbering an exclusion somebody already wrote.
 */
describe('excludeCredentialFromGit — a team home is never committable with its credential', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-gitignore-'));
  });

  const ignoreFile = () => join(dir, '.gitignore');
  const read = () => readFileSync(ignoreFile(), 'utf8');

  it('writes both exclusions into a folder with no .gitignore', () => {
    expect(excludeCredentialFromGit(dir)).toBe(true);
    expect(read()).toContain('.musterd/binding.json');
    expect(read()).toContain('.musterd/pending/');
  });

  it('is idempotent — a second call adds nothing', () => {
    excludeCredentialFromGit(dir);
    const once = read();
    expect(excludeCredentialFromGit(dir)).toBe(true);
    expect(read()).toBe(once);
  });

  it('appends to a hand-written .gitignore instead of overwriting it', () => {
    writeFileSync(ignoreFile(), 'node_modules\ndist\n');
    excludeCredentialFromGit(dir);
    expect(read()).toMatch(/^node_modules\ndist\n/);
    expect(read()).toContain('.musterd/binding.json');
  });

  it('tolerates a file with no trailing newline without joining two patterns into one', () => {
    writeFileSync(ignoreFile(), 'dist');
    excludeCredentialFromGit(dir);
    expect(read().split('\n')).toContain('dist');
    expect(read()).not.toContain('dist#');
  });

  /**
   * Any of these already covers the binding, however it is spelled — a redundant line over somebody's
   * working exclusion is noise dressed as a fix. Derived from the target rather than hand-listed, so
   * this table is the check's contract rather than a restatement of its implementation.
   */
  for (const spelling of ['.musterd/', '.musterd', '.musterd/*', '.musterd/**']) {
    it(`treats an existing "${spelling}" as already covering both targets`, () => {
      writeFileSync(ignoreFile(), `${spelling}\n`);
      expect(excludeCredentialFromGit(dir)).toBe(true);
      expect(read()).toBe(`${spelling}\n`);
    });
  }

  // Each of these names the binding and nothing else, so `pending/` is still uncovered. The leading
  // `/` in the third is the reason lines are compared normalized rather than literally.
  for (const spelling of ['binding.json', '**/binding.json', '/.musterd/binding.json']) {
    it(`treats an existing "${spelling}" as covering the binding, and adds only pending/`, () => {
      writeFileSync(ignoreFile(), `${spelling}\n`);
      expect(excludeCredentialFromGit(dir)).toBe(true);
      // A partial cover gains the missing line only — never a duplicate of the one already there.
      expect(read().match(/binding\.json/g)).toHaveLength(1);
      expect(read()).toContain('.musterd/pending/');
    });
  }

  it('does NOT count a commented-out exclusion as cover', () => {
    // The case a substring check gets wrong, and it gets it wrong in the dangerous direction.
    writeFileSync(ignoreFile(), '# .musterd/binding.json\n');
    expect(excludeCredentialFromGit(dir)).toBe(true);
    expect(
      read()
        .split('\n')
        .filter((l) => l === '.musterd/binding.json'),
    ).toHaveLength(1);
  });

  it('returns true when the exclusion was already there — "safe", not "changed"', () => {
    // The caller's question is whether it may print the git instruction. An exclusion that was
    // already present is its happy path; reporting "nothing changed" would suppress a correct line.
    writeFileSync(ignoreFile(), '.musterd/\n');
    expect(excludeCredentialFromGit(dir)).toBe(true);
  });

  it('returns false instead of throwing when the folder cannot be written', () => {
    // An export whose roster is already on disk must not abort because the guard failed; the caller
    // withholds the "git add" line instead.
    const readonly = join(dir, 'ro');
    mkdirSync(readonly);
    chmodSync(readonly, 0o500);
    try {
      expect(excludeCredentialFromGit(readonly)).toBe(false);
    } finally {
      chmodSync(readonly, 0o700);
    }
  });
});

/**
 * The discriminated identity loaders (ADR 282): parse failures never collapse to `null` again.
 * `legacy` is exactly the recognized version-1 shape (otherwise-valid, carrying `surface`, no
 * `version`); everything else unparseable is `invalid`. The compat wrappers (`findBinding`,
 * `findWorkspaceSpec`) keep mapping `missing` → null but THROW a repair diagnostic on both
 * `legacy` and `invalid` — a broken or pre-281 workspace must say so, not go quiet (#508).
 */
describe('classified identity loads (ADR 281/282)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-load-'));
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
  });
  afterEach(() => delete process.env['MUSTERD_CONFIG']);

  const v2spec = {
    version: 2,
    server: 'http://localhost:4849',
    team: 'dawn',
    claim: { mode: 'seat', name: 'Ada' },
  };
  const v1spec = {
    server: 'http://localhost:4849',
    team: 'dawn',
    surface: 'claude-code',
    claim: { mode: 'seat', name: 'Ada' },
  };
  const writeSpec = (value: unknown) => {
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'workspace.json'),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  const writeBindingFile = (value: unknown) => {
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'binding.json'),
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };

  it('absent → missing', () => {
    expect(loadWorkspace(dir).kind).toBe('missing');
    expect(loadBinding(dir).kind).toBe('missing');
  });

  it('current valid version → valid', () => {
    writeSpec(v2spec);
    writeBindingFile({ ...v2spec, agent_key: 'mskey_x' });
    const spec = loadWorkspace(dir);
    expect(spec.kind).toBe('valid');
    const binding = loadBinding(dir);
    expect(binding.kind).toBe('valid');
    if (binding.kind === 'valid') expect(binding.value.agent_key).toBe('mskey_x');
  });

  it('the recognized version-1 shape → legacy', () => {
    writeSpec(v1spec);
    writeBindingFile({ ...v1spec, agent_key: 'mskey_x', model: 'claude-opus-4-8' });
    expect(loadWorkspace(dir).kind).toBe('legacy');
    expect(loadBinding(dir).kind).toBe('legacy');
  });

  it('unknown versions, invalid JSON, malformed values, unknown keys → invalid, never legacy', () => {
    writeSpec({ ...v2spec, version: 3 });
    expect(loadWorkspace(dir).kind).toBe('invalid');
    writeSpec('{ not json');
    expect(loadWorkspace(dir).kind).toBe('invalid');
    writeSpec({ ...v2spec, team: 42 });
    expect(loadWorkspace(dir).kind).toBe('invalid');
    writeSpec({ ...v2spec, extra: true });
    expect(loadWorkspace(dir).kind).toBe('invalid');
    // v1-with-junk is NOT a recognized legacy shape when its values are malformed.
    writeBindingFile({ ...v1spec, claim: { mode: 'nope' } });
    expect(loadBinding(dir).kind).toBe('invalid');
  });

  it('invalid issues carry paths and messages, never contents or secrets', () => {
    writeBindingFile({
      ...v2spec,
      agent_key: 'mskey_super_secret',
      session: { harness: '', id: '', started_at: 1.5 },
    });
    const got = loadBinding(dir);
    expect(got.kind).toBe('invalid');
    if (got.kind === 'invalid') {
      expect(JSON.stringify(got.issues)).not.toContain('mskey_super_secret');
    }
  });

  it('findBinding: missing → null; legacy and invalid → thrown repair diagnostic', () => {
    expect(findBinding(dir, {})).toBeNull();
    writeBindingFile({ ...v1spec, agent_key: 'mskey_x' });
    expect(() => findBinding(dir, {})).toThrow(/musterd harness configure/);
    writeBindingFile('{ not json');
    expect(() => findBinding(dir, {})).toThrow(/binding/);
    try {
      findBinding(dir, {});
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('mskey_x');
    }
  });

  it('findWorkspaceSpec: missing → null; legacy → thrown repair naming configure', () => {
    expect(findWorkspaceSpec(dir)).toBeNull();
    writeSpec(v1spec);
    expect(() => findWorkspaceSpec(dir)).toThrow(/musterd harness configure/);
  });

  it('saveBinding refuses to write the version-1 shape at all', () => {
    expect(() =>
      saveBinding(dir, { ...v1spec, agent_key: 'mskey_x' } as unknown as Parameters<
        typeof saveBinding
      >[1]),
    ).toThrow();
  });
});
