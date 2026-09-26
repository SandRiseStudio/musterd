import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { MusterdError } from '../errors.js';

/**
 * Team invites (ADR 450): an admin-minted secret that lets a stranger's OAuth sign-in admit a NEW
 * human member. One invite = a non-secret 3-char selector + one 160-bit secret with two spellings:
 * the link value `<sel>.<base64url secret>` and the typed room code `SEL-XXXX-XXXX` (the secret's
 * first 40 bits in Crockford base32).
 *
 * Verifiers differ on purpose (ADR 450 §1/§3): `secret_hash` = sha256(secret) — 160 bits is
 * unguessable offline; `code_mac` = HMAC-SHA256(k_invite, team ‖ sel ‖ code) with the key kept
 * OUTSIDE the database (beside the effective config, mode 0600) so a dump alone cannot enumerate
 * the 2^40 code space. Online guessing is bounded by a per-invite, source-independent failure
 * budget: a miss charges only the invite the selector names, and the invite burns at the budget.
 * The plaintext secret is returned once at mint and never stored (hard rule 5).
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SELECTOR_LEN = 3;
const CODE_LEN = 8;
export const INVITE_DEFAULTS = {
  maxUses: 100,
  failBudget: 20,
  failBudgetMax: 1000,
  expiresInMs: 24 * 60 * 60 * 1000,
} as const;

export interface TeamInviteRow {
  id: string;
  team_id: string;
  selector: string;
  secret_hash: string;
  code_mac: string;
  max_uses: number;
  uses: number;
  fail_budget: number;
  failures: number;
  expires_at: number;
  member_until: number | null;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
}

export type InviteState = 'live' | 'expired' | 'exhausted' | 'burned' | 'revoked';

/** The redacted projection every list/inventory shows — never a hash, never a secret. */
export interface TeamInviteSummary {
  id: string;
  selector: string;
  state: InviteState;
  uses: number;
  max_uses: number;
  failures: number;
  fail_budget: number;
  expires_at: number;
  member_until: number | null;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
}

// ── the key outside the database ──

let keyOverride: Buffer | null = null;
let keyCache: { path: string; key: Buffer } | null = null;

/** Tests inject a key so an in-memory store never touches the home directory; `null` clears. */
export function __setInviteKeyForTest(key: Buffer | null): void {
  keyOverride = key;
  keyCache = null;
}

/** `invite.key` lives beside the effective config (`MUSTERD_CONFIG`, else `~/.musterd/config.json`). */
export function inviteKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  const cfg = env['MUSTERD_CONFIG'] ?? join(homedir(), '.musterd', 'config.json');
  return join(dirname(cfg), 'invite.key');
}

/** Load (or on first use, generate at 0600) the 256-bit HMAC key for room codes. */
export function loadInviteKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  if (keyOverride) return keyOverride;
  const path = inviteKeyPath(env);
  if (keyCache && keyCache.path === path) return keyCache.key;
  let key: Buffer;
  if (existsSync(path)) {
    key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64url');
    if (key.length !== 32)
      throw new MusterdError('server_error', `invite.key at ${path} is not a 256-bit key`);
  } else {
    key = randomBytes(32);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, key.toString('base64url') + '\n', { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  keyCache = { path, key };
  return key;
}

// ── encodings ──

function crockford(bytes: Buffer, chars: number): string {
  // Consume 5 bits per char from the front of the buffer.
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += CROCKFORD[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= chars) break;
  }
  return out;
}

/** Crockford normalization: case-insensitive, `-`/space ignored, O→0, I/L→1. */
export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** `SEL-XXXX-XXXX` for the slide; the selector rides in front so a typo is charged to one invite. */
export function formatRoomCode(selector: string, code: string): string {
  return `${selector}-${code.slice(0, 4)}-${code.slice(4)}`;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
function codeMac(key: Buffer, teamId: string, selector: string, code: string): string {
  return createHmac('sha256', key).update(`${teamId}\u0000${selector}\u0000${code}`).digest('hex');
}
function eqHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Split a submitted secret into `{selector, link}` or `{selector, code}`. The link form carries a
 * `.`; the typed form is Crockford after normalization. Anything else is `null` (refused uniformly).
 */
export function parseInviteSecret(
  raw: string,
):
  | { selector: string; link: string; code?: undefined }
  | { selector: string; code: string; link?: undefined }
  | null {
  const trimmed = raw.trim();
  const dot = trimmed.indexOf('.');
  if (dot > 0) {
    const selector = normalizeCode(trimmed.slice(0, dot));
    const link = trimmed.slice(dot + 1).trim();
    if (selector.length !== SELECTOR_LEN || !/^[A-Za-z0-9_-]{20,}$/.test(link)) return null;
    return { selector, link };
  }
  const norm = normalizeCode(trimmed);
  if (norm.length !== SELECTOR_LEN + CODE_LEN) return null;
  return { selector: norm.slice(0, SELECTOR_LEN), code: norm.slice(SELECTOR_LEN) };
}

// ── store ──

export function inviteState(row: TeamInviteRow, now = Date.now()): InviteState {
  if (row.revoked_at !== null) return 'revoked';
  if (row.expires_at <= now) return 'expired';
  if (row.uses >= row.max_uses) return 'exhausted';
  if (row.failures >= row.fail_budget) return 'burned';
  return 'live';
}

export function summarizeInvite(row: TeamInviteRow, now = Date.now()): TeamInviteSummary {
  return {
    id: row.id,
    selector: row.selector,
    state: inviteState(row, now),
    uses: row.uses,
    max_uses: row.max_uses,
    failures: row.failures,
    fail_budget: row.fail_budget,
    expires_at: row.expires_at,
    member_until: row.member_until,
    created_by: row.created_by,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

export interface MintInviteInput {
  teamId: string;
  createdBy: string;
  maxUses?: number;
  failBudget?: number;
  expiresAt?: number;
  memberUntil?: number | null;
}

/** Mint one invite. Returns the plaintext link value and room code exactly once. */
export function mintInvite(
  db: Database,
  input: MintInviteInput,
  now = Date.now(),
  key: Buffer = loadInviteKey(),
): { invite: TeamInviteSummary; link_secret: string; room_code: string } {
  const maxUses = input.maxUses ?? INVITE_DEFAULTS.maxUses;
  const failBudget = input.failBudget ?? INVITE_DEFAULTS.failBudget;
  const expiresAt = input.expiresAt ?? now + INVITE_DEFAULTS.expiresInMs;
  if (!Number.isInteger(maxUses) || maxUses < 1)
    throw new MusterdError('bad_request', 'max_uses must be a positive integer');
  if (!Number.isInteger(failBudget) || failBudget < 1 || failBudget > INVITE_DEFAULTS.failBudgetMax)
    throw new MusterdError(
      'bad_request',
      `fail_budget must be 1..${INVITE_DEFAULTS.failBudgetMax}`,
    );
  if (expiresAt <= now) throw new MusterdError('bad_request', 'expires_at must be in the future');
  if (input.memberUntil != null && input.memberUntil <= now)
    throw new MusterdError('bad_request', 'member_until must be in the future');

  // A selector is unique among the team's unrevoked invites; 32^3 = 32768 slots, retry on collision.
  const live = new Set(
    db
      .prepare<[string], { selector: string }>(
        'SELECT selector FROM team_invites WHERE team_id = ? AND revoked_at IS NULL',
      )
      .all(input.teamId)
      .map((r) => r.selector),
  );
  let selector = '';
  for (let i = 0; i < 64; i++) {
    const candidate = crockford(randomBytes(2), SELECTOR_LEN);
    if (!live.has(candidate)) {
      selector = candidate;
      break;
    }
  }
  if (!selector) throw new MusterdError('conflict', 'too many live invites on this team');

  const secretBytes = randomBytes(20);
  const linkSecret = secretBytes.toString('base64url');
  const code = crockford(secretBytes, CODE_LEN);
  const row: TeamInviteRow = {
    id: ulid(),
    team_id: input.teamId,
    selector,
    secret_hash: sha256(linkSecret),
    code_mac: codeMac(key, input.teamId, selector, code),
    max_uses: maxUses,
    uses: 0,
    fail_budget: failBudget,
    failures: 0,
    expires_at: expiresAt,
    member_until: input.memberUntil ?? null,
    created_by: input.createdBy,
    created_at: now,
    revoked_at: null,
  };
  db.prepare(
    `INSERT INTO team_invites (id, team_id, selector, secret_hash, code_mac, max_uses, uses, fail_budget, failures, expires_at, member_until, created_by, created_at, revoked_at)
     VALUES (@id, @team_id, @selector, @secret_hash, @code_mac, @max_uses, @uses, @fail_budget, @failures, @expires_at, @member_until, @created_by, @created_at, @revoked_at)`,
  ).run(row);
  return {
    invite: summarizeInvite(row, now),
    link_secret: `${selector}.${linkSecret}`,
    room_code: formatRoomCode(selector, code),
  };
}

export function listInvites(db: Database, teamId: string, now = Date.now()): TeamInviteSummary[] {
  return db
    .prepare<[string], TeamInviteRow>(
      'SELECT * FROM team_invites WHERE team_id = ? ORDER BY created_at DESC, id DESC',
    )
    .all(teamId)
    .map((r) => summarizeInvite(r, now));
}

/** Revoke one invite; `false` when there is no unrevoked invite by that id on the team. */
export function revokeInvite(db: Database, teamId: string, id: string, now = Date.now()): boolean {
  const res = db
    .prepare(
      'UPDATE team_invites SET revoked_at = ? WHERE team_id = ? AND id = ? AND revoked_at IS NULL',
    )
    .run(now, teamId, id);
  return res.changes === 1;
}

export type RedeemOutcome =
  | { ok: true; invite: TeamInviteRow; via: 'link' | 'code' }
  | { ok: false; selector: string | null; via: 'link' | 'code' | null; charged: boolean };

/**
 * Check a submitted invite secret against the team's live invites. On a miss, charge the invite
 * the selector names (and only it). On a hit, nothing is consumed yet — the caller bumps `uses`
 * with {@link consumeInvite} inside the same transaction once the member row exists, so a refused
 * name (taken / tombstoned) costs the invite nothing (ADR 450 §2.3).
 */
export function checkInvite(
  db: Database,
  teamId: string,
  rawSecret: string,
  now = Date.now(),
  key: Buffer = loadInviteKey(),
): RedeemOutcome {
  const parsed = parseInviteSecret(rawSecret);
  if (!parsed) return { ok: false, selector: null, via: null, charged: false };
  const via: 'link' | 'code' = parsed.link !== undefined ? 'link' : 'code';
  const row = db
    .prepare<
      [string, string],
      TeamInviteRow
    >('SELECT * FROM team_invites WHERE team_id = ? AND selector = ? AND revoked_at IS NULL')
    .get(teamId, parsed.selector);
  if (!row) return { ok: false, selector: parsed.selector, via, charged: false };
  if (inviteState(row, now) !== 'live')
    return { ok: false, selector: parsed.selector, via, charged: false };
  const hit =
    parsed.link !== undefined
      ? eqHex(row.secret_hash, sha256(parsed.link))
      : eqHex(row.code_mac, codeMac(key, teamId, row.selector, parsed.code));
  if (hit) return { ok: true, invite: row, via };
  db.prepare('UPDATE team_invites SET failures = failures + 1 WHERE id = ?').run(row.id);
  return { ok: false, selector: parsed.selector, via, charged: true };
}

/** Count one admission against the invite (call inside the admitting transaction). */
export function consumeInvite(db: Database, inviteId: string): void {
  db.prepare('UPDATE team_invites SET uses = uses + 1 WHERE id = ?').run(inviteId);
}
