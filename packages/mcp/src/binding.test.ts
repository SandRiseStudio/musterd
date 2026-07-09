import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBindingDir } from './binding.js';
import { loadMcpConfig } from './config.js';

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
