import { FEATURE_EPOCH } from '@musterd/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './client.js';
import { CliError } from './errors.js';
import { workspaceGuidanceEpoch } from './guidanceAttestation.js';

// Pin the CLI's own build stamp to "unstamped": the exact-body assertions below must not pick up
// this worktree's ambient dist/build.json (ADR 135) — the build field has its own dedicated tests.
vi.mock('./version.js', () => ({ cliVersion: () => '0.0.0', cliBuild: () => undefined }));
// Pin the workspace guidance epoch too: this suite must assert what the CLIENT sends, not what the
// folder vitest happens to run in has installed (ADR 417).
vi.mock('./guidanceAttestation.js', () => ({ workspaceGuidanceEpoch: vi.fn(() => 24) }));

const seat = { id: 'm1', team: 'dawn', name: 'Ada', kind: 'agent' as const, created_at: 1 };
const input = { key: 'mskey_x', target: { seat: 'Ada' } as const, surface: 'cli' as const };

/** Stub global fetch to return a Response with the given status + JSON body. */
function stubFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * Lane 01M1JQYYAC gave displacement an identity to compare — `workspace_key`, the work-tree root —
 * precisely because the `workspace` LABEL is branch-qualified and is renamed by a branch switch or
 * a detached HEAD under the very session it identifies. `claim --detach` passes it
 * (`commands/claim.ts`, whose comment says the seat would otherwise "evict this folder's own live
 * session on every re-claim") — and it never reached the wire.
 *
 * `HttpClient.claim` forwarded it into `buildClaimFrame` as `workspace_key`, but that builder's
 * input field is `workspaceKey`; it is the thing that converts camelCase to the wire's snake_case.
 * The wrong-named property sits inside a conditional spread, which is exactly the shape TypeScript's
 * excess-property check cannot see, so the mistake typechecked and the field was dropped in silence.
 * The server then falls back to label equality (`ws.ts` sameWorkspace / `http.ts`) — the pre-ADR-368
 * behaviour the key existed to replace.
 */
/**
 * ADR 417, and the same failure shape one field over: dolly's lane 01M2RTF2D0 found this very body
 * silently dropping `model_source` — the third resolved-then-dropped field on this route. The claim
 * frame can carry a value perfectly and the mirror still not send it, because the body is an
 * explicit allow-list and a field absent from it fails no typecheck.
 */
describe('HttpClient.claim — the guidance epoch reaches the wire (ADR 417)', () => {
  it('sends guidance_epoch in the body when the workspace carries a stamp', async () => {
    const fetchFn = stubFetch(200, {
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body['guidance_epoch']).toBe(24);
  });

  it('omits it for a workspace carrying no guidance — absent, never 0', async () => {
    vi.mocked(workspaceGuidanceEpoch).mockReturnValueOnce(undefined);
    const fetchFn = stubFetch(200, {
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect('guidance_epoch' in body).toBe(false);
  });
});

describe('HttpClient.claim — the workspace identity reaches the wire (ADR 368, lane 01M1JQYYAC)', () => {
  it('sends workspace_key in the body, beside the label', async () => {
    const fetchFn = stubFetch(200, {
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    await new HttpClient({ server: 'http://x' }).claim('dawn', {
      ...input,
      workspace: 'repo@feature-branch',
      workspaceKey: '/Users/x/repo',
    });
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body['workspace']).toBe('repo@feature-branch');
    expect(body['workspace_key']).toBe('/Users/x/repo');
  });

  it('omits it when the caller has none — an unbound folder keeps label-only comparison', async () => {
    const fetchFn = stubFetch(200, {
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    await new HttpClient({ server: 'http://x' }).claim('dawn', {
      ...input,
      workspace: 'repo@main',
    });
    const body = JSON.parse(fetchFn.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body['workspace']).toBe('repo@main');
    expect('workspace_key' in body).toBe(false);
  });
});

describe('HttpClient.claim (SPEC A.7, ADR 075/077) — status dispatch', () => {
  it('200 → occupied outcome', async () => {
    stubFetch(200, { type: 'occupied', seat, presence_id: '01J', server_time: 7, memory: null });
    const out = await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    expect(out.state).toBe('occupied');
    if (out.state === 'occupied') {
      expect(out.presenceId).toBe('01J');
      expect(out.serverTime).toBe(7);
    }
  });

  it('202 → pending outcome (request opened, no grant)', async () => {
    stubFetch(202, { type: 'pending', request_id: '01J', message: 'asked admins' });
    const out = await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    expect(out.state).toBe('pending');
    if (out.state === 'pending') expect(out.requestId).toBe('01J');
  });

  it('409 → refused (claim_conflict) with claimable + hint', async () => {
    stubFetch(409, {
      type: 'refused',
      code: 'claim_conflict',
      message: 'seat taken',
      claimable: ['backend-2'],
      hint: 'musterd claim --role backend',
    });
    const out = await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    expect(out.state).toBe('refused');
    if (out.state === 'refused') {
      expect(out.code).toBe('claim_conflict');
      expect(out.claimable).toEqual(['backend-2']);
      expect(out.hint).toBe('musterd claim --role backend');
    }
  });

  it('403 → refused (forbidden, bad key) + 410 → refused (expired_grant)', async () => {
    stubFetch(403, { type: 'refused', code: 'forbidden', message: 'no', claimable: [], hint: 'x' });
    let out = await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    expect(out.state).toBe('refused');
    if (out.state === 'refused') expect(out.code).toBe('forbidden');

    stubFetch(410, {
      type: 'refused',
      code: 'expired_grant',
      message: 'old',
      claimable: [],
      hint: 'rotate',
    });
    out = await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    expect(out.state).toBe('refused');
    if (out.state === 'refused') expect(out.code).toBe('expired_grant');
  });

  it('posts { key, target, grant?, surface } (no WS type/v) to /teams/:slug/claim', async () => {
    // Pin provenance off for the exact-body assertion: this suite can run inside a WOKEN session,
    // whose MUSTERD_PROVENANCE the claim now inherits by design (it has its own tests below).
    vi.stubEnv('MUSTERD_PROVENANCE', '');
    const fn = stubFetch(200, {
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    await new HttpClient({ server: 'http://x' }).claim('dawn', {
      key: 'mskey_x',
      target: { role: 'backend' },
      grant: 'msgr_y',
      surface: 'claude-code',
    });
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe('http://x/teams/dawn/claim');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      key: 'mskey_x',
      target: { role: 'backend' },
      grant: 'msgr_y',
      surface: 'claude-code',
      // Feature epoch (ADR 148) — always attested by our own clients (a compiled-in constant).
      epoch: FEATURE_EPOCH,
      // Guidance epoch (ADR 417) — the stamp in the claiming workspace's own files, mocked above.
      // Unlike `epoch` this one is CONDITIONAL: an unprovisioned folder attests nothing.
      guidance_epoch: 24,
    });
    expect(body.type).toBeUndefined();
    expect(body.v).toBeUndefined();
  });

  // ADR 131 §6. The wake actuators read `provenance` back off the roster to tell their own spawned
  // child from a stranger holding the seat, so a claim that never puts it on the wire costs the
  // actuator that judgement — and until now this route never did.
  it('puts the inherited provenance on the wire under an agent key', async () => {
    vi.stubEnv('MUSTERD_PROVENANCE', 'wake');
    const fn = stubFetch(200, {
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    expect(JSON.parse(fn.mock.calls[0][1].body).provenance).toBe('wake');
  });

  it("never puts it on the wire from a HUMAN credential — a person's shell must not say `wake`", async () => {
    vi.stubEnv('MUSTERD_PROVENANCE', 'wake');
    const fn = stubFetch(200, {
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    await new HttpClient({ server: 'http://x' }).claim('dawn', { ...input, key: 'mscr_nick' });
    expect(JSON.parse(fn.mock.calls[0][1].body).provenance).toBeUndefined();
  });

  it('omits it when the session inherited none', async () => {
    vi.stubEnv('MUSTERD_PROVENANCE', '');
    const fn = stubFetch(200, {
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    expect(JSON.parse(fn.mock.calls[0][1].body).provenance).toBeUndefined();
  });

  /**
   * ADR 301 / lane 01M2RTF2D0. MEASURED 2026-09-17: `grep -n model_source client.ts` returned
   * nothing, while the MCP adapter has sent it since ADR 301 (`mcp/src/client.ts`). Two adapters,
   * one protocol, opposite answers — so a seat that occupied through `musterd claim` carried a model
   * with no tier, and one that occupied through the harness adapter carried the same model with one.
   *
   * The consequence is a ranking, not a missing field. ADR 158 says an observation outranks a
   * declaration; the roster labels the tier off `Presence.model_source`. A CLI-claimed seat reads
   * null → `unknown` → labelled BELOW a seat whose harness merely declared the same model. The rule
   * cannot rank what the CLI never said.
   */
  it('puts model_source beside the model on the claim body (ADR 301)', async () => {
    const fn = stubFetch(200, {
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    await new HttpClient({
      server: 'http://x',
      model: 'claude-fable-5',
      modelSource: 'observed',
    }).claim('dawn', input);
    const body = JSON.parse(fn.mock.calls[0][1].body) as Record<string, unknown>;
    expect(body['model']).toBe('claude-fable-5');
    expect(body['model_source']).toBe('observed');
  });

  it('names the env fallback `environment` when the caller resolved no model itself', async () => {
    vi.stubEnv('MUSTERD_MODEL', 'qwen2.5:3b-instruct');
    const fn = stubFetch(200, {
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    await new HttpClient({ server: 'http://x' }).claim('dawn', input);
    const body = JSON.parse(fn.mock.calls[0][1].body) as Record<string, unknown>;
    expect(body['model']).toBe('qwen2.5:3b-instruct');
    expect(body['model_source']).toBe('environment');
  });

  /** A tier describes an id; with no id there is nothing for it to describe. The server drops a
   *  tier that arrives alone anyway (`ws.ts`, `http.ts`) — this keeps the client from sending one. */
  it('never sends a tier without a model', async () => {
    vi.stubEnv('MUSTERD_MODEL', '');
    vi.stubEnv('ANTHROPIC_MODEL', '');
    const fn = stubFetch(200, {
      type: 'occupied',
      seat,
      presence_id: '01J',
      server_time: 7,
      memory: null,
    });
    await new HttpClient({ server: 'http://x', modelSource: 'observed' }).claim('dawn', input);
    const body = JSON.parse(fn.mock.calls[0][1].body) as Record<string, unknown>;
    expect('model' in body).toBe(false);
    expect('model_source' in body).toBe(false);
  });

  it('5xx → CliError server error (exit 1)', async () => {
    stubFetch(500, {});
    await expect(new HttpClient({ server: 'http://x' }).claim('dawn', input)).rejects.toMatchObject(
      {
        message: /server error \(500\)/,
        exitCode: 1,
      },
    );
  });

  it('connection refused → CliError exit 7 (daemon not running)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8080')),
    );
    await expect(new HttpClient({ server: 'http://x' }).claim('dawn', input)).rejects.toMatchObject(
      {
        exitCode: 7,
      },
    );
  });

  it('4xx with a plain ErrorBody (not a refused frame) → standard error mapping', async () => {
    stubFetch(400, { error: { code: 'bad_request', message: 'no target' } });
    await expect(new HttpClient({ server: 'http://x' }).claim('dawn', input)).rejects.toMatchObject(
      {
        message: 'no target',
      },
    );
  });

  it('200 with a malformed occupied body (missing memory:null) → CliError', async () => {
    stubFetch(200, { type: 'occupied', seat, presence_id: '01J', server_time: 7 });
    await expect(
      new HttpClient({ server: 'http://x' }).claim('dawn', input),
    ).rejects.toBeInstanceOf(CliError);
  });
});

/**
 * ADR 423 (lane 01M2NH5WT9). The fourth resolved-then-dropped field on this family of routes, and
 * the one that had never been resolved at all: `--hook <harness>` shaped the CLI's own stdout and
 * was never sent, so every `interrupt.raised` row since 2026-07-05 was rail-blind and the doorbell
 * contract had to cite a measurer's name per harness instead of a row. Asserted on the URL the
 * client builds, because that is where the previous three were lost.
 */
describe('HttpClient.interruptCheck rail (ADR 423)', () => {
  it('names the rail on the query string when the hook declared one', async () => {
    const fn = stubFetch(200, { raised: false });
    const http = new HttpClient('http://d', 'mscr_x');
    await http.interruptCheck('dawn', { rail: 'claude-code' });
    expect(String((fn.mock.calls[0] as [string])[0])).toContain(
      '/teams/dawn/inbox/interrupt-check?rail=claude-code',
    );
  });

  it('sends no rail at all when the probe was not run from a hook — absent, never guessed', async () => {
    const fn = stubFetch(200, { raised: false });
    const http = new HttpClient('http://d', 'mscr_x');
    await http.interruptCheck('dawn');
    expect(String((fn.mock.calls[0] as [string])[0])).toContain('/inbox/interrupt-check');
    expect(String((fn.mock.calls[0] as [string])[0])).not.toContain('rail');
  });
});
