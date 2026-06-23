import { nextRoleHandle, type Binding, type MemberSummary } from '@musterd/protocol';
import { saveBinding } from './binding.js';
import type { MusterdClient } from './client.js';
import type { McpConfig } from './config.js';
import { clearPendingMarker } from './pending.js';

/** What `team_join` was asked to claim — a named seat, or the next open seat in a role pool. */
export type ClaimTarget = { seat: string } | { role: string };

export interface ClaimResult {
  member: string;
  token: string;
  /** True when we re-occupied this session's own already-bound seat rather than minting a new one. */
  reused: boolean;
}

export class ClaimConflictError extends Error {
  constructor(
    message: string,
    readonly claimable: string[],
  ) {
    super(message);
    this.name = 'ClaimConflictError';
  }
}

/** Does this error carry the server's unique-name `conflict`? (The mint refused a taken name.) */
function isConflict(err: unknown): boolean {
  return err instanceof Error && /conflict|already exists/i.test(err.message);
}

/**
 * Mint-or-reuse a seat for this session (claim-on-first-use, ADR 032). Local + frictionless:
 * minting is the unauthenticated `POST /members`, and a unique-name collision *is* the
 * `claim_conflict` signal — another session already holds that name and we don't have its token, so
 * we refuse rather than impersonate, offering the role pool / a fresh name. Does not occupy the seat
 * (the caller `join()`s after `setIdentity`).
 */
export async function claimSeat(
  client: MusterdClient,
  config: McpConfig,
  target: ClaimTarget,
): Promise<ClaimResult> {
  const { members } = await client.roster();
  if ('seat' in target) {
    const name = target.seat;
    // Re-occupy our own seat (we already hold its token): own reload / explicit re-claim.
    if (config.member === name && config.token) {
      return { member: name, token: config.token, reused: true };
    }
    try {
      const res = await client.addMember(name);
      return { member: name, token: res.token, reused: false };
    } catch (err) {
      if (isConflict(err)) throw conflict(name, members);
      throw err;
    }
  }
  const role = target.role;
  const taken = new Set(members.map((m) => m.name));
  for (let attempt = 0; attempt < 2; attempt++) {
    const handle = nextRoleHandle(role, taken);
    try {
      const res = await client.addMember(handle, role);
      return { member: handle, token: res.token, reused: false };
    } catch (err) {
      if (isConflict(err)) {
        taken.add(handle);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`couldn't find a free seat in role "${role}" — try again`);
}

/**
 * Claim a seat *and* occupy it: mint-or-reuse, bind this session's identity, persist the seat into
 * the workspace binding (ADR 018) + clear the pending marker, then `join()`. Shared by the
 * `team_join` tool and launch-time autojoin so both follow one path. Throws `ClaimConflictError` (a
 * taken name we don't hold) or a plain error (mint/network failure); the caller formats.
 */
export async function claimAndJoin(
  client: MusterdClient,
  config: McpConfig,
  target: ClaimTarget,
): Promise<ClaimResult> {
  const result = await claimSeat(client, config, target);
  client.setIdentity(result.member, result.token);
  const binding: Binding = {
    server: config.server,
    team: config.team,
    member: result.member,
    token: result.token,
    surface: config.surface,
    claim: { mode: 'seat', name: result.member },
  };
  try {
    saveBinding(process.cwd(), binding);
  } catch {
    // identity is held in memory for this session regardless of a binding write failure
  }
  clearPendingMarker(config);
  await client.join();
  return result;
}

function conflict(name: string, members: MemberSummary[]): ClaimConflictError {
  const taken = members.map((m) => m.name);
  return new ClaimConflictError(
    `"${name}" is already a seat on this team and this session doesn't hold its token — ` +
      `pick another name (team_join {as:'<name>'}) or claim a pool seat (team_join {role:'<role>'}).`,
    taken,
  );
}
