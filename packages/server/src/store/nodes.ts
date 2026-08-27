import { TOKEN_PREFIXES } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { hashToken, newSecret } from './members.js';

/**
 * The machine-credential store (ADR 328), increment 3a of the ADR 325 federation build.
 *
 * Every guarded write here takes the `requests.ts` shape — a `WHERE`-conditioned write whose
 * `changes === 0` is a refusal *returned as a value*, never thrown. That is a choice between two
 * shapes the codebase already has, not the only one: `lanes.ts` reads-compares-throws because a
 * lane conflict has to tell a human what moved under them, while a losing enrollment race is an
 * ordinary outcome the caller turns into a 409.
 *
 * ADR 328 §Consequences asked the build to extract a shared guarded-write helper, on the premise
 * that this made "a third and fourth instance". Checked at `5c1b35f0`: there were two instances in
 * two shapes, and they disagree on how a conflict is reported — a helper spanning them would force
 * one call site to adopt the other's failure model. Extraction declined and recorded in the design
 * doc rather than silently skipped. If 3b or 3c adds a third site that genuinely matches THIS
 * shape, extract then, across three that agree.
 */

/** ADR 328 §2: trust-on-first-use, bounded by a short window. */
export const NODE_INVITE_TTL_MS = 15 * 60 * 1000;

/**
 * Mint a single-use enrollment code. The plaintext is returned once and never persisted — only its
 * sha256, the same handling the four token kinds before it get (SPEC A.2).
 */
export function mintInvite(
  db: Database,
  teamId: string,
  label: string,
  createdBy: string,
  now: number = Date.now(),
): { invite: string; expires_at: number } {
  const invite = newSecret(TOKEN_PREFIXES.node_invite);
  const expires_at = now + NODE_INVITE_TTL_MS;
  db.prepare(
    `INSERT INTO node_invites (id, team_id, code_hash, label, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(ulid(), teamId, hashToken(invite), label, createdBy, now, expires_at);
  return { invite, expires_at };
}

/**
 * Consume an invite — the guarded CAS. `null` is a refusal, and deliberately does not say which of
 * the four reasons applies (unknown code, wrong team, already consumed, expired): the caller turns
 * all four into one 409, because telling an unauthenticated caller *which* guess was close is how a
 * code becomes searchable.
 *
 * `WHERE consumed_at IS NULL` is what makes it single-use. Two daemons racing one invite must not
 * both enroll (ADR 328 §2) — SQLite's single writer serialises them, and the loser's UPDATE matches
 * no row.
 */
export function consumeInvite(
  db: Database,
  teamId: string,
  code: string,
  nodeId: string,
  now: number = Date.now(),
): { id: string } | null {
  return (
    db
      .prepare<[number, string, string, string, number], { id: string }>(
        `UPDATE node_invites SET consumed_at = ?, consumed_by = ?
          WHERE team_id = ? AND code_hash = ? AND consumed_at IS NULL AND expires_at > ?
        RETURNING id`,
      )
      .get(now, nodeId, teamId, hashToken(code), now) ?? null
  );
}

/**
 * Bind a credential to a node id the joiner presented (ADR 331 §Decision 1). `null` is a refusal.
 *
 * On the hub the presented id names a row that does not exist yet — the hub has its own row for
 * this team, under a different id — so adoption is an INSERT, not the UPDATE the word "adopt"
 * suggests. (Worth stating plainly: ADR 331's Experiment predicted "write two fields onto an
 * existing row", and on the hub side that prediction is wrong. Recorded rather than smoothed over,
 * because 331 named this increment as where the evidence arrives.)
 *
 * Two refusals, and the second is not in ADR 328 or 331:
 *
 *  1. **Already bound.** `WHERE nodes.credential_hash IS NULL` — an id bound to a credential is not
 *     re-bindable by enrollment. Replacing a live credential is `rotateNode`, under admin
 *     authority, never a path an invite can reach.
 *
 *  2. **The hub's own row.** `credential_hash IS NULL` alone would admit it: a hub never enrolls
 *     with itself, so its own `local_node` row is permanently unbound. A joiner presenting that id
 *     would bind its credential to the hub's origin identity and thereafter stamp events *as* the
 *     hub — every `origin_node` in the log silently ambiguous between two machines. The invite is
 *     admin-minted, single-use and short-lived, so this is not reachable by an outsider; it is
 *     reachable by the invitee, which is exactly the party a CAS exists to bound.
 *
 * A third refusal falls out of the schema rather than the guard, and is tested: `nodes.id` is a
 * global primary key while a node is a machine-*team* principal, so the same id presented under a
 * second team hits the already-bound guard instead of re-pointing the existing row's `team_id`.
 */
export function bindNode(
  db: Database,
  teamId: string,
  nodeId: string,
  label: string,
  credential: string,
  enrolledBy: string,
  now: number = Date.now(),
): { id: string } | null {
  const local = db
    .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
    .get(teamId);
  if (local?.node_id === nodeId) return null;

  const res = db
    .prepare(
      `INSERT INTO nodes (id, team_id, label, next_seq, credential_hash, enrolled_at, enrolled_by)
       VALUES (?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         credential_hash = excluded.credential_hash,
         enrolled_at     = excluded.enrolled_at,
         enrolled_by     = excluded.enrolled_by,
         label           = excluded.label
       WHERE nodes.credential_hash IS NULL`,
    )
    .run(nodeId, teamId, label, hashToken(credential), now, enrolledBy);
  return res.changes === 0 ? null : { id: nodeId };
}
