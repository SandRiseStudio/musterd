# Federation increment 3a — node credential: implementation plan

> **For agentic workers:** this plan is executed **inline, by the seat that owns the lane** (musterd
> ADR 150 lane ownership — see the repo's coordination rules). Do NOT dispatch writing subagents.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a machine a credential — `msnode_` identity minted through a short-lived `msinv_`
invite, rotatable and revocable — so a second daemon can be admitted to a team.

**Architecture:** A store module (`store/nodes.ts`) owns every guarded write; the transport is thin.
Enrollment routes ride the ADR 040 secured bind and never widen `isLocalPeer`. `musterd node join`
goes CLI → local daemon → hub, so one process owns the node row, the credential, and
`~/.musterd/node.json`. A `local_node` marker table lands first as a correctness fix to increment 2.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), better-sqlite3 (synchronous, single
writer), zod for wire schemas, vitest, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-27-node-credential-design.md`

**Lane:** `01M12B79XGFSGAFQC0966F437V` · **Branch:** `stanley/federation-node-credential`

## Global Constraints

- **ADRs governing:** 325 (federation topology), 328 (the credential), 331 (the ordering substrate).
  This is a build task under all three; contradicting any of them means stopping to write an ADR.
- **Never widen `isLocalPeer`** (ADR 328 §6). New routes are new; no existing localhost-only route
  becomes remote-reachable.
- **Secrets are hashed at rest**, plaintext returned exactly once, masked to prefix in any listing —
  `newSecret` + `hashToken` from `store/members.ts`, the pattern all four existing token kinds use.
- **Migrations are rewind-and-replay safe** — `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT
  EXISTS`, `INSERT OR IGNORE`. The migration tests rewind `schema_version` and replay the tail.
- **Machine-local paths go through `machineStatePath(envKey, file)`** so ADR 190 vitest isolation
  applies and the suite cannot write the operator's real `~/.musterd`.
- **TDD.** Every task writes its failing test first and runs it to watch it fail before implementing.
- **Gates before submit:** `pnpm install && pnpm --filter "@musterd/*" build`, then typecheck 0,
  lint 0, server suite green, cli suite green, `pnpm change-adr:check`, `pnpm wiki:check`.

---

### Task 1: `local_node` — the correctness fix to increment 2

The reason this is first: `insertMessage` picks its node row with `ORDER BY id LIMIT 1`, which is
correct only while `nodes` holds one row per team. Every later task in this plan adds the second row.
Until this lands, enrollment corrupts the ordering substrate.

**Files:**
- Modify: `packages/server/src/db/migrations.ts` (append migration v48)
- Modify: `packages/server/src/store/messages.ts:30-47` (`localNodeForTeam`)
- Test: `packages/server/src/store/localNode.test.ts` (create)

**Interfaces:**
- Consumes: v47's `nodes` table, `localNodeForTeam(db, teamId)` as it stands.
- Produces: table `local_node(team_id PRIMARY KEY, node_id)`; `localNodeForTeam` reading it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/store/localNode.test.ts
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { openTestDb, seedTeam } from '../testing/db.js'; // match the helper the sibling
                                                         // store tests use; see originStamp.test.ts
import { insertMessage } from './messages.js';

describe('local_node (ADR 331 substrate, increment 3a)', () => {
  it('stamps OUR node even when a remote node row sorts lower', () => {
    const db = openTestDb();
    const team = seedTeam(db, 'revive');

    // Force our own row to exist, then insert a remote row whose ULID sorts BELOW it.
    insertMessage(db, team.id, team.memberId, null, envelope('first'));
    const ours = db
      .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
      .get(team.id)!.node_id;

    const lower = '0' + ours.slice(1); // sorts strictly below `ours`
    db.prepare(
      'INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)',
    ).run(lower, team.id, 'someone-elses-laptop');

    const before = db
      .prepare<[string], { next_seq: number }>('SELECT next_seq FROM nodes WHERE id = ?')
      .get(lower)!.next_seq;

    const row = insertMessage(db, team.id, team.memberId, null, envelope('second'));

    expect(row.origin_node).toBe(ours);            // not `lower`
    expect(
      db.prepare<[string], { next_seq: number }>('SELECT next_seq FROM nodes WHERE id = ?')
        .get(lower)!.next_seq,
    ).toBe(before);                                // the remote counter is untouched
  });
});
```

Reuse whatever `openTestDb` / `seedTeam` / envelope helper `store/originStamp.test.ts` already uses —
read that file first and match it rather than inventing a second harness.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @musterd/server exec vitest run src/store/localNode.test.ts`
Expected: FAIL — `origin_node` is `lower`, and the remote `next_seq` advanced to 2. This is the
defect, reproduced.

- [ ] **Step 3: Add migration v48**

```ts
// packages/server/src/db/migrations.ts — append to the migrations array
{
  // ADR 325 residence 3 (local-only, never replicated): which `nodes` row is THIS daemon's, per
  // team. v47's ORDER BY id LIMIT 1 was correct only while enrollment did not exist; increment 3a
  // is what adds the second row, so the marker has to precede it. Backfills from v47's rows, all
  // of which are local by construction — nothing has ever enrolled.
  version: 48,
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_node (
        team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
        node_id TEXT NOT NULL REFERENCES nodes(id)
      );
      INSERT OR IGNORE INTO local_node (team_id, node_id) SELECT team_id, id FROM nodes;
    `);
  },
},
```

- [ ] **Step 4: Rewrite `localNodeForTeam`**

```ts
// packages/server/src/store/messages.ts
/**
 * This team's local node row (ADR 331 §Decision 1) — per (daemon, team). The marker table is the
 * authority (increment 3a): once enrollment exists, `nodes` holds remote rows too, and picking by
 * ULID order would stamp our messages with someone else's origin and bump their sequence.
 */
function localNodeForTeam(db: Database, teamId: string): { id: string } {
  const marked = db
    .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
    .get(teamId);
  if (marked) return { id: marked.node_id };

  const id = ulid();
  db.prepare('INSERT INTO nodes (id, team_id, label, next_seq) VALUES (?, ?, ?, 1)').run(
    id,
    teamId,
    hostname(),
  );
  db.prepare('INSERT INTO local_node (team_id, node_id) VALUES (?, ?)').run(teamId, id);
  return { id };
}
```

Note the lazy-mint path now writes both tables, and `insertMessage` already wraps this in
`db.transaction`, so the pair is atomic.

- [ ] **Step 5: Run the new test and the increment-2 suite**

Run: `pnpm --filter @musterd/server exec vitest run src/store/localNode.test.ts src/store/originStamp.test.ts`
Expected: PASS, both files. `originStamp.test.ts` must not need editing — if it does, the change
altered increment 2's behavior and that needs explaining, not patching.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/migrations.ts packages/server/src/store/messages.ts packages/server/src/store/localNode.test.ts
git commit -m "fix(server): local_node marker — stamp OUR origin once remote rows exist (v48)"
```

---

### Task 2: token kinds and wire schemas

**Files:**
- Modify: `packages/protocol/src/credentials.ts:18-27`
- Create: `packages/protocol/src/nodes.ts`
- Modify: `packages/protocol/src/index.ts` (export the new module — match how siblings are exported)
- Test: `packages/protocol/src/nodes.test.ts` (create)

**Interfaces:**
- Produces: `TOKEN_PREFIXES.node = 'msnode_'`, `TOKEN_PREFIXES.node_invite = 'msinv_'`;
  `NodeInviteMintSchema`, `NodeJoinRequestSchema`, `NodeJoinResponseSchema`, `NodeSummarySchema`,
  `NodeListSchema`, `NodeEnrollRequestSchema` and their inferred types.

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/src/nodes.test.ts
import { describe, expect, it } from 'vitest';
import { TOKEN_PREFIXES } from './credentials.js';
import { NodeJoinRequestSchema, NodeListSchema } from './nodes.js';

describe('node wire schemas (ADR 328)', () => {
  it('registers the two new token kinds', () => {
    expect(TOKEN_PREFIXES.node).toBe('msnode_');
    expect(TOKEN_PREFIXES.node_invite).toBe('msinv_');
  });

  it('requires a presented node id on join (ADR 331: the joiner allocates)', () => {
    expect(() => NodeJoinRequestSchema.parse({ code: 'msinv_x', label: 'laptop' })).toThrow();
    expect(
      NodeJoinRequestSchema.parse({ code: 'msinv_x', node_id: '01M', label: 'laptop' }).node_id,
    ).toBe('01M');
  });

  it('never carries a credential in a listing', () => {
    const parsed = NodeListSchema.parse({
      nodes: [
        {
          id: '01M',
          label: 'laptop',
          enrolled_at: 1,
          revoked_at: null,
          last_seen_at: null,
          credential_prefix: 'msnode_abc',
        },
      ],
    });
    expect(Object.keys(parsed.nodes[0]!)).not.toContain('credential_hash');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @musterd/protocol exec vitest run src/nodes.test.ts`
Expected: FAIL — cannot resolve `./nodes.js`.

- [ ] **Step 3: Add the token kinds**

```ts
// packages/protocol/src/credentials.ts — inside TOKEN_PREFIXES
  /** A machine credential — what an admitted daemon presents on the sync surface (ADR 328). */
  node: 'msnode_',
  /** A single-use, short-TTL enrollment code that mints one `msnode_` (ADR 328 §2). */
  node_invite: 'msinv_',
```

- [ ] **Step 4: Write the schemas**

```ts
// packages/protocol/src/nodes.ts
import { z } from 'zod';

/**
 * The machine-credential surface (ADR 328), increment 3a of the ADR 325 federation build. A node is
 * a machine-TEAM principal: a daemon hosting two teams holds two node identities (ADR 331 §1).
 */

/** `POST /teams/:slug/nodes/invite` — the enrollment code, shown **once**. */
export const NodeInviteMintSchema = z.object({
  invite: z.string(),
  expires_at: z.number().int(),
});
export type NodeInviteMint = z.infer<typeof NodeInviteMintSchema>;

/**
 * `POST /teams/:slug/nodes/join` — the joiner PRESENTS the node id it minted under v47 rather than
 * receiving a fresh one (ADR 331 §Decision 1). The hub still vouches: it binds the id under a
 * guarded CAS and refuses one already bound to a different credential.
 */
export const NodeJoinRequestSchema = z.object({
  code: z.string(),
  node_id: z.string().min(1),
  label: z.string().min(1),
});
export type NodeJoinRequest = z.infer<typeof NodeJoinRequestSchema>;

/** The durable machine credential, shown **once**. */
export const NodeJoinResponseSchema = z.object({
  node_credential: z.string(),
  node_id: z.string(),
  team: z.string(),
});
export type NodeJoinResponse = z.infer<typeof NodeJoinResponseSchema>;

/** A node as an admin sees it — never the hash, only enough prefix to tell two apart. */
export const NodeSummarySchema = z.object({
  id: z.string(),
  label: z.string(),
  enrolled_at: z.number().int().nullable(),
  revoked_at: z.number().int().nullable(),
  last_seen_at: z.number().int().nullable(),
  credential_prefix: z.string().nullable(),
});
export type NodeSummary = z.infer<typeof NodeSummarySchema>;

export const NodeListSchema = z.object({ nodes: z.array(NodeSummarySchema) });
export type NodeList = z.infer<typeof NodeListSchema>;

/** `POST /node/enroll` — the local half: the CLI asks its OWN daemon to go enroll at a hub. */
export const NodeEnrollRequestSchema = z.object({
  hub_url: z.string().url(),
  code: z.string(),
  team: z.string(),
});
export type NodeEnrollRequest = z.infer<typeof NodeEnrollRequestSchema>;
```

- [ ] **Step 5: Export and verify**

Add `export * from './nodes.js';` to `packages/protocol/src/index.ts` alongside its siblings.

Run: `pnpm --filter @musterd/protocol exec vitest run src/nodes.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/protocol/src/credentials.ts packages/protocol/src/nodes.ts packages/protocol/src/nodes.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): msnode_/msinv_ token kinds and the node enrollment schemas"
```

---

### Task 3: `node_invites` and the invite CAS

**Files:**
- Modify: `packages/server/src/db/migrations.ts` (append v49)
- Create: `packages/server/src/store/nodes.ts`
- Test: `packages/server/src/store/nodes.invite.test.ts` (create)

**Interfaces:**
- Consumes: `hashToken`, `newSecret` from `./members.js`; `TOKEN_PREFIXES` from `@musterd/protocol`.
- Produces:
  - `NODE_INVITE_TTL_MS = 15 * 60 * 1000`
  - `mintInvite(db, teamId, label, createdBy, now?) => { invite: string; expires_at: number }`
  - `consumeInvite(db, teamId, code, nodeId, now?) => { id: string } | null` — `null` is refusal

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/src/store/nodes.invite.test.ts
import { describe, expect, it } from 'vitest';
import { consumeInvite, mintInvite, NODE_INVITE_TTL_MS } from './nodes.js';

describe('node invites (ADR 328 §2)', () => {
  it('is single-use — two racing consumers, exactly one wins', () => {
    const db = openTestDb();
    const team = seedTeam(db, 'revive');
    const { invite } = mintInvite(db, team.id, 'laptop', 'nick');

    const first = consumeInvite(db, team.id, invite, 'node-a');
    const second = consumeInvite(db, team.id, invite, 'node-b');

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('refuses an expired invite', () => {
    const db = openTestDb();
    const team = seedTeam(db, 'revive');
    const t0 = 1_000_000;
    const { invite } = mintInvite(db, team.id, 'laptop', 'nick', t0);

    expect(consumeInvite(db, team.id, invite, 'node-a', t0 + NODE_INVITE_TTL_MS + 1)).toBeNull();
    expect(consumeInvite(db, team.id, invite, 'node-a', t0 + 1)).not.toBeNull();
  });

  it('stores only the hash, never the plaintext', () => {
    const db = openTestDb();
    const team = seedTeam(db, 'revive');
    const { invite } = mintInvite(db, team.id, 'laptop', 'nick');
    const rows = db.prepare('SELECT * FROM node_invites').all() as Record<string, unknown>[];
    expect(JSON.stringify(rows)).not.toContain(invite);
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `pnpm --filter @musterd/server exec vitest run src/store/nodes.invite.test.ts`
Expected: FAIL — cannot resolve `./nodes.js`.

- [ ] **Step 3: Add migration v49**

```ts
{
  // ADR 328 §2: enrollment is a one-time code, not a copied secret. Hashed like every other token
  // kind; single-use enforced by the guarded CAS in store/nodes.ts, not by this schema.
  version: 49,
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_invites (
        id          TEXT PRIMARY KEY,
        team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        code_hash   TEXT NOT NULL,
        label       TEXT,
        created_by  TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        consumed_at INTEGER,
        consumed_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_node_invites_team ON node_invites(team_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_node_invites_code ON node_invites(code_hash);
    `);
  },
},
```

- [ ] **Step 4: Implement the two functions**

```ts
// packages/server/src/store/nodes.ts
import { TOKEN_PREFIXES } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { ulid } from 'ulid';
import { hashToken, newSecret } from './members.js';

/**
 * The machine-credential store (ADR 328), increment 3a of ADR 325's federation build.
 *
 * Every guarded write here is the `requests.ts` shape — a `WHERE`-conditioned UPDATE whose
 * `changes === 0` is a refusal returned as a value, not thrown. That is a deliberate choice, not
 * the only one in the codebase: `lanes.ts` reads-compares-throws because a lane conflict must tell
 * a human what moved under them. ADR 328 asked the build to extract a shared helper on the premise
 * that this made a third and fourth instance of one pattern; checked at 5c1b35f0, there were two
 * instances in two shapes. Extraction declined — see the design doc. Revisit if 3b or 3c produces a
 * third site that genuinely matches this shape.
 */

/** ADR 328 §2: trust-on-first-use, bounded by a short window. */
export const NODE_INVITE_TTL_MS = 15 * 60 * 1000;

/** Mint a single-use enrollment code. The plaintext is returned once and never persisted. */
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
 * Consume an invite — the guarded CAS. `null` means refused: unknown code, already consumed, or
 * expired. Two daemons racing one invite must not both enroll (ADR 328 §2).
 */
export function consumeInvite(
  db: Database,
  teamId: string,
  code: string,
  nodeId: string,
  now: number = Date.now(),
): { id: string } | null {
  const res = db
    .prepare(
      `UPDATE node_invites SET consumed_at = ?, consumed_by = ?
       WHERE team_id = ? AND code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
    .run(now, nodeId, teamId, hashToken(code), now);
  if (res.changes === 0) return null;
  const row = db
    .prepare<[string], { id: string }>('SELECT id FROM node_invites WHERE code_hash = ?')
    .get(hashToken(code));
  return row ?? null;
}
```

- [ ] **Step 5: Run and verify green**

Run: `pnpm --filter @musterd/server exec vitest run src/store/nodes.invite.test.ts`
Expected: PASS, all three.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/migrations.ts packages/server/src/store/nodes.ts packages/server/src/store/nodes.invite.test.ts
git commit -m "feat(server): node_invites (v49) and the single-use invite CAS"
```

---

### Task 4: `bindNode` — adoption, and the two refusals

This task carries the ADR 331 debt. Both refusals below are the reason the lane exists.

**Files:**
- Modify: `packages/server/src/store/nodes.ts`
- Test: `packages/server/src/store/nodes.bind.test.ts` (create)

**Interfaces:**
- Consumes: `local_node` (Task 1), `node_invites` (Task 3).
- Produces: `bindNode(db, teamId, nodeId, label, credential, enrolledBy, now?) => { id: string } | null`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/src/store/nodes.bind.test.ts
import { describe, expect, it } from 'vitest';
import { bindNode } from './nodes.js';

describe('bindNode (ADR 331 §Decision 1 — presented, then vouched for)', () => {
  it('inserts a presented id that the hub has never seen', () => {
    const db = openTestDb();
    const team = seedTeam(db, 'revive');
    expect(bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick')).not.toBeNull();
  });

  it('refuses an id already bound to a DIFFERENT credential', () => {
    const db = openTestDb();
    const team = seedTeam(db, 'revive');
    bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');
    expect(bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_bbb', 'nick')).toBeNull();
  });

  it("refuses the hub's OWN local node id — a joiner must not bind the hub's origin", () => {
    const db = openTestDb();
    const team = seedTeam(db, 'revive');
    insertMessage(db, team.id, team.memberId, null, envelope('mint the local row'));
    const ours = db
      .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
      .get(team.id)!.node_id;

    expect(bindNode(db, team.id, ours, 'impostor', 'msnode_ccc', 'nick')).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `pnpm --filter @musterd/server exec vitest run src/store/nodes.bind.test.ts`
Expected: FAIL — `bindNode` is not exported.

- [ ] **Step 3: Implement**

```ts
// packages/server/src/store/nodes.ts — append
/**
 * Bind a credential to a presented node id (ADR 331 §Decision 1). The joiner allocated the id under
 * v47; the hub is what vouches for it, and this is where it can refuse.
 *
 * On the hub the id names a row that does not exist yet — the hub's own row for the team has a
 * different id — so adoption is an INSERT, not the UPDATE the word suggests. Two refusals, both
 * `null`:
 *   1. the id is already bound to a credential (rebinding is `rotateNode`, under admin authority);
 *   2. the id is THIS daemon's own local row. `credential_hash IS NULL` alone would admit it — a
 *      hub never enrolls with itself, so its own row is permanently unbound — and a joiner
 *      presenting it would bind its credential to the hub's origin identity and thereafter stamp
 *      events as the hub. The invite is admin-minted and single-use, so this is not reachable by an
 *      outsider; it is reachable by the invitee, which is exactly the party the CAS bounds.
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
         enrolled_by     = excluded.enrolled_by
       WHERE nodes.credential_hash IS NULL`,
    )
    .run(nodeId, teamId, label, hashToken(credential), now, enrolledBy);
  return res.changes === 0 ? null : { id: nodeId };
}
```

- [ ] **Step 4: Run and verify green**

Run: `pnpm --filter @musterd/server exec vitest run src/store/nodes.bind.test.ts`
Expected: PASS, all three.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store/nodes.ts packages/server/src/store/nodes.bind.test.ts
git commit -m "feat(server): bindNode — the ADR 331 refusal path, plus the hub's-own-row guard"
```

---

### Task 5: rotation, revocation, authentication, listing

**Files:**
- Modify: `packages/server/src/store/nodes.ts`
- Test: `packages/server/src/store/nodes.lifecycle.test.ts` (create)

**Interfaces:**
- Produces:
  - `rotateNode(db, teamId, nodeId, now?) => { credential: string } | null`
  - `revokeNode(db, teamId, nodeId, now?) => boolean`
  - `authenticateNode(db, teamId, token) => { id: string; label: string } | null`
  - `listNodes(db, teamId) => NodeSummary[]`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/src/store/nodes.lifecycle.test.ts
import { describe, expect, it } from 'vitest';
import { authenticateNode, bindNode, listNodes, revokeNode, rotateNode } from './nodes.js';

describe('node lifecycle (ADR 328 §5)', () => {
  it('rotation keeps the node id, so origin stamps survive', () => {
    const db = openTestDb();
    const team = seedTeam(db, 'revive');
    bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');

    const rotated = rotateNode(db, team.id, 'node-remote')!;
    expect(authenticateNode(db, team.id, 'msnode_aaa')).toBeNull();       // old is dead
    expect(authenticateNode(db, team.id, rotated.credential)?.id).toBe('node-remote'); // id stable
  });

  it('a revoked node authenticates nowhere', () => {
    const db = openTestDb();
    const team = seedTeam(db, 'revive');
    bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');

    expect(revokeNode(db, team.id, 'node-remote')).toBe(true);
    expect(authenticateNode(db, team.id, 'msnode_aaa')).toBeNull();
    expect(revokeNode(db, team.id, 'node-remote')).toBe(false);           // idempotent, not a lie
  });

  it('revocation keeps the history it attested', () => {
    const db = openTestDb();
    const team = seedTeam(db, 'revive');
    bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');
    db.prepare(
      `INSERT INTO messages (id, team_id, from_member, to_kind, act, body, ts, origin_node, origin_seq)
       VALUES ('m1', ?, ?, 'team', 'message', 'said under that credential', 1, 'node-remote', 1)`,
    ).run(team.id, team.memberId);

    revokeNode(db, team.id, 'node-remote');

    expect(
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE origin_node = ?').get('node-remote'),
    ).toEqual({ n: 1 });
  });

  it('never returns a credential hash in a listing', () => {
    const db = openTestDb();
    const team = seedTeam(db, 'revive');
    bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaaaaaaaaaaa', 'nick');
    const [only] = listNodes(db, team.id).filter((n) => n.id === 'node-remote');
    expect(only!.credential_prefix).toBe('msnode_');
    expect(JSON.stringify(only)).not.toContain(hashToken('msnode_aaaaaaaaaaaa'));
  });
});
```

- [ ] **Step 2: Run and watch fail**

Run: `pnpm --filter @musterd/server exec vitest run src/store/nodes.lifecycle.test.ts`
Expected: FAIL — none of the four are exported.

- [ ] **Step 3: Implement**

```ts
// packages/server/src/store/nodes.ts — append
import type { NodeSummary } from '@musterd/protocol';

/**
 * Rotation mints a fresh `msnode_` against the SAME node row (ADR 328 §5): the id — and therefore
 * every `origin_node` stamp already in the log — is stable across credential changes. This is the
 * one path that may overwrite a non-NULL hash, which is why it is separate from `bindNode`.
 * Refuses a revoked node: re-arming a retired credential should be an enrollment, not a rotation.
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
 * Revoke: the hub refuses push, pull, and claim from this node immediately. Events already ingested
 * STAY — the log is append-only and those events are attested history (ADR 328 §5). Lanes held by
 * that node's seats are not auto-released either; that stays a human act.
 * `false` means it was already revoked or unknown — idempotent without pretending it acted.
 */
export function revokeNode(
  db: Database,
  teamId: string,
  nodeId: string,
  now: number = Date.now(),
): boolean {
  return (
    db
      .prepare('UPDATE nodes SET revoked_at = ? WHERE id = ? AND team_id = ? AND revoked_at IS NULL')
      .run(now, nodeId, teamId).changes > 0
  );
}

/** Authenticate a presented `msnode_`. A revoked or unbound node authenticates nowhere. */
export function authenticateNode(
  db: Database,
  teamId: string,
  token: string,
): { id: string; label: string } | null {
  return (
    db
      .prepare<
        [string, string],
        { id: string; label: string }
      >('SELECT id, label FROM nodes WHERE team_id = ? AND credential_hash = ? AND revoked_at IS NULL')
      .get(teamId, hashToken(token)) ?? null
  );
}

/** Admin listing. The hash never leaves the store — only the prefix, enough to tell two apart. */
export function listNodes(db: Database, teamId: string): NodeSummary[] {
  const rows = db
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
       FROM nodes WHERE team_id = ? ORDER BY enrolled_at IS NULL, enrolled_at DESC`,
    )
    .all(teamId);
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    enrolled_at: r.enrolled_at,
    revoked_at: r.revoked_at,
    last_seen_at: r.last_seen_at,
    credential_prefix: r.credential_hash ? TOKEN_PREFIXES.node : null,
  }));
}
```

- [ ] **Step 4: Run and verify green**

Run: `pnpm --filter @musterd/server exec vitest run src/store/nodes.lifecycle.test.ts`
Expected: PASS, all four.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store/nodes.ts packages/server/src/store/nodes.lifecycle.test.ts
git commit -m "feat(server): node rotation, revocation, authentication, listing (ADR 328 §5)"
```

---

### Task 6: the hub-side routes

**Files:**
- Modify: `packages/server/src/transport/http.ts` (new team-scoped block; follow the `/seeds` and
  `/memory/search` handlers around `:2774` for shape)
- Test: `packages/server/src/transport/nodes-http.test.ts` (create — model it on
  `secured-bind.test.ts` and the sibling `*-http.test.ts` files)

**Interfaces:**
- Consumes: everything from Tasks 3–5, and the schemas from Task 2.
- Produces: `POST /teams/:slug/nodes/invite`, `POST /teams/:slug/nodes/join`,
  `POST /teams/:slug/nodes/:id/rotate`, `POST /teams/:slug/nodes/:id/revoke`,
  `GET /teams/:slug/nodes`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/server/src/transport/nodes-http.test.ts
describe('node enrollment routes (ADR 328 §3, §6)', () => {
  it('join is gated by the invite code alone, and mints once', async () => {
    const { url, db, team } = await startTestServer();
    const { invite } = mintInvite(db, team.id, 'laptop', 'nick');

    const res = await fetch(`${url}/teams/revive/nodes/join`, {
      method: 'POST',
      body: JSON.stringify({ code: invite, node_id: 'node-remote', label: 'laptop' }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).node_credential).toMatch(/^msnode_/);
  });

  it('a msnode_ cannot act as a seat (ADR 328 §3)', async () => {
    const { url, db, team } = await startTestServer();
    bindNode(db, team.id, 'node-remote', 'laptop', 'msnode_aaa', 'nick');

    const res = await fetch(`${url}/teams/revive/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer msnode_aaa' },
      body: JSON.stringify({ act: 'message', body: 'I am a machine pretending to be a teammate' }),
    });

    expect(res.status).toBe(401);
  });

  it('invite/rotate/revoke/list refuse a non-admin caller', async () => {
    const { url, db, team } = await startTestServer({ trustProxy: false, remote: true });
    for (const [method, path] of [
      ['POST', '/nodes/invite'],
      ['POST', '/nodes/node-remote/rotate'],
      ['POST', '/nodes/node-remote/revoke'],
      ['GET', '/nodes'],
    ] as const) {
      const res = await fetch(`${url}/teams/revive${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});
```

Read `secured-bind.test.ts` first for how a test server is started with a non-local peer — match its
helper rather than inventing one.

- [ ] **Step 2: Run and watch fail**

Run: `pnpm --filter @musterd/server exec vitest run src/transport/nodes-http.test.ts`
Expected: FAIL — all four routes 404.

- [ ] **Step 3: Implement the routes**

Add one block in the team-scoped section of `http.ts`, beside the `/seeds` handlers. Use the file's
existing `sendJson`, admin-gate, and body-parsing helpers — do not introduce new ones.

```ts
// ── Node enrollment (ADR 328), increment 3a of the ADR 325 federation build. These are NEW routes
// that `isLocalPeer` never guarded (§6): nothing localhost-only today becomes remote-reachable.
// `join` authenticates on the invite code alone — that IS the ceremony (§2, trust-on-first-use
// bounded by a short window) — and every other verb here is admin.
if (method === 'POST' && rest === '/nodes/invite') {
  const { team, member } = authTouch(ctx, slug, req);
  assertAdmin(member);
  const body = await readJson(req);
  const minted = mintInvite(ctx.db, team.id, String(body.label ?? ''), member.name);
  appendAudit(ctx, team.id, 'node.invited', member.name, { label: body.label });
  return sendJson(res, 200, NodeInviteMintSchema.parse(minted));
}

if (method === 'POST' && rest === '/nodes/join') {
  const team = requireTeam(ctx.db, slug);
  const body = NodeJoinRequestSchema.parse(await readJson(req));
  const credential = newSecret(TOKEN_PREFIXES.node);

  const bound = ctx.db.transaction(() => {
    if (!consumeInvite(ctx.db, team.id, body.code, body.node_id)) return null;
    return bindNode(ctx.db, team.id, body.node_id, body.label, credential, 'invite');
  })();

  if (!bound) {
    return sendJson(res, 409, {
      error: 'enrollment refused',
      detail:
        'the invite is unknown, expired, or already used — or that node id is already bound to a ' +
        'different credential',
    });
  }
  appendAudit(ctx, team.id, 'node.enrolled', body.label, { node_id: body.node_id });
  return sendJson(
    res,
    200,
    NodeJoinResponseSchema.parse({ node_credential: credential, node_id: bound.id, team: slug }),
  );
}
```

The `db.transaction` wrapping consume-then-bind is load-bearing: a consumed invite whose bind then
fails would burn the admin's invite and enroll nobody.

Add `rotate`, `revoke`, and the `GET` listing in the same block, each `assertAdmin`, each with its
audited verb (`node.rotated`, `node.revoked`). Match the regex-match style the `/seeds/:id/...`
routes use at `http.ts:2813` for the `:id` segment.

- [ ] **Step 4: Run and verify green**

Run: `pnpm --filter @musterd/server exec vitest run src/transport/nodes-http.test.ts`
Expected: PASS, all three.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/transport/http.ts packages/server/src/transport/nodes-http.test.ts
git commit -m "feat(server): node enrollment routes — invite, join, rotate, revoke, list"
```

---

### Task 7: `node.json` and the local `/node/enroll` route

**Files:**
- Create: `packages/server/src/node/state.ts`
- Modify: `packages/server/src/transport/http.ts` (the non-team-scoped, `isLocalPeer`-gated section)
- Test: `packages/server/src/node/state.test.ts` (create)

**Interfaces:**
- Produces:
  - `nodeStatePath(env?) => string` — via `machineStatePath('MUSTERD_NODE_STATE', 'node.json')`
  - `readNodeState(env?) => NodeState`
  - `saveNodeEnrollment(entry, env?) => void` — writes mode 0600
- Consumes: `NodeEnrollRequestSchema` (Task 2), the hub routes (Task 6).

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/node/state.test.ts
import { statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readNodeState, saveNodeEnrollment } from './state.js';

describe('node.json (ADR 328 §2 — machine-local, never a workspace)', () => {
  it('writes 0600 and round-trips', () => {
    // MUSTERD_NODE_STATE is pinned by the ADR 190 global setup; point it at a tmp file here.
    saveNodeEnrollment({
      team: 'revive',
      hub_url: 'https://hub.example:7777',
      node_id: '01M',
      credential: 'msnode_aaa',
      enrolled_at: 1,
    });

    expect(readNodeState().nodes['revive']?.credential).toBe('msnode_aaa');
    expect(statSync(nodeStatePath()).mode & 0o777).toBe(0o600);
  });
});
```

Register `MUSTERD_NODE_STATE` in `tests/setup/isolate-machine-state.ts` alongside the existing
overrides — without it `machineStatePath` throws under vitest, which is the ADR 190 guard working.

- [ ] **Step 2: Run and watch fail**

Run: `pnpm --filter @musterd/server exec vitest run src/node/state.test.ts`
Expected: FAIL — cannot resolve `./state.js`.

- [ ] **Step 3: Implement the state file**

```ts
// packages/server/src/node/state.ts
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { machineStatePath } from '../machinePaths.js';

/**
 * The machine's node credentials (ADR 328 §2), one entry per enrolled team — machine-local, mode
 * 0600, never a workspace and never the repo. The DAEMON owns this file: `musterd node join` asks
 * its own daemon to enroll, so the process that holds the node row also holds the credential and
 * writes it. A CLI writing it behind the daemon is the drift ADR 131's three-stores table warns of.
 */
const NodeEnrollmentSchema = z.object({
  hub_url: z.string(),
  node_id: z.string(),
  credential: z.string(),
  enrolled_at: z.number().int(),
});
const NodeStateSchema = z.object({ nodes: z.record(NodeEnrollmentSchema).default({}) });
export type NodeState = z.infer<typeof NodeStateSchema>;

export function nodeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return machineStatePath('MUSTERD_NODE_STATE', 'node.json', env);
}

export function readNodeState(env: NodeJS.ProcessEnv = process.env): NodeState {
  try {
    return NodeStateSchema.parse(JSON.parse(readFileSync(nodeStatePath(env), 'utf8')));
  } catch {
    return { nodes: {} };
  }
}

export function saveNodeEnrollment(
  entry: { team: string } & z.infer<typeof NodeEnrollmentSchema>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const { team, ...rest } = entry;
  const state = readNodeState(env);
  state.nodes[team] = rest;
  const path = nodeStatePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync's mode is ignored when the file already exists
}
```

- [ ] **Step 4: Add the local enroll route**

In the `isLocalPeer`-gated, non-team section of `http.ts`:

```ts
// `POST /node/enroll` (ADR 328 §2) — the local half of enrollment. The CLI does not talk to the hub
// itself: the daemon holds the v47 node row whose id must be presented, and it is what will hold
// the credential, so it makes the call and writes node.json. localhost-only, like every other
// operator verb on this section.
if (method === 'POST' && rest === '/node/enroll') {
  if (!isLocalPeer(req.socket.remoteAddress, ctx.config.trustProxy)) {
    return sendJson(res, 403, { error: 'node enrollment is localhost-only' });
  }
  const body = NodeEnrollRequestSchema.parse(await readJson(req));
  const team = requireTeam(ctx.db, body.team);
  const local = ctx.db
    .prepare<[string], { node_id: string }>('SELECT node_id FROM local_node WHERE team_id = ?')
    .get(team.id);
  if (!local) return sendJson(res, 409, { error: 'this daemon has no node row for that team yet' });

  const hub = await fetch(new URL(`/teams/${body.team}/nodes/join`, body.hub_url), {
    method: 'POST',
    body: JSON.stringify({ code: body.code, node_id: local.node_id, label: hostname() }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!hub.ok) return sendJson(res, hub.status, await hub.json());

  const minted = NodeJoinResponseSchema.parse(await hub.json());
  saveNodeEnrollment({
    team: body.team,
    hub_url: body.hub_url,
    node_id: minted.node_id,
    credential: minted.node_credential,
    enrolled_at: Date.now(),
  });
  return sendJson(res, 200, { node_id: minted.node_id, team: body.team });
}
```

Note the response deliberately omits the credential: it went to disk, and the CLI has no use for it.

- [ ] **Step 5: Run and verify green**

Run: `pnpm --filter @musterd/server exec vitest run src/node/state.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/node/state.ts packages/server/src/node/state.test.ts packages/server/src/transport/http.ts tests/setup/isolate-machine-state.ts
git commit -m "feat(server): node.json machine state and the localhost /node/enroll route"
```

---

### Task 8: the `musterd node` CLI

**Files:**
- Create: `packages/cli/src/commands/node.ts`
- Modify: `packages/cli/src/bin.ts` (import at the top block, `case 'node':` in the dispatch ~`:222`)
- Modify: `packages/cli/src/help.ts` (one line, matching its neighbours)
- Test: `packages/cli/src/commands/node.test.ts` (create)

**Interfaces:**
- Consumes: the routes from Tasks 6 and 7.
- Produces: `nodeCommand(rest: Parsed): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/commands/node.test.ts
describe('musterd node', () => {
  it('join posts to the LOCAL daemon, never the hub directly', async () => {
    const calls: string[] = [];
    const stop = await fakeDaemon((path) => calls.push(path));

    await nodeCommand(parseArgs(['join', 'https://hub.example:7777', 'msinv_abc']));

    expect(calls).toEqual(['/node/enroll']);
  });

  it('prints a minted credential exactly once and masks it in list', async () => {
    // rotate prints the plaintext; list must show only the prefix
  });
});
```

Model `fakeDaemon` on whatever the sibling command tests use (`lane.test.ts`, `goal.test.ts`) — read
one first and match it.

- [ ] **Step 2: Run and watch fail**

Run: `pnpm --filter @musterd/cli exec vitest run src/commands/node.test.ts`
Expected: FAIL — cannot resolve `./node.js`.

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/commands/node.ts
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { heading, success } from '../render/ui.js';
import { resolve } from './helpers.js';

/**
 * `musterd node <invite|join|rotate|revoke|list>` — the machine credential (ADR 328), increment 3a
 * of the ADR 325 federation build.
 *
 * `join` does NOT call the hub. It asks THIS machine's daemon to enroll itself: the daemon holds
 * the v47 node row whose id gets presented and is what will hold the credential, so letting the CLI
 * write that state behind it would put two processes on one file.
 */
const USAGE =
  'usage:\n' +
  '  musterd node invite [--label "<what machine>"]\n' +
  '  musterd node join <hub-url> <msinv_code>\n' +
  '  musterd node rotate <node-id>\n' +
  '  musterd node revoke <node-id>\n' +
  '  musterd node list [--json]';
```

Implement the five subcommands against the routes, following `goal.ts` for structure, `theme`/`ui`
for rendering, and `CliError` for a bad invocation. Secrets print once with the same "copy it now,
it will not be shown again" framing the `agent-key rotate` path uses.

- [ ] **Step 4: Wire the dispatch**

```ts
// packages/cli/src/bin.ts — with the other imports
import { nodeCommand } from './commands/node.js';
// …and in the switch, beside `case 'next':`
    case 'node':
      return nodeCommand(rest);
```

- [ ] **Step 5: Run and verify green**

Run: `pnpm --filter @musterd/cli exec vitest run src/commands/node.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/node.ts packages/cli/src/commands/node.test.ts packages/cli/src/bin.ts packages/cli/src/help.ts
git commit -m "feat(cli): musterd node invite/join/rotate/revoke/list"
```

---

### Task 9: migration replay, docs, and the two-daemon acceptance run

**Files:**
- Test: `packages/server/src/db/migrations.test.ts` (extend the existing rewind-and-replay case)
- Modify: `docs/design/deployment-topology.md` §8
- Create: `docs/wiki/node-enrollment.md`

- [ ] **Step 1: Extend the migration replay test**

Add v48 and v49 to whatever list the existing rewind-and-replay case iterates; assert that replaying
them over an already-migrated DB leaves `local_node` with exactly one row per team and does not
duplicate invites.

Run: `pnpm --filter @musterd/server exec vitest run src/db/migrations.test.ts`
Expected: PASS.

- [ ] **Step 2: Run the full gates**

```bash
pnpm install && pnpm --filter "@musterd/*" build && pnpm typecheck && pnpm lint && pnpm test
```

Expected: typecheck 0, lint 0, server and cli suites green. Fix anything red before continuing —
the two-daemon run is not a substitute for the suite.

- [ ] **Step 3: The two-daemon acceptance run**

This is the lane's acceptance criterion and what settles **ADR 331's Experiment**.

```bash
# hub, on the real DB's port; joiner, on a scratch DB and a second port
MUSTERD_DB=/tmp/joiner.db MUSTERD_PORT=4850 \
  MUSTERD_NODE_STATE=/tmp/joiner-node.json musterd serve &
```

Then, in order, recording actual output for the PR body:
1. `musterd node invite --label "joiner laptop"` on the hub → an `msinv_`
2. `musterd node join http://127.0.0.1:4849 <code>` against the joiner daemon
3. `musterd node list` on the hub — two rows, credential masked
4. `musterd node rotate <id>`, then confirm the old credential is refused
5. `musterd node revoke <id>`, then confirm push/pull/claim refuse
6. Confirm the joiner's own messages still stamp the joiner's `origin_node` — Task 1's fix, in the
   only setting that can actually exercise it

- [ ] **Step 4: Record the Experiment's verdict**

ADR 331 predicted adoption-at-enrollment would be "write two fields onto an existing row" and named
this increment as where the evidence arrives. Task 4 already shows it is an `INSERT` on the hub, not
an update. Write the verdict either way:

- If the run confirms it was otherwise straightforward — say so in the PR body and add a dated note
  to ADR 331 §Consequences recording the INSERT-vs-UPDATE correction. That note goes in
  **Consequences, never Decision** (`change-adr:check` enforces this; it is the gate that caught the
  same mistake at increment 2).
- If adoption needed real special-casing, 331's Experiment says holding ADR 328 §7 was the better
  call. Write that up honestly rather than burying it.

- [ ] **Step 5: Documentation**

`docs/design/deployment-topology.md` §8 — ADR 325 says its "what this is explicitly NOT" freeze
"unfreezes into a federation section when the build starts". It has. Replace the frozen paragraph
with what is now true: a hub, machine daemons, and enrollment; and what is still not (sync, 3b).

`docs/wiki/node-enrollment.md` — the ceremony as a fact the team learned, with dated claims and
falsifiers per `docs/wiki/README.md`. Write it AFTER the two-daemon run, from what actually
happened, not from this plan.

- [ ] **Step 6: Commit and open the PR**

```bash
git add -A
git commit -m "docs: federation section in deployment-topology §8, node enrollment wiki page"
git push -u origin stanley/federation-node-credential
gh pr create --title "Federation increment 3a: the node credential" --body "…falsifiers, the two-daemon transcript, and the ADR 331 Experiment verdict…"
```

Then `lane_submit` on `01M12B79XGFSGAFQC0966F437V` **after** the merge, per the team's rhythm — and
request a security-voice review, since this ships a machine credential.

---

## Self-review notes

**Spec coverage.** Decision 1 (CLI → daemon → hub) → Tasks 7, 8. Decision 2 (bind CAS + the
hub's-own-row hole) → Task 4. Decision 3 (`local_node`) → Task 1. Decision 4 (helper declined) →
recorded in `store/nodes.ts`'s module comment, Task 3. Data → Tasks 1, 3, 7. Surface → Tasks 2, 5, 6,
8. All ten spec test cases map: 1→T3, 2→T3, 3→T4, 3b→T4, 3c→T1, 4→T5, 5→T5, 6→T5, 7→T6, 8→T6, 9→T7,
10→T9.

**Known softness, stated rather than hidden.** Tasks 6 and 8 name existing helpers (`authTouch`,
`assertAdmin`, `readJson`, `fakeDaemon`) by their expected role rather than their verified
signatures. Read the neighbouring handler or sibling test first and match what is actually there;
if a helper does not exist under that name, that is a plan gap to fix in place, not a licence to
invent a parallel one.
