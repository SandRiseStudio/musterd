import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINDING_DIR, BINDING_FILE, PENDING_DIR, RESOLVED_SUFFIX } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptIdentity, ClaimConflictError, claimAndJoin } from './claim.js';
import type { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import { clearPendingMarker, readAndConsumeResolution, writePendingMarker } from './pending.js';
import { startResolutionWatcher } from './index.js';

function baseConfig(over: Partial<McpConfig> = {}): McpConfig {
  return {
    server: 'http://x',
    team: 'dawn',
    agent_key: 'mskey_team',
    surface: 'claude-code',
    provenance: 'session',
    workspace: 'repo',
    claim: { mode: 'chat' },
    connId: 'conn-1',
    claimCode: 'AB12',
    ...over,
  };
}

/**
 * A fake client that simulates the v0.3 claim handshake: `join()` resolves the seat from the config's
 * claim policy (seat → that name; role → `<role>-1`) and flips `joined`, mirroring an `occupied` frame.
 */
function fakeClient(over: Partial<MusterdClient> = {}): MusterdClient {
  const state = { member: undefined as string | undefined, joined: false };
  const base = {
    roster: async () => ({ members: [] as { name: string }[] }),
    get claimed() {
      return Boolean(state.member);
    },
    get joined() {
      return state.joined;
    },
    get member() {
      return state.member;
    },
    join: async function (this: { config?: McpConfig }) {
      // resolve via the config the test passes through `claimAndJoin` (set below)
    },
  };
  return { ...base, ...over, _state: state } as unknown as MusterdClient;
}

/** A fake whose `join()` resolves the seat from a given config (the handshake's `occupied`). */
function joiningClient(config: McpConfig, over: Partial<MusterdClient> = {}): MusterdClient {
  const state = { member: undefined as string | undefined, joined: false };
  return {
    roster: async () => ({ members: [] as { name: string }[] }),
    get claimed() {
      return Boolean(state.member);
    },
    get joined() {
      return state.joined;
    },
    get member() {
      return state.member;
    },
    join: async () => {
      const c = config.claim;
      state.member = c.mode === 'seat' ? c.name : c.mode === 'role' ? `${c.role}-1` : undefined;
      state.joined = true;
    },
    ...over,
  } as unknown as MusterdClient;
}

describe('claimAndJoin (v0.3 handshake, ADR 075)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'musterd-claimjoin-'));
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('points the claim at the seat, joins, persists the binding, and clears the marker', async () => {
    const config = baseConfig();
    writePendingMarker(config, cwd);
    const res = await claimAndJoin(joiningClient(config), config, { seat: 'Ada' });
    expect(res).toEqual({ member: 'Ada', reused: false });
    expect(config.claim).toEqual({ mode: 'seat', name: 'Ada' });
    const binding = JSON.parse(readFileSync(bindingPath(cwd), 'utf8'));
    expect(binding.agent_key).toBe('mskey_team');
    expect(binding.member).toBeUndefined(); // v0.3: no member/token in the binding
    expect(binding.claim).toEqual({ mode: 'seat', name: 'Ada' });
    expect(existsSync(join(cwd, BINDING_DIR, PENDING_DIR, 'AB12.json'))).toBe(false);
  });

  it('resolves a role pool seat server-side', async () => {
    const config = baseConfig();
    const res = await claimAndJoin(joiningClient(config), config, { role: 'backend' });
    expect(res.member).toBe('backend-1');
    expect(config.claim).toEqual({ mode: 'role', role: 'backend' });
  });

  it('maps a refused (occupied) claim to ClaimConflictError with the roster', async () => {
    const config = baseConfig();
    const client = joiningClient(config, {
      roster: (async () => ({ members: [{ name: 'Ada' }, { name: 'Bo' }] })) as never,
      join: (async () => {
        throw new Error('claim_conflict: seat "Ada" is occupied');
      }) as never,
    });
    await expect(claimAndJoin(client, config, { seat: 'Ada' })).rejects.toBeInstanceOf(
      ClaimConflictError,
    );
  });
});

describe('pending markers (ADR 033)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'musterd-pending-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('writes then clears a marker carrying no secret', () => {
    const config = baseConfig({ driver: 'nick' });
    const p = writePendingMarker(config, cwd);
    expect(p).not.toBeNull();
    const marker = JSON.parse(readFileSync(p!, 'utf8'));
    expect(marker).toMatchObject({
      code: 'AB12',
      team: 'dawn',
      surface: 'claude-code',
      driver: 'nick',
    });
    expect(marker.token).toBeUndefined();
    clearPendingMarker(config, cwd);
    expect(existsSync(p!)).toBe(false);
  });
});

describe('live claim adoption (ADR 034)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'musterd-adopt-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  function resolutionFile(code: string): string {
    return join(cwd, BINDING_DIR, PENDING_DIR, `${code}${RESOLVED_SUFFIX}`);
  }
  function dropResolution(config: McpConfig, body: unknown): void {
    writePendingMarker(config, cwd); // the discovery marker the watcher clears on pickup
    const p = resolutionFile(config.claimCode);
    writeFileSync(p, JSON.stringify(body));
  }

  it('readAndConsumeResolution returns the seat and deletes both files', () => {
    const config = baseConfig();
    dropResolution(config, { seat: 'Ada' });
    const resolved = readAndConsumeResolution(config, cwd);
    expect(resolved).toEqual({ seat: 'Ada' });
    expect(existsSync(resolutionFile('AB12'))).toBe(false);
    expect(existsSync(join(cwd, BINDING_DIR, PENDING_DIR, 'AB12.json'))).toBe(false);
  });

  it('drops a malformed resolution and keeps waiting (returns null)', () => {
    const config = baseConfig();
    dropResolution(config, { member: 'Ada' }); // no `seat`
    expect(readAndConsumeResolution(config, cwd)).toBeNull();
    expect(existsSync(resolutionFile('AB12'))).toBe(false); // the bad file is cleared
  });

  it('returns null when nothing is waiting', () => {
    expect(readAndConsumeResolution(baseConfig(), cwd)).toBeNull();
  });

  it('adoptIdentity claims the resolved seat + joins, and no-ops once already joined', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const config = baseConfig();
    await adoptIdentity(joiningClient(config), config, 'Ada');
    expect(JSON.parse(readFileSync(bindingPath(cwd), 'utf8')).claim).toEqual({
      mode: 'seat',
      name: 'Ada',
    });

    const join2nd = vi.fn(async () => undefined);
    await adoptIdentity(
      joiningClient(config, { joined: true as never, join: join2nd as never }),
      baseConfig(),
      'Bo',
    );
    expect(join2nd).not.toHaveBeenCalled(); // already joined → no double-occupy
  });

  it('startResolutionWatcher brings a pending session online when a resolution appears', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const config = baseConfig();
    let joined = false;
    const state = { member: undefined as string | undefined };
    const client = fakeClient({
      get claimed() {
        return Boolean(state.member);
      },
      get joined() {
        return joined;
      },
      get member() {
        return state.member;
      },
      join: (async () => {
        const c = config.claim;
        state.member = c.mode === 'seat' ? c.name : undefined;
        joined = true;
      }) as never,
    });
    const stop = startResolutionWatcher(client, config, { intervalMs: 5 });
    dropResolution(config, { seat: 'Ada' });
    await vi.waitFor(() => expect(joined).toBe(true), { timeout: 500 });
    expect(state.member).toBe('Ada');
    stop();
  });
});

function bindingPath(cwd: string): string {
  return join(cwd, BINDING_DIR, BINDING_FILE);
}
