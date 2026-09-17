import {
  GovernedAuthorizationRequestSchema,
  GovernedDecisionSchema,
  GovernedLaunchAuthorizationConsumeSchema,
  GovernedLaunchAuthorizationIssueSchema,
  GovernedLaunchAuthorizationMintSchema,
  GovernedLaunchAuthorizationSchema,
  GovernedPolicySchema,
  GovernedWorkContextSchema,
  TOKEN_PREFIXES,
  type GovernedAuthorizationRequest,
  type GovernedDecision,
  type GovernedLaunchAuthorization,
  type GovernedLaunchAuthorizationConsume,
  type GovernedLaunchAuthorizationIssue,
  type GovernedLaunchAuthorizationMint,
  type GovernedPolicy,
  type GovernedRefusalCode,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { MusterdError } from '../errors.js';
import { hashToken, newSecret } from './members.js';
import type { MemberRow } from './rows.js';
import { resolveAccountStatus } from './rows.js';

const LIVE_PRESENCE_DEFAULT_MS = 45_000;

interface GovernedLaunchRow {
  id: string;
  team_id: string;
  member_id: string;
  node_id: string;
  token_hash: string;
  correlation: string;
  work_context: string;
  issued_by_member_id: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  revoked_at: number | null;
  presence_id: string | null;
}

function memberByName(db: Database, teamId: string, name: string): MemberRow | undefined {
  return db
    .prepare<[string, string], MemberRow>('SELECT * FROM members WHERE team_id = ? AND name = ?')
    .get(teamId, name);
}

function policyRow(
  db: Database,
  teamId: string,
): { policy: string; updated_at: number } | undefined {
  return db
    .prepare<
      [string],
      { policy: string; updated_at: number }
    >('SELECT policy, updated_at FROM governed_policies WHERE team_id = ?')
    .get(teamId);
}

export function getGovernedPolicy(
  db: Database,
  teamId: string,
): { policy: GovernedPolicy; updated_at: number } | null {
  const row = policyRow(db, teamId);
  if (!row) return null;
  return { policy: GovernedPolicySchema.parse(JSON.parse(row.policy)), updated_at: row.updated_at };
}

export function setGovernedPolicy(
  db: Database,
  teamId: string,
  policy: GovernedPolicy,
  now: number = Date.now(),
): { policy: GovernedPolicy; updated_at: number } {
  const parsed = GovernedPolicySchema.parse(policy);
  db.prepare(
    `INSERT INTO governed_policies (team_id, policy, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET policy = excluded.policy, updated_at = excluded.updated_at`,
  ).run(teamId, JSON.stringify(parsed), now);
  return { policy: parsed, updated_at: now };
}

function launchProjection(db: Database, row: GovernedLaunchRow): GovernedLaunchAuthorization {
  const team = db
    .prepare<[string], { slug: string }>('SELECT slug FROM teams WHERE id = ?')
    .get(row.team_id);
  const member = db
    .prepare<[string], { name: string }>('SELECT name FROM members WHERE id = ?')
    .get(row.member_id);
  const issuer = row.issued_by_member_id
    ? db
        .prepare<[string], { name: string }>('SELECT name FROM members WHERE id = ?')
        .get(row.issued_by_member_id)
    : undefined;
  if (!team || !member)
    throw new MusterdError('server_error', 'governed authorization references missing roster data');
  return GovernedLaunchAuthorizationSchema.parse({
    id: row.id,
    team: team.slug,
    member: member.name,
    node_id: row.node_id,
    correlation: row.correlation,
    context: GovernedWorkContextSchema.parse(JSON.parse(row.work_context)),
    issued_by: issuer?.name ?? null,
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
    revoked_at: row.revoked_at,
    presence_id: row.presence_id,
  });
}

function requireLaunchTarget(
  db: Database,
  teamId: string,
  input: GovernedLaunchAuthorizationIssue,
): MemberRow {
  const member = memberByName(db, teamId, input.member);
  if (!member) throw new MusterdError('not_found', `no governed agent Member "${input.member}"`);
  if (member.kind !== 'agent' || member.observer === 1)
    throw new MusterdError('forbidden', 'governed launches may target only an agent Member');
  const status = resolveAccountStatus(member);
  if (
    member.left_at !== null ||
    status === 'disabled' ||
    status === 'banned' ||
    status === 'archived'
  )
    throw new MusterdError('forbidden', `Member "${member.name}" is not active`);
  const binding = db
    .prepare<[string, string, string], { node_id: string; revoked_at: number | null }>(
      `SELECT s.node_id, n.revoked_at FROM seat_nodes s JOIN nodes n ON n.id = s.node_id
       WHERE s.team_id = ? AND s.member_id = ? AND s.node_id = ? AND n.credential_hash IS NOT NULL`,
    )
    .get(teamId, member.id, input.node_id);
  if (!binding || binding.revoked_at !== null)
    throw new MusterdError(
      'forbidden',
      `Member "${member.name}" is not bound to that machine node`,
    );
  const bindings = db
    .prepare<[string], { node_id: string }>('SELECT node_id FROM seat_nodes WHERE member_id = ?')
    .all(member.id);
  if (bindings.length !== 1)
    throw new MusterdError(
      'conflict',
      `agent Member "${member.name}" must have exactly one machine-node binding`,
    );
  return member;
}

export function issueGovernedLaunch(
  db: Database,
  teamId: string,
  issuer: MemberRow,
  rawInput: GovernedLaunchAuthorizationIssue,
  now: number = Date.now(),
): GovernedLaunchAuthorizationMint {
  const input = GovernedLaunchAuthorizationIssueSchema.parse(rawInput);
  if (issuer.team_id !== teamId)
    throw new MusterdError('forbidden', 'governed launch issuer is not a Member of this Team');
  const issuerStatus = resolveAccountStatus(issuer);
  if (
    issuer.kind !== 'human' ||
    issuer.left_at !== null ||
    issuerStatus === 'disabled' ||
    issuerStatus === 'banned' ||
    issuerStatus === 'archived'
  )
    throw new MusterdError('forbidden', 'only an active human Member may issue a governed launch');
  const member = requireLaunchTarget(db, teamId, input);
  const token = newSecret(TOKEN_PREFIXES.governed_launch);
  const row: GovernedLaunchRow = {
    id: ulid(),
    team_id: teamId,
    member_id: member.id,
    node_id: input.node_id,
    token_hash: hashToken(token),
    correlation: input.correlation,
    work_context: JSON.stringify(input.context),
    issued_by_member_id: issuer.id,
    created_at: now,
    expires_at: now + input.ttl_ms,
    consumed_at: null,
    revoked_at: null,
    presence_id: null,
  };
  db.prepare(
    `INSERT INTO governed_launch_authorizations
      (id, team_id, member_id, node_id, token_hash, correlation, work_context,
       issued_by_member_id, created_at, expires_at, consumed_at, revoked_at, presence_id)
     VALUES (@id, @team_id, @member_id, @node_id, @token_hash, @correlation, @work_context,
       @issued_by_member_id, @created_at, @expires_at, @consumed_at, @revoked_at, @presence_id)`,
  ).run(row);
  return GovernedLaunchAuthorizationMintSchema.parse({
    authorization: launchProjection(db, row),
    token,
  });
}

export type GovernedLaunchConsumeResult =
  | { ok: true; authorization: GovernedLaunchAuthorization }
  | { ok: false; reason: GovernedRefusalCode };

export function consumeGovernedLaunch(
  db: Database,
  teamId: string,
  rawInput: GovernedLaunchAuthorizationConsume,
  now: number = Date.now(),
): GovernedLaunchConsumeResult {
  const input = GovernedLaunchAuthorizationConsumeSchema.parse(rawInput);
  const row = db
    .prepare<
      [string, string],
      GovernedLaunchRow
    >('SELECT * FROM governed_launch_authorizations WHERE team_id = ? AND id = ?')
    .get(teamId, input.launch_id);
  if (!row) return { ok: false, reason: 'denied_launch_unknown' };
  if (row.revoked_at !== null) return { ok: false, reason: 'denied_launch_revoked' };
  if (row.expires_at <= now) return { ok: false, reason: 'denied_launch_expired' };
  if (row.consumed_at !== null) return { ok: false, reason: 'denied_launch_replayed' };
  const member = memberByName(db, teamId, input.member);
  if (
    row.token_hash !== hashToken(input.token) ||
    row.member_id !== member?.id ||
    row.node_id !== input.node_id ||
    row.correlation !== input.correlation
  )
    return { ok: false, reason: 'denied_launch_mismatch' };
  const presence = db
    .prepare<
      [string],
      { member_id: string; held_until: number | null }
    >('SELECT member_id, held_until FROM presence WHERE id = ?')
    .get(input.presence_id);
  if (!presence) return { ok: false, reason: 'denied_presence_unknown' };
  if (presence.member_id !== member.id || presence.held_until !== null)
    return { ok: false, reason: 'denied_presence_stale' };
  const updated = db
    .prepare<[number, string, string, string, string, number], GovernedLaunchRow>(
      `UPDATE governed_launch_authorizations
       SET consumed_at = ?, presence_id = ?
       WHERE team_id = ? AND id = ? AND token_hash = ? AND consumed_at IS NULL
         AND revoked_at IS NULL AND expires_at > ?
       RETURNING *`,
    )
    .get(now, input.presence_id, teamId, input.launch_id, hashToken(input.token), now);
  if (!updated) return { ok: false, reason: 'denied_launch_replayed' };
  return { ok: true, authorization: launchProjection(db, updated) };
}

export function revokeGovernedLaunch(
  db: Database,
  teamId: string,
  id: string,
  now: number = Date.now(),
): boolean {
  return (
    db
      .prepare<
        [number, string, string]
      >('UPDATE governed_launch_authorizations SET revoked_at = ? WHERE team_id = ? AND id = ? AND revoked_at IS NULL')
      .run(now, teamId, id).changes > 0
  );
}

export interface GovernedNodeAuthentication {
  id: string;
  label: string;
  revoked: boolean;
}

/** Authenticate a node for governed routes while preserving the revoked-vs-unknown refusal. */
export function authenticateGovernedNode(
  db: Database,
  teamId: string,
  token: string,
): GovernedNodeAuthentication | null {
  if (!token) return null;
  const row = db
    .prepare<
      [string, string],
      { id: string; label: string; revoked_at: number | null }
    >('SELECT id, label, revoked_at FROM nodes WHERE team_id = ? AND credential_hash = ?')
    .get(teamId, hashToken(token));
  return row ? { id: row.id, label: row.label, revoked: row.revoked_at !== null } : null;
}

function deny(input: GovernedAuthorizationRequest, reason: GovernedRefusalCode): GovernedDecision {
  return GovernedDecisionSchema.parse({
    decision: 'deny',
    reason,
    launch_id: input.launch_id,
    correlation: input.correlation,
    member: input.member,
    node_id: input.node_id,
    provider: input.provider,
    model: input.model,
  });
}

export function authorizeGovernedRequest(
  db: Database,
  teamId: string,
  nodeCredential: string,
  rawInput: GovernedAuthorizationRequest,
  options: { now?: number; livePresenceMs?: number } = {},
): GovernedDecision {
  const input = GovernedAuthorizationRequestSchema.parse(rawInput);
  const now = options.now ?? Date.now();
  const node = authenticateGovernedNode(db, teamId, nodeCredential);
  if (!node) return deny(input, 'denied_node_unknown');
  if (node.revoked) return deny(input, 'denied_node_revoked');
  if (node.id !== input.node_id) return deny(input, 'denied_node_binding');
  const launch = db
    .prepare<
      [string, string],
      GovernedLaunchRow
    >('SELECT * FROM governed_launch_authorizations WHERE team_id = ? AND id = ?')
    .get(teamId, input.launch_id);
  if (!launch) return deny(input, 'denied_launch_unknown');
  if (launch.revoked_at !== null) return deny(input, 'denied_launch_revoked');
  if (launch.expires_at <= now) return deny(input, 'denied_launch_expired');
  if (launch.consumed_at === null) return deny(input, 'denied_launch_unknown');
  const member = memberByName(db, teamId, input.member);
  if (
    launch.member_id !== member?.id ||
    launch.node_id !== input.node_id ||
    launch.correlation !== input.correlation ||
    launch.presence_id !== input.presence_id
  )
    return deny(input, 'denied_launch_mismatch');
  if (!member) return deny(input, 'denied_member_unknown');
  const status = resolveAccountStatus(member);
  if (
    member.kind !== 'agent' ||
    member.left_at !== null ||
    status === 'disabled' ||
    status === 'banned' ||
    status === 'archived'
  )
    return deny(input, 'denied_member_inactive');
  const binding = db
    .prepare<
      [string, string, string],
      { node_id: string }
    >('SELECT node_id FROM seat_nodes WHERE team_id = ? AND member_id = ? AND node_id = ?')
    .get(teamId, member.id, input.node_id);
  if (!binding) return deny(input, 'denied_node_binding');
  const live = db
    .prepare<[string, string, string, number], { id: string }>(
      `SELECT p.id FROM presence p JOIN members m ON m.id = p.member_id
       WHERE m.team_id = ? AND p.member_id = ? AND p.id = ?
         AND p.held_until IS NULL AND p.last_seen_at > ?`,
    )
    .get(
      teamId,
      member.id,
      input.presence_id,
      now - (options.livePresenceMs ?? LIVE_PRESENCE_DEFAULT_MS),
    );
  if (!live) return deny(input, 'denied_presence_stale');
  const context = GovernedWorkContextSchema.parse(JSON.parse(launch.work_context));
  if (context.kind === 'lane') {
    const lane = db
      .prepare<
        [string, string],
        { state: string; owner_seat: string | null }
      >('SELECT state, owner_seat FROM lanes WHERE team_id = ? AND id = ?')
      .get(teamId, context.lane_id);
    if (
      !lane ||
      lane.owner_seat !== member.name ||
      lane.state === 'done' ||
      lane.state === 'abandoned'
    )
      return deny(input, 'denied_context_lane');
  } else if (context.kind === 'act') {
    const act = db
      .prepare<[string, string, string], { id: string }>(
        `SELECT m.id FROM messages m
         WHERE m.team_id = ? AND m.id = ? AND m.to_member = ?
           AND m.act NOT IN ('resolve', 'accept', 'decline')
           AND NOT EXISTS (
             SELECT 1 FROM messages r WHERE r.team_id = m.team_id
               AND r.act IN ('accept','decline')
               AND json_extract(r.meta, '$.in_reply_to') = m.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM messages r WHERE r.team_id = m.team_id
               AND r.act = 'resolve'
               AND r.thread_id = COALESCE(m.thread_id, m.id)
           )`,
      )
      .get(teamId, context.act_id, member.id);
    if (!act) return deny(input, 'denied_context_act');
  } else {
    return deny(input, 'denied_context_orientation');
  }
  const stored = getGovernedPolicy(db, teamId);
  if (!stored) return deny(input, 'denied_policy');
  const models = stored.policy.members[member.name]?.models ?? stored.policy.team.models;
  if (!models.includes(input.model) || !input.model.startsWith(`${input.provider}/`))
    return deny(input, 'denied_model');
  return GovernedDecisionSchema.parse({
    decision: 'allow',
    reason: 'allowed',
    launch_id: input.launch_id,
    correlation: input.correlation,
    member: member.name,
    node_id: node.id,
    provider: input.provider,
    model: input.model,
  });
}
