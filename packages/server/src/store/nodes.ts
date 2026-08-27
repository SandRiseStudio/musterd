import { TOKEN_PREFIXES, type NodeSummary } from '@musterd/protocol';
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
 * **Any id the hub already knows is refused, whatever state it is in.** A legitimate joiner's id is
 * fresh to the hub *by construction*: it is the ULID migration v47 minted on the joiner's own
 * machine, which the hub has never seen. So a conflict on `nodes.id` is never a case to reconcile —
 * it is always one of three attacks or mistakes, and all three want the same answer:
 *
 *  1. **An already-enrolled node.** Re-binding a live credential by enrollment would let a spent
 *     machine be impersonated by whoever holds the next invite. Replacing a credential is
 *     `rotateNode`, under admin authority, never a path an invite can reach. (This is the refusal
 *     ADR 331 §Consequences left owed.)
 *  2. **The hub's own row for this team.** A hub never enrolls with itself, so its `local_node` row
 *     is unbound *permanently*. Binding it would let the joiner stamp events **as the hub**.
 *  3. **The hub's own row for a DIFFERENT team it hosts** — miley's review finding, 2026-08-27
 *     (`01M12KQHT8`). This is the one an earlier draft got wrong: the guard was
 *     `credential_hash IS NULL` plus an exclusion scoped to the *enrolling* team, and every part of
 *     it passes when a joiner enrolling into A presents the id of the hub's local row for B. The
 *     `DO UPDATE` then wrote a foreign credential onto B's origin identity, left `team_id` as B, and
 *     reported success — after which the joiner authenticates as team B's node.
 *
 * `DO NOTHING` answers all three with one clause and no subselect. The earlier shape needed a
 * `local_node` lookup that was correct only for the team being enrolled, which is precisely the
 * scoping that let (3) through; a guard that has to enumerate what it excludes will keep missing
 * cases, while "the hub has never seen this id" is the property actually required.
 *
 * `local_node` remains load-bearing for `insertMessage` (v48) — it is simply no longer part of this
 * guard.
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
  const res = db
    .prepare(
      `INSERT INTO nodes (id, team_id, label, next_seq, credential_hash, enrolled_at, enrolled_by)
       VALUES (?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(nodeId, teamId, label, hashToken(credential), now, enrolledBy);
  return res.changes === 0 ? null : { id: nodeId };
}

/**
 * Rotate: mint a fresh `msnode_` against the SAME node row (ADR 328 §5). The id — and therefore
 * every `origin_node` already stamped in the log — is stable across credential changes, which is
 * why §5 made the id a ULID on the row and explicitly never derived it from the credential.
 *
 * This is the one path allowed to overwrite a non-NULL hash, which is exactly why it is separate
 * from `bindNode` and gated on admin authority at the route rather than on an invite. Refuses a
 * revoked node: re-arming a retired credential is an enrollment decision, not a rotation.
 */
export function rotateNode(
  db: Database,
  teamId: string,
  nodeId: string,
  now: number = Date.now(),
): { credential: string } | null {
  const credential = newSecret(TOKEN_PREFIXES.node);
  const res = db
    .prepare(
      `UPDATE nodes SET credential_hash = ?, enrolled_at = ?
        WHERE id = ? AND team_id = ? AND revoked_at IS NULL`,
    )
    .run(hashToken(credential), now, nodeId, teamId);
  return res.changes === 0 ? null : { credential };
}

/**
 * Revoke: the hub refuses push, pull, and claim from this node immediately (ADR 328 §5).
 *
 * What revocation deliberately does NOT do: events already ingested stay, because the log is
 * append-only and those events are attested history — revoking a credential is not retro-repudiating
 * what was said under it. Lanes held by that node's seats are not auto-released either; a cascade
 * would close work on a judgement-free timer, and releasing them stays an ordinary human act.
 *
 * `false` means already revoked or unknown — idempotent without claiming to have acted.
 */
export function revokeNode(
  db: Database,
  teamId: string,
  nodeId: string,
  now: number = Date.now(),
): boolean {
  return (
    db
      .prepare(
        'UPDATE nodes SET revoked_at = ? WHERE id = ? AND team_id = ? AND revoked_at IS NULL',
      )
      .run(now, nodeId, teamId).changes > 0
  );
}

/**
 * Authenticate a presented `msnode_`. Null unless the credential is bound, unrevoked, and belongs
 * to *this* team — a node speaks for the team it was admitted to and no other (ADR 325's one team,
 * one authority).
 *
 * Note what this does not grant: ADR 328 §3 admits an `msnode_` to the sync surface only. It is not
 * a seat credential and cannot claim a seat, read as a member, or raise an act — that separation is
 * enforced at the routes, since a machine being admitted and a seat being authorized are
 * independent axes.
 */
export function authenticateNode(
  db: Database,
  teamId: string,
  token: string,
): { id: string; label: string } | null {
  if (!token) return null;
  return (
    db
      .prepare<[string, string], { id: string; label: string }>(
        `SELECT id, label FROM nodes
          WHERE team_id = ? AND credential_hash = ? AND revoked_at IS NULL`,
      )
      .get(teamId, hashToken(token)) ?? null
  );
}

/**
 * Admin listing. The hash never leaves the store — `credential_prefix` is the token *kind*, not a
 * leading slice of the secret, so it says "enrolled" without handing over anything to start from.
 * Unenrolled rows (this daemon's own, and any minted-but-never-joined) list with nulls: "enrolled"
 * is a state to check, not one the row's existence guarantees (ADR 331 §Consequences).
 */
export function listNodes(db: Database, teamId: string): NodeSummary[] {
  return db
    .prepare<
      [string],
      {
        id: string;
        label: string;
        enrolled_at: number | null;
        revoked_at: number | null;
        last_seen_at: number | null;
        credential_hash: string | null;
      }
    >(
      `SELECT id, label, enrolled_at, revoked_at, last_seen_at, credential_hash
         FROM nodes WHERE team_id = ? ORDER BY enrolled_at IS NULL, enrolled_at DESC, id`,
    )
    .all(teamId)
    .map((r) => ({
      id: r.id,
      label: r.label,
      enrolled_at: r.enrolled_at,
      revoked_at: r.revoked_at,
      last_seen_at: r.last_seen_at,
      credential_prefix: r.credential_hash ? TOKEN_PREFIXES.node : null,
    }));
}
