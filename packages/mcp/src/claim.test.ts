import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BINDING_DIR,
  BINDING_FILE,
  PENDING_DIR,
  RESOLVED_SUFFIX,
  type Binding,
} from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptIdentity, ClaimConflictError, claimAndJoin, persistRenewedLease } from './claim.js';
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
    markerGeneration: 'test-override',
    provenance: 'session',
    workspace: 'repo',
    claim: { mode: 'chat' },
    connId: 'conn-1',
    claimCode: 'AB12',
    // Default the identity anchor to the (mocked) cwd so the existing suites, which assert the binding
    // lands under `cwd`, keep passing; the clobber tests below override it to a distinct dir.
    bindingDir: process.cwd(),
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

  /**
   * Lane 01M2GP25R3, clause 8. The deaf line prescribes `team_join` as THE repair for a dead
   * session lease — it is the only thing that holds a Presence. But an explicit join answered from
   * the local `joined` flag never reaches the server, so it repairs nothing and says "already".
   *
   * Measured twice on 2026-09-14: izzo's seat went deaf on every daemon bounce and a no-op
   * "Already joined" team_join did NOT clear it (a later `team_send` did — that path goes through
   * `request()`, sees the 401, and re-joins for real); stanley hit the same after an MCP transport
   * drop. The flag is in-process state and the thing that died is server-side, so the flag is
   * exactly the wrong authority: it reports on a Presence it cannot see.
   *
   * Autojoin keeps the cheap reuse — it fires on every tool call and must not add a round trip.
   * An EXPLICIT team_join is a decision to re-occupy, and is rare, so it verifies.
   */
  it('an explicit join re-occupies instead of trusting the local flag — the prescribed repair must repair', async () => {
    const config = baseConfig();
    const client = joiningClient(config);
    const spy = vi.spyOn(client, 'join');

    await claimAndJoin(client, config, { seat: 'Ada' });
    expect(spy).toHaveBeenCalledTimes(1);

    // The seat is now deaf server-side; the adapter cannot know, and its flag still says joined.
    // An explicit re-join must go to the server anyway.
    const res = await claimAndJoin(client, config, { seat: 'Ada' }, undefined, { verify: true });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.member).toBe('Ada');
  });

  it('autojoin still reuses without a round trip — the common path stays free', async () => {
    const config = baseConfig();
    const client = joiningClient(config);
    const spy = vi.spyOn(client, 'join');
    await claimAndJoin(client, config, { seat: 'Ada' });
    const res = await claimAndJoin(client, config, { seat: 'Ada' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ member: 'Ada', reused: true });
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

  it('carries the attested model through the re-claim rewrite (ADR 101)', async () => {
    // Regression: persistBinding rebuilt the binding from scratch and omitted `model`, so every
    // autojoin/reclaim silently wiped a `--model`-provisioned seat back to `unknown` — the diversity
    // flag went dark on the next adapter boot.
    const config = baseConfig({ model: 'claude-fable-5' });
    await claimAndJoin(joiningClient(config), config, { seat: 'Ada' });
    expect(JSON.parse(readFileSync(bindingPath(cwd), 'utf8')).model).toBe('claude-fable-5');
  });

  it('persists no model when the occupancy attests none (stays honestly unknown)', async () => {
    const config = baseConfig();
    await claimAndJoin(joiningClient(config), config, { seat: 'Ada' });
    expect(JSON.parse(readFileSync(bindingPath(cwd), 'utf8')).model).toBeUndefined();
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

  // Finding 1 (binding clobber): the write must land in the workspace the session was resolved from
  // (`bindingDir`), never ambient `process.cwd()` — a wandering cwd used to overwrite a *sibling*
  // worktree's binding.json.
  it('persists to config.bindingDir, not ambient process.cwd() (no sibling clobber)', async () => {
    const anchor = mkdtempSync(join(tmpdir(), 'musterd-anchor-'));
    const sibling = cwd; // the mocked process.cwd() — a different worktree
    try {
      const config = baseConfig({ bindingDir: anchor });
      await claimAndJoin(joiningClient(config), config, { seat: 'Ada' });
      // Written under the anchor…
      expect(existsSync(bindingPath(anchor))).toBe(true);
      expect(JSON.parse(readFileSync(bindingPath(anchor), 'utf8')).claim).toEqual({
        mode: 'seat',
        name: 'Ada',
      });
      // …and the ambient cwd (the "sibling worktree") is left untouched.
      expect(existsSync(bindingPath(sibling))).toBe(false);
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  // Finding 2 (#118 class): an explicit named claim re-reads binding.json so an in-session repair
  // (a re-provisioned grant/key) takes effect without a full MCP reconnect.
  it('re-reads the on-disk binding for the target seat and adopts its repaired grant/key', async () => {
    const anchor = mkdtempSync(join(tmpdir(), 'musterd-repair-'));
    try {
      // Simulate a repaired binding.json on disk (fresh grant/key for seat "Ada").
      mkdirSync(join(anchor, BINDING_DIR), { recursive: true });
      writeFileSync(
        bindingPath(anchor),
        JSON.stringify({
          version: 2,
          server: 'http://x',
          team: 'dawn',
          agent_key: 'mskey_repaired',
          claim: { mode: 'seat', name: 'Ada' },
          grant: 'msgr_repaired',
        }),
      );
      // Boot config still holds the STALE grant/key.
      const config = baseConfig({
        bindingDir: anchor,
        grant: 'msgr_stale',
        agent_key: 'mskey_stale',
      });
      await claimAndJoin(joiningClient(config), config, { seat: 'Ada' });
      expect(config.grant).toBe('msgr_repaired');
      expect(config.agent_key).toBe('mskey_repaired');
      // The SURFACE is deliberately not adopted (changed 2026-08-12 off the first live native
      // wake). Credentials on disk can be newer than the ones we booted with — that is what this
      // re-read is for. A surface cannot: it says what is animating this session, which the process
      // knows first-hand. Adopting it let a repaired binding retitle a running session's harness.
      expect(config.surface).toBe('claude-code');
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });

  it('leaves the boot grant untouched when the on-disk binding targets a different seat', async () => {
    const anchor = mkdtempSync(join(tmpdir(), 'musterd-otherseat-'));
    try {
      mkdirSync(join(anchor, BINDING_DIR), { recursive: true });
      writeFileSync(
        bindingPath(anchor),
        JSON.stringify({
          version: 2,
          server: 'http://x',
          team: 'dawn',
          agent_key: 'mskey_ryder',
          claim: { mode: 'seat', name: 'ryder' },
          grant: 'msgr_ryder',
        }),
      );
      const config = baseConfig({ bindingDir: anchor, grant: 'msgr_boot' });
      // We ask to become "Ada" but the on-disk binding is for "ryder" → never borrow ryder's grant.
      await claimAndJoin(joiningClient(config), config, { seat: 'Ada' });
      expect(config.grant).toBe('msgr_boot');
    } finally {
      rmSync(anchor, { recursive: true, force: true });
    }
  });
});

// Lane 01M3A921SA (2026-09-24, the ADR 344 cutover): `wire --migrate-bootstrap` rewrote a live seat's
// agent_key on disk, and the adapter's next lease renewal wrote its BOOT key straight back — so the
// seat could never leave the legacy key while a session was open. A renewal persists the lease; the
// credentials it carries are whatever is on disk, never what the process read at launch.
describe('persistRenewedLease never downgrades a credential it did not mint', () => {
  let anchor: string;
  beforeEach(() => {
    anchor = mkdtempSync(join(tmpdir(), 'musterd-renew-'));
    mkdirSync(join(anchor, BINDING_DIR), { recursive: true });
  });
  afterEach(() => rmSync(anchor, { recursive: true, force: true }));

  const writeOnDisk = (over: Partial<Binding>): void =>
    writeFileSync(
      bindingPath(anchor),
      JSON.stringify({
        version: 2,
        server: 'http://x',
        team: 'dawn',
        claim: { mode: 'seat', name: 'Ada' },
        ...over,
      }),
    );

  it('keeps the migrated agent_key and seat_credential on disk, and adopts them for reconnect', () => {
    writeOnDisk({ agent_key: 'mskey_migrated', seat_credential: 'mscr_migrated' });
    const config = baseConfig({
      bindingDir: anchor,
      member: 'Ada',
      agent_key: 'mskey_legacy',
      seatCredential: 'mscr_boot',
      sessionLease: 'lease_renewed',
    });
    persistRenewedLease(config);
    const disk = readBinding(anchor);
    expect(disk.agent_key).toBe('mskey_migrated');
    expect(disk.seat_credential).toBe('mscr_migrated');
    expect(disk.session_lease).toBe('lease_renewed');
    expect(config.agent_key).toBe('mskey_migrated');
    expect(config.seatCredential).toBe('mscr_migrated');
  });

  it('falls back to the boot key when the disk binding carries none', () => {
    writeOnDisk({});
    const config = baseConfig({
      bindingDir: anchor,
      member: 'Ada',
      agent_key: 'mskey_boot',
      sessionLease: 'lease_renewed',
    });
    persistRenewedLease(config);
    expect(readBinding(anchor).agent_key).toBe('mskey_boot');
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

function readBinding(cwd: string): Binding {
  return JSON.parse(readFileSync(bindingPath(cwd), 'utf8')) as Binding;
}

describe('claimAndJoin concurrency + surface authority (live native-wake findings, 2026-08-12)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-claim-race-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeBinding = (b: Partial<Binding>) => {
    mkdirSync(join(dir, BINDING_DIR), { recursive: true });
    writeFileSync(
      join(dir, BINDING_DIR, BINDING_FILE),
      JSON.stringify({
        version: 2,
        server: 'http://x',
        team: 'dawn',
        claim: { mode: 'seat', name: 'compo' },
        ...b,
      }),
    );
  };

  it('single-flights a concurrent claim: two callers in one turn claim ONCE, not twice', async () => {
    // The first live native wake (2026-08-12): the model issued `team_join` in PARALLEL with
    // `team_inbox_check` in one assistant turn. The explicit join and the sibling call's deferred
    // autojoin both passed the already-claimed guard (neither had finished), so the seat was
    // claimed twice — `claim.duplicate_workspace`, then `claim.superseded {evicted:1}`. The session
    // watched itself get evicted and declined to answer the act it was woken for.
    const config = baseConfig({ bindingDir: dir, claim: { mode: 'chat' } });
    let joins = 0;
    const state = { member: undefined as string | undefined };
    // Built inline rather than through `joiningClient(over)`: object spread EVALUATES getters and
    // copies their values, so overridden accessors would freeze at their boot values.
    const client = {
      roster: async () => ({ members: [] as { name: string }[] }),
      get claimed() {
        return Boolean(state.member);
      },
      get joined() {
        return Boolean(state.member);
      },
      get member() {
        return state.member;
      },
      join: async () => {
        joins += 1;
        await new Promise((r) => setTimeout(r, 20)); // in flight — not yet claimed
        state.member = 'compo';
      },
    } as unknown as MusterdClient;

    const [a, b] = await Promise.all([
      claimAndJoin(client, config, { seat: 'compo' }),
      claimAndJoin(client, config, { seat: 'compo' }),
    ]);

    expect(joins).toBe(1);
    expect(a.member).toBe('compo');
    expect(b.member).toBe('compo');
  });

  it('does not let the binding re-read clobber a surface the HOST declared', async () => {
    // ADR 251 §2: a native occupancy attests surface `musterd`, which is what makes it
    // roster-distinct. The host constructs that config itself (it is not in the workspace), but the
    // ADR 018 repair re-read adopted the binding's `cursor` over it — measured live, the first
    // native occupancy attested `cursor` and the distinctness claim silently failed.
    writeBinding({ grant: 'msgr_fresh', agent_key: 'mskey_fresh' });
    const config = baseConfig({ bindingDir: dir, surface: 'musterd', claim: { mode: 'chat' } });
    await claimAndJoin(joiningClient(config), config, { seat: 'compo' });
    expect(config.surface).toBe('musterd');
    // The credential half of the repair still applies — that is what the re-read is FOR.
    expect(config.grant).toBe('msgr_fresh');
    expect(config.agent_key).toBe('mskey_fresh');
  });

  it('never adopts a Surface from disk — the launcher declared it, and v2 identity carries none (ADR 286)', async () => {
    writeBinding({});
    const config = baseConfig({ bindingDir: dir, surface: 'other', claim: { mode: 'chat' } });
    await claimAndJoin(joiningClient(config), config, { seat: 'compo' });
    expect(config.surface).toBe('other');
  });
});
