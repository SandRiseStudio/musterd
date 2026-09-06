import { describe, expect, it } from 'vitest';
import type { Identity } from '../config.js';
import { identityClientOpts } from './helpers.js';

/**
 * Lane 01M1T29EV9. ADR 365/368 gave displacement an identity to compare — `workspace_key`, the work
 * tree root — because the `workspace` LABEL is branch-qualified and is renamed by a branch switch or
 * a detached HEAD under the very session it identifies. The server compares keys only when BOTH
 * sides sent one (`ws.ts` sameWorkspace), so a claim that omits the key silently reinstates the
 * label comparison the key exists to replace.
 *
 * `gather()` resolved `workspaceKey` on every CLI invocation and BOTH `HttpClient` constructions
 * dropped it, so `claimSessionLease` — the per-request claim every ordinary command makes — has
 * been claiming without workspace identity since #1229 (2026-09-02). Measured on this machine
 * 2026-09-05: six `claim.superseded` rows, `same_workspace: false`, a CLI successor evicting the
 * seat's own live MCP session in ONE work tree, after a branch switch.
 *
 * The literal was written twice by hand, which is why one omission could hide. These tests pin the
 * shared builder both call sites now use.
 */
describe('identityClientOpts — the resolved workspace identity reaches the client (ADR 365/368)', () => {
  const identity = {
    name: 'Ada',
    key: 'msac_test1234567890abcdef',
    surface: 'cli',
  } as unknown as Identity;

  const base = {
    server: 'http://x',
    team: 'dawn',
    workspace: 'agents-dolly@some-branch',
    workspaceKey: '/Users/x/agents-dolly',
    identity,
  };

  it('carries workspaceKey beside the label — the field that was resolved and never passed', () => {
    const opts = identityClientOpts(base, true);
    expect(opts.workspace).toBe('agents-dolly@some-branch');
    expect(opts.workspaceKey).toBe('/Users/x/agents-dolly');
  });

  it('is the same shape for a read as for an act — only the per-request claim differs', () => {
    // resolveRead passes `claimSeatPerRequest: false` for the interrupt probe (ADR 088); every
    // other field must be identical, or the two paths drift again the way they did here.
    const act = identityClientOpts(base, true);
    const read = identityClientOpts(base, false);
    expect(act.claimSeatPerRequest).toBe(true);
    expect(read.claimSeatPerRequest).toBe(false);
    expect({ ...act, claimSeatPerRequest: undefined }).toEqual({
      ...read,
      claimSeatPerRequest: undefined,
    });
  });

  it('passes the seat, credential and surface through unchanged', () => {
    const opts = identityClientOpts(base, true);
    expect(opts.seat).toBe('Ada');
    expect(opts.key).toBe('msac_test1234567890abcdef');
    expect(opts.surface).toBe('cli');
  });

  it('omits model and sessionLease when the identity has neither — absent, not undefined-valued', () => {
    const opts = identityClientOpts(base, true);
    expect('model' in opts).toBe(false);
    expect('sessionLease' in opts).toBe(false);
  });
});
