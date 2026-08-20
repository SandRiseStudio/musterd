import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMcpConfig, refreshAttestation, resolveLaunchSurface } from './config.js';

/**
 * Runtime Surface is LAUNCHER-ONLY (ADR 286) — the successor to the ADR 275 occupancy-follows-
 * capture machinery this file used to pin. There is no declaration ladder left to drift: the
 * launcher writes `MUSTERD_LAUNCH_SURFACE` into its own registration, headless tests may set
 * `MUSTERD_TEST_SURFACE` above it, and NOTHING else — no binding/spec fallback, no capture
 * inference, no mid-session update. A registration still carrying the retired `MUSTERD_SURFACE`
 * refuses Presence attachment outright, even beside a valid marker: the dual-read path is the
 * thing ADR 286 §1 exists to prevent.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-surface-'));
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A fully valid v2 identity + capture — everything the OLD ladder would have read a Surface from. */
const writeRichLocalState = (): void => {
  writeFileSync(
    join(dir, '.musterd', 'workspace.json'),
    JSON.stringify({
      version: 2,
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      claim: { mode: 'seat', name: 'miley' },
    }),
  );
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    JSON.stringify({
      version: 2,
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      agent_key: 'mskey_test',
      claim: { mode: 'seat', name: 'miley' },
      model: 'claude-opus-5',
      session: { harness: 'cursor', id: 's1', started_at: 1 },
      model_observed: { model: 'claude-opus-5', harness: 'cursor', observed_at: 1 },
    }),
  );
};

describe('launch-marker Surface resolution (ADR 286)', () => {
  it('every valid launch marker resolves its matching Surface', () => {
    for (const surface of ['claude-code', 'cursor', 'codex', 'other'] as const) {
      const got = resolveLaunchSurface({ MUSTERD_LAUNCH_SURFACE: surface });
      expect(got).toEqual({ surface, markerGeneration: 'launch' });
    }
  });

  it('the test marker overrides a launch marker', () => {
    const got = resolveLaunchSurface({
      MUSTERD_LAUNCH_SURFACE: 'claude-code',
      MUSTERD_TEST_SURFACE: 'codex',
    });
    expect(got).toEqual({ surface: 'codex', markerGeneration: 'test-override' });
  });

  it('no marker refuses, naming `musterd harness configure`', () => {
    expect(() => resolveLaunchSurface({})).toThrow(/musterd harness configure/);
  });

  it('an invalid marker refuses — never coerced, never defaulted', () => {
    expect(() => resolveLaunchSurface({ MUSTERD_LAUNCH_SURFACE: 'Claude Code' })).toThrow(
      /not a valid Surface|configure/,
    );
    expect(() => resolveLaunchSurface({ MUSTERD_TEST_SURFACE: 'nope' })).toThrow(
      /not a valid Surface/,
    );
  });

  it('any presence of the retired marker refuses, even beside a valid launch or test marker', () => {
    for (const extra of [
      {},
      { MUSTERD_LAUNCH_SURFACE: 'claude-code' },
      { MUSTERD_TEST_SURFACE: 'codex' },
    ]) {
      expect(() => resolveLaunchSurface({ MUSTERD_SURFACE: 'claude-code', ...extra })).toThrow(
        /retired MUSTERD_SURFACE.*harness configure/s,
      );
    }
  });

  it('the retired marker refuses even when every local file is valid — no dual read', () => {
    writeRichLocalState();
    expect(() =>
      loadMcpConfig({ MUSTERD_SURFACE: 'cursor', MUSTERD_LAUNCH_SURFACE: 'cursor' }),
    ).toThrow(/retired MUSTERD_SURFACE/);
  });

  it('a valid workspace/binding/capture/observation contributes NOTHING to Surface', () => {
    writeRichLocalState();
    // The capture says cursor; the launcher says claude-code. The launcher wins — it is the only
    // party that knows what is animating THIS session.
    const cfg = loadMcpConfig({ MUSTERD_LAUNCH_SURFACE: 'claude-code' });
    expect(cfg.surface).toBe('claude-code');
    expect(cfg.markerGeneration).toBe('launch');
    // And with no marker at all, the same rich local state cannot rescue the session.
    expect(() => loadMcpConfig({})).toThrow(/no launch Surface marker/);
  });

  it('refusal messages never quote env contents beyond the marker name', () => {
    try {
      resolveLaunchSurface({ MUSTERD_LAUNCH_SURFACE: 'mskey_oops_a_secret' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('mskey_oops_a_secret');
    }
  });
});

describe('binding refresh never updates Surface (ADR 286)', () => {
  it('refreshAttestation updates the model but leaves config.surface exactly as launched', () => {
    writeRichLocalState();
    const cfg = loadMcpConfig({ MUSTERD_LAUNCH_SURFACE: 'claude-code' });
    expect(cfg.surface).toBe('claude-code');
    // A newer observation lands on disk mid-session…
    writeFileSync(
      join(dir, '.musterd', 'binding.json'),
      JSON.stringify({
        version: 2,
        server: 'http://127.0.0.1:4849',
        team: 'revive',
        agent_key: 'mskey_test',
        claim: { mode: 'seat', name: 'miley' },
        session: { harness: 'cursor', id: 's2', started_at: 2 },
        model_observed: { model: 'grok-4.6', harness: 'cursor', observed_at: 2 },
      }),
    );
    expect(refreshAttestation(cfg, { MUSTERD_LAUNCH_SURFACE: 'claude-code' })).toBe(true);
    expect(cfg.model).toBe('grok-4.6'); // model refresh still works…
    expect(cfg.surface).toBe('claude-code'); // …and Surface stays what the launcher declared
  });
});
