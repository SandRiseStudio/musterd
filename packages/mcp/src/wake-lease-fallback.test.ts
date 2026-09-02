import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINDING_DIR, WAKE_LEASE_FILE } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadMcpConfig } from './config.js';

/**
 * `loadMcpConfig` and the wake-lease file (lane 01M1HM8EEK, ADR 354): the ladder is
 *
 *   provenance / wake lease  =  env  >  wake-lease.json (only when env is silent AND the file
 *                                       names our parent pid)  >  nothing
 *
 * Env stays first everywhere, so Claude Code — which forwards the actuator's env to its MCP servers
 * and has never had this problem — is untouched. The file exists for harnesses that sanitize the
 * MCP environment (codex, measured 2026-09-02), where before this the adapter attested
 * `provenance: session` and no lease, ADR 241 read the seat as held by another session, and the
 * actuator killed the review it had spawned ninety seconds earlier.
 */

let dir: string;
const NOW = 1_800_000_000_000;

// Same fixture shape as attestation-gap.test.ts: the workspace is the cwd, identity comes from
// binding.json, and the headless test surface marker stands in for a real launch registration.
const baseEnv = (): NodeJS.ProcessEnv => ({
  MUSTERD_TEST_SURFACE: 'codex',
});

const writeLease = (spawnerPid: number, over: Record<string, unknown> = {}) => {
  mkdirSync(join(dir, BINDING_DIR), { recursive: true });
  writeFileSync(
    join(dir, BINDING_DIR, 'binding.json'),
    JSON.stringify({
      version: 2,
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      claim: { mode: 'seat', name: 'gptbot' },
      agent_key: 'msak_test',
    }),
  );
  writeFileSync(
    join(dir, BINDING_DIR, WAKE_LEASE_FILE),
    JSON.stringify({
      lease_id: '01M1HKKABRN1N967MXZY1EAG19',
      provenance: 'wake',
      harness: 'codex',
      spawner_pid: spawnerPid,
      started_at: NOW - 5_000,
      expires_at: NOW + 1_800_000,
      ...over,
    }),
  );
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-wake-lease-fallback-'));
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('loadMcpConfig — the wake-lease file fills a silent env, never overrides a spoken one', () => {
  it('silent env + file naming our parent ⇒ provenance wake and the lease (the codex wake)', () => {
    writeLease(4242);
    const cfg = loadMcpConfig(baseEnv(), { now: () => NOW, ppid: () => 4242 });
    expect(cfg.provenance).toBe('wake');
    expect(cfg.wakeLease).toBe('01M1HKKABRN1N967MXZY1EAG19');
  });

  it('silent env + file naming SOMEONE ELSE ⇒ session, no lease (a human in the same workspace)', () => {
    writeLease(4242);
    const cfg = loadMcpConfig(baseEnv(), { now: () => NOW, ppid: () => 7 });
    expect(cfg.provenance).toBe('session');
    expect(cfg.wakeLease).toBeUndefined();
  });

  it('env speaks ⇒ env wins, file ignored even when it would match (Claude Code’s path, unchanged)', () => {
    writeLease(4242, { lease_id: 'FROM_FILE' });
    const cfg = loadMcpConfig(
      { ...baseEnv(), MUSTERD_PROVENANCE: 'wake', MUSTERD_WAKE_LEASE: 'FROM_ENV' },
      { now: () => NOW, ppid: () => 4242 },
    );
    expect(cfg.provenance).toBe('wake');
    expect(cfg.wakeLease).toBe('FROM_ENV');
  });

  it('env says session explicitly ⇒ the file does not promote it to wake', () => {
    // An explicit provenance is an assertion by whoever launched us; a file must not out-argue it.
    writeLease(4242);
    const cfg = loadMcpConfig(
      { ...baseEnv(), MUSTERD_PROVENANCE: 'session' },
      { now: () => NOW, ppid: () => 4242 },
    );
    expect(cfg.provenance).toBe('session');
    expect(cfg.wakeLease).toBeUndefined();
  });

  it('no file at all ⇒ exactly today’s behaviour', () => {
    mkdirSync(join(dir, BINDING_DIR), { recursive: true });
    writeFileSync(
      join(dir, BINDING_DIR, 'binding.json'),
      JSON.stringify({
        version: 2,
        server: 'http://127.0.0.1:4849',
        team: 'revive',
        claim: { mode: 'seat', name: 'gptbot' },
        agent_key: 'msak_test',
      }),
    );
    const cfg = loadMcpConfig(baseEnv(), { now: () => NOW, ppid: () => 4242 });
    expect(cfg.provenance).toBe('session');
    expect(cfg.wakeLease).toBeUndefined();
  });
});
