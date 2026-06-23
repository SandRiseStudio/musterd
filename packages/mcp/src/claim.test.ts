import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BINDING_DIR, BINDING_FILE, PENDING_DIR, RESOLVED_SUFFIX } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptIdentity, ClaimConflictError, claimAndJoin, claimSeat } from './claim.js';
import type { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import { clearPendingMarker, readAndConsumeResolution, writePendingMarker } from './pending.js';
import { startResolutionWatcher } from './index.js';

function baseConfig(over: Partial<McpConfig> = {}): McpConfig {
  return {
    server: 'http://x',
    team: 'dawn',
    surface: 'claude-code',
    provenance: 'session',
    workspace: 'repo',
    claim: { mode: 'chat' },
    connId: 'conn-1',
    claimCode: 'AB12',
    ...over,
  };
}

/** A fake client exposing only what claimSeat / claimAndJoin touch. */
function fakeClient(over: Partial<MusterdClient> = {}): MusterdClient {
  return {
    roster: async () => ({ members: [] }),
    addMember: async () => ({ token: 'mskd_minted' }),
    setIdentity: () => undefined,
    join: async () => undefined,
    ...over,
  } as unknown as MusterdClient;
}

describe('claimSeat (mint-or-reuse, ADR 032)', () => {
  it('mints a fresh named seat', async () => {
    const res = await claimSeat(fakeClient(), baseConfig(), { seat: 'Ada' });
    expect(res).toEqual({ member: 'Ada', token: 'mskd_minted', reused: false });
  });

  it("reuses the session's own already-held seat without re-minting", async () => {
    const addMember = vi.fn();
    const res = await claimSeat(
      fakeClient({ addMember: addMember as never }),
      baseConfig({ member: 'Ada', token: 'tkn' }),
      { seat: 'Ada' },
    );
    expect(res).toEqual({ member: 'Ada', token: 'tkn', reused: true });
    expect(addMember).not.toHaveBeenCalled();
  });

  it('maps a unique-name collision to ClaimConflictError with the roster', async () => {
    const client = fakeClient({
      roster: (async () => ({ members: [{ name: 'Ada' }, { name: 'Bo' }] })) as never,
      addMember: (async () => {
        throw new Error('member "Ada" already exists in "dawn"');
      }) as never,
    });
    await expect(claimSeat(client, baseConfig(), { seat: 'Ada' })).rejects.toBeInstanceOf(
      ClaimConflictError,
    );
  });

  it('claims the next open pool seat, retrying past a racing mint', async () => {
    let calls = 0;
    const client = fakeClient({
      roster: (async () => ({ members: [{ name: 'backend-1' }] })) as never,
      addMember: (async (name: string) => {
        calls++;
        if (name === 'backend-2' && calls === 1) throw new Error('conflict');
        return { token: 'mskd_minted' };
      }) as never,
    });
    const res = await claimSeat(client, baseConfig(), { role: 'backend' });
    expect(res.member).toBe('backend-3');
  });
});

describe('claimAndJoin', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'musterd-claimjoin-'));
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('sets identity, persists the binding, clears the marker, and joins', async () => {
    const setIdentity = vi.fn();
    const join = vi.fn(async () => undefined);
    const config = baseConfig();
    writePendingMarker(config, cwd);
    await claimAndJoin(
      fakeClient({ setIdentity: setIdentity as never, join: join as never }),
      config,
      {
        seat: 'Ada',
      },
    );
    expect(setIdentity).toHaveBeenCalledWith('Ada', 'mskd_minted');
    expect(join).toHaveBeenCalled();
    const binding = JSON.parse(readFileSync(join2(cwd), 'utf8'));
    expect(binding.member).toBe('Ada');
    expect(binding.claim).toEqual({ mode: 'seat', name: 'Ada' });
    expect(existsSync(join(cwd, BINDING_DIR, PENDING_DIR, 'AB12.json'))).toBe(false);
  });
});

describe('pending markers (ADR 033)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'musterd-pending-'));
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('writes then clears a marker carrying no token', () => {
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
    dropResolution(config, { member: 'Ada', token: 'mskd_x' });
    const resolved = readAndConsumeResolution(config, cwd);
    expect(resolved).toEqual({ member: 'Ada', token: 'mskd_x' });
    expect(existsSync(resolutionFile('AB12'))).toBe(false);
    expect(existsSync(join(cwd, BINDING_DIR, PENDING_DIR, 'AB12.json'))).toBe(false);
  });

  it('drops a malformed resolution and keeps waiting (returns null)', () => {
    const config = baseConfig();
    dropResolution(config, { member: 'Ada' }); // no token
    expect(readAndConsumeResolution(config, cwd)).toBeNull();
    expect(existsSync(resolutionFile('AB12'))).toBe(false); // the bad file is cleared
  });

  it('returns null when nothing is waiting', () => {
    expect(readAndConsumeResolution(baseConfig(), cwd)).toBeNull();
  });

  it('adoptIdentity binds + joins, and no-ops once already joined', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const setIdentity = vi.fn();
    const join = vi.fn(async () => undefined);
    await adoptIdentity(
      fakeClient({ setIdentity: setIdentity as never, join: join as never }),
      baseConfig(),
      'Ada',
      'mskd_x',
    );
    expect(setIdentity).toHaveBeenCalledWith('Ada', 'mskd_x');
    expect(join).toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join2(cwd), 'utf8')).member).toBe('Ada');

    const join2nd = vi.fn(async () => undefined);
    await adoptIdentity(
      fakeClient({ joined: true as never, join: join2nd as never }),
      baseConfig(),
      'Bo',
      't',
    );
    expect(join2nd).not.toHaveBeenCalled(); // already joined → no double-occupy
  });

  it('startResolutionWatcher brings a pending session online when a resolution appears', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    const config = baseConfig();
    let member: string | undefined;
    let joined = false;
    const client = fakeClient({
      get claimed() {
        return Boolean(member);
      },
      get joined() {
        return joined;
      },
      setIdentity: ((m: string) => {
        member = m;
      }) as never,
      join: (async () => {
        joined = true;
      }) as never,
    });
    const stop = startResolutionWatcher(client, config, { intervalMs: 5 });
    dropResolution(config, { member: 'Ada', token: 'mskd_x' });
    await vi.waitFor(() => expect(joined).toBe(true), { timeout: 500 });
    expect(member).toBe('Ada');
    stop();
  });
});

function join2(cwd: string): string {
  return join(cwd, BINDING_DIR, BINDING_FILE);
}
