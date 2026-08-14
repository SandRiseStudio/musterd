import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBindingDir, saveBinding, clearGrantFromBinding, findBinding } from './binding.js';
import { loadMcpConfig, refreshAttestation } from './config.js';

let dir: string;
let bindingPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-mcp-binding-'));
  bindingPath = join(dir, 'binding.json');
  writeFileSync(
    bindingPath,
    JSON.stringify({
      server: 'http://localhost:9999',
      team: 'lab',
      agent_key: 'mskey_from_file',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'Ui' },
    }),
  );
  // Isolate from the developer's real repo binding: findBinding() walks up from cwd, so without
  // this an ambient ../.musterd/binding.json leaks an identity into the no-binding cases. The
  // binding-fallback tests pass MUSTERD_BINDING explicitly, so the mocked cwd doesn't affect them.
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('loadMcpConfig identity alignment (ADR 018)', () => {
  it('falls back to the workspace binding file when env carries no agent key', () => {
    const cfg = loadMcpConfig({ MUSTERD_BINDING: bindingPath });
    // v0.3 (ADR 075): the binding carries the agent key + claim policy; the seat resolves at claim.
    expect(cfg.agent_key).toBe('mskey_from_file');
    expect(cfg.member).toBeUndefined();
    expect(cfg.team).toBe('lab');
    expect(cfg.claim).toEqual({ mode: 'seat', name: 'Ui' });
    expect(cfg.server).toBe('http://localhost:9999');
  });

  it('lets MUSTERD_* env override the binding file (host-injection / hosted setups)', () => {
    const cfg = loadMcpConfig({
      MUSTERD_BINDING: bindingPath,
      MUSTERD_TEAM: 'lab',
      MUSTERD_AGENT_KEY: 'mskey_from_env',
      MUSTERD_CLAIM: 'seat:Api',
    });
    expect(cfg.agent_key).toBe('mskey_from_env');
    expect(cfg.claim).toEqual({ mode: 'seat', name: 'Api' });
  });

  it('errors clearly when neither env nor a binding provides a team', () => {
    // Identity is now optional (claim-on-first-use, ADR 032) — only the team is required to load.
    expect(() => loadMcpConfig({})).toThrow(/no team/);
  });

  it('loads as a pending presence (no seat) when only a team + claim policy is given', () => {
    const cfg = loadMcpConfig({ MUSTERD_TEAM: 'lab', MUSTERD_CLAIM: 'role:backend' });
    expect(cfg.member).toBeUndefined();
    expect(cfg.agent_key).toBeUndefined();
    expect(cfg.team).toBe('lab');
    expect(cfg.claim).toEqual({ mode: 'role', role: 'backend' });
  });

  it('reads the claim policy from the binding file when MUSTERD_CLAIM is unset', () => {
    const cfg = loadMcpConfig({ MUSTERD_BINDING: bindingPath });
    expect(cfg.claim).toEqual({ mode: 'seat', name: 'Ui' });
  });
});

describe('loadMcpConfig committed launch-spec fallback (ADR: committed launch spec)', () => {
  /** Write a committed .musterd/workspace.json under the mocked cwd (no secrets). */
  function writeSpec() {
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'workspace.json'),
      JSON.stringify({
        server: 'http://localhost:7777',
        team: 'clonelab',
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'Cloned' },
      }),
    );
  }

  it('resolves server/team/surface/claim from workspace.json + an env key (a fresh clone)', () => {
    writeSpec();
    // Only the key comes from env; everything else from the committed spec — the self-wire case.
    const cfg = loadMcpConfig({ MUSTERD_AGENT_KEY: 'mskey_env' });
    expect(cfg.team).toBe('clonelab');
    expect(cfg.server).toBe('http://localhost:7777');
    expect(cfg.surface).toBe('claude-code');
    expect(cfg.claim).toEqual({ mode: 'seat', name: 'Cloned' });
    expect(cfg.agent_key).toBe('mskey_env');
  });

  it('never reads a secret from the committed spec (only env/binding supply the key)', () => {
    writeSpec();
    const cfg = loadMcpConfig({ MUSTERD_TEAM: 'clonelab' }); // no key anywhere
    expect(cfg.agent_key).toBeUndefined();
  });

  it('binding.json wins over the committed spec for the non-secret fields', () => {
    writeSpec();
    const cfg = loadMcpConfig({ MUSTERD_BINDING: bindingPath });
    // The binding file (team 'lab') overrides the spec's team 'clonelab'.
    expect(cfg.team).toBe('lab');
    expect(cfg.server).toBe('http://localhost:9999');
  });
});

describe('resolveBindingDir (identity anchor — the ambient-cwd clobber fix)', () => {
  it('derives the workspace root from an explicit MUSTERD_BINDING path', () => {
    const root = mkdtempSync(join(tmpdir(), 'musterd-anchor-'));
    const p = join(root, '.musterd', 'binding.json');
    expect(resolveBindingDir(process.cwd(), { MUSTERD_BINDING: p })).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });

  it('walks up from startDir to the nearest .musterd/binding.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'musterd-anchor-'));
    mkdirSync(join(root, '.musterd'), { recursive: true });
    writeFileSync(join(root, '.musterd', 'binding.json'), '{}');
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(resolveBindingDir(sub, {})).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to the nearest .musterd/workspace.json when no binding exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'musterd-anchor-'));
    mkdirSync(join(root, '.musterd'), { recursive: true });
    writeFileSync(join(root, '.musterd', 'workspace.json'), '{}');
    expect(resolveBindingDir(join(root, 'x'), {})).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to startDir when no musterd file is on the walk-up path', () => {
    const root = mkdtempSync(join(tmpdir(), 'musterd-empty-'));
    expect(resolveBindingDir(root, {})).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('claimCode stability (ADR 087 — a reconnect must not orphan --for <code>)', () => {
  const seatEnv = {
    MUSTERD_TEAM: 'lab',
    MUSTERD_CLAIM: 'seat:Ada',
    MUSTERD_WORKSPACE: 'ws-fixed',
    MUSTERD_SURFACE: 'claude-code',
  };

  it('a seat-mode session gets the SAME code across process loads (stable, hash-derived)', () => {
    const a = loadMcpConfig(seatEnv);
    const b = loadMcpConfig(seatEnv);
    expect(a.claimCode).toBe(b.claimCode);
    expect(a.claimCode).toMatch(/^[A-Z0-9]{4}$/);
    // connId stays unique per process (transport/hub identity) even when the code is stable.
    expect(a.connId).not.toBe(b.connId);
  });

  it('the stable code varies by seat, workspace, and surface (the identity of "same seat")', () => {
    const base = loadMcpConfig(seatEnv).claimCode;
    expect(loadMcpConfig({ ...seatEnv, MUSTERD_CLAIM: 'seat:Bob' }).claimCode).not.toBe(base);
    expect(loadMcpConfig({ ...seatEnv, MUSTERD_WORKSPACE: 'ws-other' }).claimCode).not.toBe(base);
    expect(loadMcpConfig({ ...seatEnv, MUSTERD_SURFACE: 'cursor' }).claimCode).not.toBe(base);
  });

  it('role/chat sessions keep a fresh per-process code (several may share one folder)', () => {
    const roleEnv = { MUSTERD_TEAM: 'lab', MUSTERD_CLAIM: 'role:backend', MUSTERD_WORKSPACE: 'ws' };
    expect(loadMcpConfig(roleEnv).claimCode).not.toBe(loadMcpConfig(roleEnv).claimCode);
  });
});

describe('model attestation ladder (ADR 101 — attest by default)', () => {
  function bindingWithModel(model?: string): string {
    const p = join(dir, 'binding-model.json');
    writeFileSync(
      p,
      JSON.stringify({
        server: 'http://localhost:9999',
        team: 'lab',
        agent_key: 'mskey_from_file',
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'Ui' },
        ...(model !== undefined ? { model } : {}),
      }),
    );
    return p;
  }

  it('attests the model persisted in binding.json when the env declares none (the by-default fix)', () => {
    // A `musterd agent --model qwen3:4b`-provisioned seat: the adapter env carries no MUSTERD_MODEL,
    // but binding.json does — so the seat attests instead of rotting to `unknown`.
    const config = loadMcpConfig({ MUSTERD_BINDING: bindingWithModel('qwen3:4b') });
    expect(config.model).toBe('qwen3:4b');
    expect(config.modelSource).toBe('binding');
  });

  it('lets an env declaration override the binding (MUSTERD_MODEL wins, e.g. a /model switch)', () => {
    const config = loadMcpConfig({
      MUSTERD_BINDING: bindingWithModel('qwen3:4b'),
      MUSTERD_MODEL: 'claude-opus-4-8',
    });
    expect(config.model).toBe('claude-opus-4-8');
    expect(config.modelSource).toBe('environment');
  });

  it('stays honestly unknown when neither env nor binding declares a model', () => {
    const config = loadMcpConfig({ MUSTERD_BINDING: bindingWithModel(undefined) });
    expect(config.model).toBeUndefined();
    expect(config.modelSource).toBe('unknown');
  });

  /** A binding carrying both tiers: what a config DECLARES vs what a hook OBSERVED. */
  function bindingWithTiers(declared: string | undefined, observed: string | undefined): string {
    const p = join(dir, 'binding-tiers.json');
    writeFileSync(
      p,
      JSON.stringify({
        server: 'http://localhost:9999',
        team: 'lab',
        agent_key: 'mskey_from_file',
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'Ui' },
        ...(declared !== undefined ? { model: declared } : {}),
        ...(observed !== undefined
          ? { model_observed: { model: observed, harness: 'claude-code', observed_at: 1 } }
          : {}),
      }),
    );
    return p;
  }

  it('attests the OBSERVATION over a stale env declaration (the incident shape)', () => {
    const config = loadMcpConfig({
      MUSTERD_BINDING: bindingWithTiers('grok-4.5', 'claude-opus-4-8'),
      MUSTERD_MODEL: 'grok-4.5',
    });
    expect(config.model).toBe('claude-opus-4-8');
    expect(config.modelSource).toBe('observed');
    expect(config.modelDrift).toEqual({ declared: 'grok-4.5', observed: 'claude-opus-4-8' });
  });

  it('attests the observation over a stale binding declaration too', () => {
    const config = loadMcpConfig({
      MUSTERD_BINDING: bindingWithTiers('grok-4.5', 'claude-opus-4-8'),
    });
    expect(config.model).toBe('claude-opus-4-8');
    expect(config.modelSource).toBe('observed');
  });

  it('reports no drift when the observation agrees with the declaration', () => {
    const config = loadMcpConfig({
      MUSTERD_BINDING: bindingWithTiers('claude-opus-4-8', 'claude-opus-4-8'),
    });
    expect(config.modelSource).toBe('observed');
    expect(config.modelDrift).toBeUndefined();
  });

  it('still honours a declaration when nothing was observed', () => {
    const config = loadMcpConfig({ MUSTERD_BINDING: bindingWithTiers('grok-4.5', undefined) });
    expect(config.model).toBe('grok-4.5');
    expect(config.modelSource).toBe('binding');
    expect(config.modelDrift).toBeUndefined();
  });
});

describe('saveBinding merge-guard (ADR 131 inc 4 — the adapter must not clobber a hook capture)', () => {
  it('persisting a boot-time binding preserves the session the SessionStart hook just wrote', () => {
    const ws = mkdtempSync(join(tmpdir(), 'musterd-mcp-saveb-'));
    try {
      const boot = {
        server: 'http://s1',
        team: 'lab',
        surface: 'claude-code' as const,
        claim: { mode: 'seat' as const, name: 'Ui' },
        agent_key: 'mskey_1',
      };
      const capture = { harness: 'claude-code', id: 'sid-wake', started_at: 1 };
      // The wake sequence: hook writes the capture…
      saveBinding(ws, { ...boot, session: capture });
      // …then the adapter's first-tool-call autojoin persists the binding it built from
      // boot-time config (no session field). Without the guard this wiped every wake's capture.
      saveBinding(ws, { ...boot, model: 'claude-test-1' });
      const after = JSON.parse(
        readFileSync(join(ws, '.musterd', 'binding.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(after['session']).toEqual(capture);
      expect(after['model']).toBe('claude-test-1');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  /**
   * The adapter shares the CLI's write path in shape but not in code, so it needs its own pin: the
   * refusal must hold on BOTH surfaces or the guard is only half there. #508's fractional
   * `started_at` reached disk through the hook, but nothing stopped the adapter writing the same.
   */
  it('refuses a binding the reader could not parse, leaving the good one in place', () => {
    const ws = mkdtempSync(join(tmpdir(), 'musterd-mcp-badb-'));
    try {
      const boot = {
        server: 'http://s1',
        team: 'lab',
        surface: 'claude-code' as const,
        claim: { mode: 'seat' as const, name: 'Ui' },
        agent_key: 'mskey_1',
      };
      saveBinding(ws, { ...boot, session: { harness: 'claude-code', id: 'sid', started_at: 1 } });
      const good = readFileSync(join(ws, '.musterd', 'binding.json'), 'utf8');

      expect(() =>
        saveBinding(ws, {
          ...boot,
          // Type-correct `number`, rejected by the schema's `.int()` — exactly birthtimeMs.
          session: { harness: 'claude-code', id: 'sid', started_at: 1785352706039.4507 },
        }),
      ).toThrow(/session\.started_at/);

      expect(readFileSync(join(ws, '.musterd', 'binding.json'), 'utf8')).toBe(good);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('saveBinding merge-guard — the hook-written model observation', () => {
  it('a boot-time persist preserves the observation the SessionStart hook just wrote', () => {
    const ws = mkdtempSync(join(tmpdir(), 'musterd-mcp-obs-'));
    try {
      const boot = {
        server: 'http://s1',
        team: 'lab',
        surface: 'claude-code' as const,
        claim: { mode: 'seat' as const, name: 'Ui' },
        agent_key: 'mskey_1',
      };
      const observation = { model: 'claude-opus-4-8', harness: 'claude-code', observed_at: 1 };
      // The hook observes what the harness is running…
      saveBinding(ws, { ...boot, model_observed: observation });
      // …then the adapter's autojoin persists the binding it built from boot-time config, which can
      // never carry an observation. Without the guard this wiped it moments after it was written —
      // the exact reason hand-editing binding.json could never fix a stale model.
      saveBinding(ws, { ...boot, model: 'grok-4.5' });
      const after = JSON.parse(
        readFileSync(join(ws, '.musterd', 'binding.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(after['model_observed']).toEqual(observation);
      expect(after['model']).toBe('grok-4.5'); // the declaration is still the caller's to set
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('an explicit observation on the argument wins over the on-disk one (newest-wins)', () => {
    const ws = mkdtempSync(join(tmpdir(), 'musterd-mcp-obs2-'));
    try {
      const boot = {
        server: 'http://s1',
        team: 'lab',
        surface: 'claude-code' as const,
        claim: { mode: 'seat' as const, name: 'Ui' },
      };
      saveBinding(ws, {
        ...boot,
        model_observed: { model: 'claude-sonnet-5', harness: 'claude-code', observed_at: 1 },
      });
      saveBinding(ws, {
        ...boot,
        model_observed: { model: 'claude-opus-4-8', harness: 'claude-code', observed_at: 2 },
      });
      const after = JSON.parse(
        readFileSync(join(ws, '.musterd', 'binding.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(after['model_observed']).toEqual({
        model: 'claude-opus-4-8',
        harness: 'claude-code',
        observed_at: 2,
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('an explicit drop clears the on-disk observation (ADR 270) — omit still means preserve', () => {
    const ws = mkdtempSync(join(tmpdir(), 'musterd-mcp-obs-drop-'));
    try {
      const boot = {
        server: 'http://s1',
        team: 'lab',
        surface: 'cursor' as const,
        claim: { mode: 'seat' as const, name: 'Ui' },
      };
      const observation = { model: 'grok-4.6', harness: 'cursor' as const, observed_at: 1 };
      saveBinding(ws, { ...boot, model_observed: observation });
      saveBinding(ws, { ...boot, model: 'grok-4.5' }, { drop: { model_observed: true } });
      const afterDrop = JSON.parse(
        readFileSync(join(ws, '.musterd', 'binding.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(afterDrop['model_observed']).toBeUndefined();
      expect(afterDrop['model']).toBe('grok-4.5');
      saveBinding(ws, { ...boot });
      const afterOmit = JSON.parse(
        readFileSync(join(ws, '.musterd', 'binding.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(afterOmit['model_observed']).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

/**
 * ADR 158 §7, adapter half. The adapter resolves its attestation once, in `main()`, before the
 * transcript carries an assistant turn — so a hook that corrects `model_observed` mid-session was
 * writing to a file nobody re-read. Measured live: binding.json said `claude-opus-5` while the
 * roster said `claude-opus-4-8`.
 */
describe('refreshAttestation (the observation the adapter re-reads)', () => {
  const write = (over: Record<string, unknown>): void => {
    writeFileSync(
      bindingPath,
      JSON.stringify({
        server: 'http://localhost:9999',
        team: 'lab',
        agent_key: 'mskey_from_file',
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'Ui' },
        ...over,
      }),
    );
  };

  it('picks up an observation written after boot, and reports the change', () => {
    write({ model: 'claude-declared-1' });
    const cfg = loadMcpConfig({ MUSTERD_BINDING: bindingPath });
    expect(cfg.model).toBe('claude-declared-1');
    expect(cfg.modelSource).toBe('binding');

    // The hook lands the real observation mid-session.
    write({
      model: 'claude-declared-1',
      model_observed: { model: 'claude-opus-5', harness: 'claude-code', observed_at: 2 },
    });
    expect(refreshAttestation(cfg, { MUSTERD_BINDING: bindingPath })).toBe(true);
    expect(cfg.model).toBe('claude-opus-5');
    expect(cfg.modelSource).toBe('observed');
    // The declaration it disagrees with is still surfaced as drift, not silently repaired.
    expect(cfg.modelDrift).toEqual({ declared: 'claude-declared-1', observed: 'claude-opus-5' });
  });

  it('is a no-op — and reports no change — when the observation is unchanged', () => {
    write({ model_observed: { model: 'claude-opus-5', harness: 'claude-code', observed_at: 2 } });
    const cfg = loadMcpConfig({ MUSTERD_BINDING: bindingPath });
    expect(cfg.model).toBe('claude-opus-5');
    expect(refreshAttestation(cfg, { MUSTERD_BINDING: bindingPath })).toBe(false);
    expect(cfg.model).toBe('claude-opus-5');
  });

  it('tracks a mid-session model switch to a NEW observation', () => {
    write({ model_observed: { model: 'claude-opus-5', harness: 'claude-code', observed_at: 2 } });
    const cfg = loadMcpConfig({ MUSTERD_BINDING: bindingPath });
    write({ model_observed: { model: 'claude-sonnet-5', harness: 'claude-code', observed_at: 3 } });
    expect(refreshAttestation(cfg, { MUSTERD_BINDING: bindingPath })).toBe(true);
    expect(cfg.model).toBe('claude-sonnet-5');
  });

  it('never trades a real attestation for unknown when the binding goes unreadable', () => {
    write({ model_observed: { model: 'claude-opus-5', harness: 'claude-code', observed_at: 2 } });
    const cfg = loadMcpConfig({ MUSTERD_BINDING: bindingPath });
    rmSync(bindingPath, { force: true });
    expect(refreshAttestation(cfg, { MUSTERD_BINDING: bindingPath })).toBe(false);
    expect(cfg.model).toBe('claude-opus-5'); // the roster never blanks on a bad read
  });

  it('keeps env above the binding declaration, and the observation above env', () => {
    write({ model: 'claude-declared-1' });
    const env = { MUSTERD_BINDING: bindingPath, MUSTERD_MODEL: 'claude-from-env' };
    const cfg = loadMcpConfig(env);
    expect(cfg.model).toBe('claude-from-env');
    write({
      model: 'claude-declared-1',
      model_observed: { model: 'claude-opus-5', harness: 'claude-code', observed_at: 2 },
    });
    expect(refreshAttestation(cfg, env)).toBe(true);
    expect(cfg.model).toBe('claude-opus-5'); // observed outranks the env declaration (ADR 158 §1)
  });
});

describe('empty env — the ADR 165 shared-entry contract', () => {
  it('resolves server, team, surface, agent_key and grant from binding.json alone', () => {
    // Provisioning writes an entry with NO env (ADR 165), because the entry is shared by every seat
    // worktree of the repo. Everything must therefore come off disk. If this breaks, seats stop
    // being able to claim at all — this is the test that makes the strip safe.
    const wsDir = mkdtempSync(join(tmpdir(), 'musterd-adr165-'));
    mkdirSync(join(wsDir, '.musterd'), { recursive: true });
    writeFileSync(
      join(wsDir, '.musterd', 'binding.json'),
      JSON.stringify({
        server: 'http://localhost:4849',
        team: 'revive',
        agent_key: 'mskey_from_disk',
        grant: 'msgr_from_disk',
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'izzo' },
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(wsDir);
    try {
      const cfg = loadMcpConfig({});
      expect(cfg.server).toBe('http://localhost:4849');
      expect(cfg.team).toBe('revive');
      expect(cfg.agent_key).toBe('mskey_from_disk');
      expect(cfg.grant).toBe('msgr_from_disk');
      expect(cfg.surface).toBe('claude-code');
      expect(cfg.claim).toEqual({ mode: 'seat', name: 'izzo' });
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it('resolves autojoin and driver from binding.json under an empty env (inc 2)', () => {
    const wsDir = mkdtempSync(join(tmpdir(), 'musterd-adr165-inc2-'));
    mkdirSync(join(wsDir, '.musterd'), { recursive: true });
    writeFileSync(
      join(wsDir, '.musterd', 'binding.json'),
      JSON.stringify({
        server: 'http://localhost:4849',
        team: 'revive',
        agent_key: 'mskey_from_disk',
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'izzo' },
        autojoin: true,
        driver: 'nick',
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(wsDir);
    try {
      const cfg = loadMcpConfig({});
      expect(cfg.autojoin).toBe(true);
      expect(cfg.driver).toBe('nick');
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it('keeps MUSTERD_AUTOJOIN / MUSTERD_DRIVER as manual overrides above the binding (inc 2)', () => {
    // A binding opted in, but the env explicitly turns autojoin OFF and renames the driver —
    // the headless/CI override must beat the provisioned state in both directions.
    writeFileSync(
      bindingPath,
      JSON.stringify({
        server: 'http://localhost:9999',
        team: 'lab',
        agent_key: 'mskey_from_file',
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'Ui' },
        autojoin: true,
        driver: 'nick',
      }),
    );
    const cfg = loadMcpConfig({
      MUSTERD_BINDING: bindingPath,
      MUSTERD_AUTOJOIN: '0',
      MUSTERD_DRIVER: 'someone-else',
    });
    expect(cfg.autojoin).toBe(false);
    expect(cfg.driver).toBe('someone-else');
  });

  it('defaults to dormant, no driver, when neither env nor binding says otherwise', () => {
    const cfg = loadMcpConfig({ MUSTERD_BINDING: bindingPath });
    expect(cfg.autojoin).toBe(false);
    expect(cfg.driver).toBeUndefined();
  });

  it('still honours an explicit env override — the names are manual, not removed', () => {
    const wsDir = mkdtempSync(join(tmpdir(), 'musterd-adr165-ovr-'));
    mkdirSync(join(wsDir, '.musterd'), { recursive: true });
    writeFileSync(
      join(wsDir, '.musterd', 'binding.json'),
      JSON.stringify({
        server: 'http://localhost:4849',
        team: 'revive',
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'izzo' },
      }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(wsDir);
    try {
      expect(loadMcpConfig({ MUSTERD_TEAM: 'other' }).team).toBe('other');
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
    }
  });
});

describe('clearGrantFromBinding (ADR 193)', () => {
  it('removes the grant and leaves every other field intact', () => {
    const ws = mkdtempSync(join(tmpdir(), 'musterd-clear-grant-'));
    try {
      saveBinding(ws, {
        server: 'http://localhost:4849',
        team: 'revive',
        agent_key: 'mskey_x',
        grant: 'msgr_stale',
        surface: 'claude-code',
        claim: { mode: 'seat', name: 'Ada' },
        model: 'claude-test',
      });
      clearGrantFromBinding(ws);
      const after = findBinding(ws);
      expect(after?.grant).toBeUndefined();
      expect(after?.agent_key).toBe('mskey_x');
      expect(after?.claim).toEqual({ mode: 'seat', name: 'Ada' });
      expect(after?.model).toBe('claude-test');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
