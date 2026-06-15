import { createHash, randomBytes } from 'node:crypto';
import type { Lifecycle, MemberKind } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { MusterdError } from '../errors.js';
import type { MemberRow, TeamRow } from './rows.js';
import { requireTeam } from './teams.js';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return 'mskd_' + randomBytes(24).toString('base64url');
}

export interface AddMemberInput {
  name: string;
  kind: MemberKind;
  role?: string;
  lifecycle?: Lifecycle;
  lifecycleUntil?: number | null;
  availability?: Record<string, unknown> | null;
}

/** Add a member to a team and mint its one-time token. Returns the row plus the plaintext token. */
export function addMember(
  db: Database,
  team: TeamRow,
  input: AddMemberInput,
): { row: MemberRow; token: string } {
  if (!input.name || /\s/.test(input.name)) {
    throw new MusterdError(
      'bad_request',
      'member name is required and must not contain whitespace',
    );
  }
  const existing = getMemberByName(db, team.id, input.name);
  if (existing && existing.left_at === null) {
    throw new MusterdError('conflict', `member "${input.name}" already exists in "${team.slug}"`);
  }
  const lifecycle = input.lifecycle ?? (team.default_lifecycle as Lifecycle);
  if (lifecycle === 'until' && !input.lifecycleUntil) {
    throw new MusterdError('bad_request', 'lifecycle "until" requires a timestamp');
  }
  const token = newToken();
  const now = Date.now();
  const row: MemberRow = {
    id: ulid(),
    team_id: team.id,
    name: input.name,
    kind: input.kind,
    role: input.role ?? '',
    lifecycle,
    lifecycle_until: input.lifecycleUntil ?? null,
    availability: input.availability ? JSON.stringify(input.availability) : null,
    token_hash: hashToken(token),
    left_at: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO members
       (id, team_id, name, kind, role, lifecycle, lifecycle_until, availability, token_hash, left_at, created_at, updated_at)
     VALUES
       (@id, @team_id, @name, @kind, @role, @lifecycle, @lifecycle_until, @availability, @token_hash, @left_at, @created_at, @updated_at)`,
  ).run(row);
  return { row, token };
}

export function getMemberByName(db: Database, teamId: string, name: string): MemberRow | undefined {
  return db
    .prepare<[string, string], MemberRow>('SELECT * FROM members WHERE team_id = ? AND name = ?')
    .get(teamId, name);
}

export function getMemberById(db: Database, id: string): MemberRow | undefined {
  return db.prepare<[string], MemberRow>('SELECT * FROM members WHERE id = ?').get(id);
}

export function listMembers(db: Database, teamId: string): MemberRow[] {
  return db
    .prepare<
      [string],
      MemberRow
    >('SELECT * FROM members WHERE team_id = ? AND left_at IS NULL ORDER BY created_at')
    .all(teamId);
}

/** Authenticate a token to a specific member in a specific team. Throws unauthorized/forbidden. */
export function authMember(
  db: Database,
  teamSlug: string,
  token: string,
): { team: TeamRow; member: MemberRow } {
  const team = requireTeam(db, teamSlug);
  const hash = hashToken(token);
  const member = db
    .prepare<
      [string, string],
      MemberRow
    >('SELECT * FROM members WHERE team_id = ? AND token_hash = ? AND left_at IS NULL')
    .get(team.id, hash);
  if (!member)
    throw new MusterdError(
      'unauthorized',
      `invalid token for team "${teamSlug}" — this member may not exist on the database this daemon is serving ` +
        `(a daemon started against a different MUSTERD_DB will not recognize tokens minted elsewhere)`,
    );
  return { team, member };
}

export function leaveMember(db: Database, memberId: string): void {
  db.prepare('UPDATE members SET left_at = ?, updated_at = ? WHERE id = ?').run(
    Date.now(),
    Date.now(),
    memberId,
  );
}

export { newToken };
