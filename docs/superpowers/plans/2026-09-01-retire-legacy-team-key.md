# Legacy Team Key Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Write work must remain in the claimed musterd seat; do not delegate edits,
> builds, claims, or commits to subagents.

**Goal:** Let every Team migrate active agent Workspaces and residency hosts to observed scoped
bootstrap credentials, then transactionally disable its legacy Team-wide key.

**Architecture:** Extend the v52 bootstrap-credential store with migration provenance and
successful-use timestamps. A seat proves a self-migration with both its legacy `mskey_` and current
`msac_`; hosts keep the existing administrator-minted path. An admin-only readiness/cutover route
derives required targets from server-owned Member and residency state and revokes legacy authority
atomically.

**Tech Stack:** TypeScript, Node.js HTTP, better-sqlite3, Zod, Vitest, pnpm.

## Global Constraints

- Claim an exclusive musterd Lane before implementation and work only in that seat.
- Before writing the retirement ADR, run `pnpm adr:next`, immediately push the branch and open a
  draft PR so the allocated number is visible to other seats, then create the ADR.
- Do not change an `@musterd/protocol` schema without the retirement ADR.
- Parse every new HTTP body with Zod at the boundary.
- Never log or audit plaintext credentials, hashes, local paths, Workspace labels, or binding
  contents.
- Add no runtime dependency.
- Preserve unrelated binding fields and mode `0600` during Workspace migration.
- A migration retry may revoke only a migration-created successor with no recorded scoped use.
- Readiness requires observed scoped authentication, not credential minting.
- `--force` bypasses readiness only; `--yes` bypasses confirmation only.
- Cutover revocation, `teams.agent_key_hash` clearing, and audit insertion are one transaction.
- Keep compatibility lookup code until every extant Team has successfully cut over.
- Use Team, Member, Presence, Surface, and Act with their glossary meanings.
- Each implementation task follows red-green-refactor and ends in a reviewable commit carrying the
  seat trailer `Co-authored-by: big-body <big-body@revive.musterd>`.

---

### Task 1: Publish the retirement ADR and persistence contract

**Files:**
- Create: the path printed by `pnpm adr:next -- --slug retire-legacy-team-bootstrap-key`
- Modify: `docs/decisions/344-scoped-rotatable-agent-bootstrap-credentials.md`
- Modify: `packages/server/src/db/migrations.ts`
- Modify: `packages/server/src/db/db.test.ts`
- Modify: `packages/server/src/store/teams.ts`

**Interfaces:**
- Produces: `BootstrapCredential.migration_target_member_id: string | null`
- Produces: `BootstrapCredential.first_used_at: number | null`
- Produces: `TeamRow.bootstrap_cutover_at: number | null`
- Consumes: existing v52 `agent_bootstrap_credentials` and `teams.agent_key_hash`

- [ ] **Step 1: Claim the Lane and publish the ADR number**

Run:

```bash
musterd lane claim 01M1FPJ6JYRRWNF817AYFX94K1
pnpm adr:next -- --slug retire-legacy-team-bootstrap-key
git push -u origin HEAD
gh pr create --draft --title "feat(security): retire legacy Team bootstrap key" \
  --body "Draft implementation of the approved legacy Team key retirement design."
```

Expected: the Lane is owned by this seat, `adr:next` prints an unclaimed ADR path, and the draft PR
URL is visible before the ADR file is written. Set `ADR_PATH` to the exact path printed by
`adr:next`, then export its numeric prefix once for later commit footers:

```bash
export RETIREMENT_ADR="$(basename "$ADR_PATH" | cut -d- -f1 | awk '{print int($1)}')"
```

- [ ] **Step 2: Write the ADR before changing the schema**

Create the printed ADR path with the standard Context, Problem, Decision, Consequences, and
Observability & Evaluation sections. Its Decision must pin these facts:

```markdown
- A seat migration is authorized by an active legacy `mskey_` plus an active same-Team agent
  `msac_`; no client-declared seat is authorization.
- Migration successors are `claim_seat` credentials linked to the target Member.
- First successful scoped authentication is durable readiness evidence.
- Required targets are active held agent Members and active residency host labels.
- Cutover is per Team, administrator-only, readiness-gated unless forced, and transactional.
- Compatibility code remains until every extant Team has cut over.
```

Amend only ADR 344's Consequences with a dated note linking the new ADR; do not alter ADR 344's
frozen Decision.

- [ ] **Step 3: Write the failing migration test**

In `packages/server/src/db/db.test.ts`, add a migration assertion equivalent to:

```typescript
expect(columns(db, 'agent_bootstrap_credentials')).toEqual(
  expect.arrayContaining(['migration_target_member_id', 'first_used_at']),
);
expect(columns(db, 'teams')).toContain('bootstrap_cutover_at');
```

Run:

```bash
pnpm --filter @musterd/server test -- db.test.ts
```

Expected: FAIL because the three columns do not exist.

- [ ] **Step 4: Add the next database migration**

Append the next migration after v53 in `packages/server/src/db/migrations.ts`:

```typescript
{
  version: 54,
  up: (db) => {
    db.exec(`
      ALTER TABLE agent_bootstrap_credentials
        ADD COLUMN migration_target_member_id TEXT REFERENCES members(id);
      ALTER TABLE agent_bootstrap_credentials
        ADD COLUMN first_used_at INTEGER;
      ALTER TABLE teams ADD COLUMN bootstrap_cutover_at INTEGER;
      CREATE INDEX idx_bootstrap_migration_target
        ON agent_bootstrap_credentials(team_id, migration_target_member_id, state, first_used_at);
    `);
  },
},
```

Update `BootstrapCredential` and `TeamRow` with nullable fields matching those columns. Do not
backfill `first_used_at`: historical minting is not evidence of successful scoped use.

- [ ] **Step 5: Run the focused migration tests**

Run:

```bash
pnpm --filter @musterd/server test -- db.test.ts
```

Expected: PASS, including clean-database and v53-to-v54 migration cases.

- [ ] **Step 6: Commit the persistence contract**

```bash
git add docs/decisions packages/server/src/db packages/server/src/store/teams.ts
git commit -m "feat(server): persist legacy key retirement evidence

Refs ADR-${RETIREMENT_ADR}

Co-authored-by: big-body <big-body@revive.musterd>"
```

Expected: one commit containing the ADR, ADR 344 consequence note, schema, type changes, and tests.

---

### Task 2: Implement seat migration and safe retry in the store

**Files:**
- Modify: `packages/server/src/store/teams.ts`
- Modify: `packages/server/src/store/store.test.ts`
- Modify: `packages/server/src/store/audit.ts`

**Interfaces:**
- Consumes: `authByAgentSeatCredential(db, token)` from `store/members.ts`
- Produces:

```typescript
export type BootstrapMigrationResult = {
  credential: BootstrapCredential;
  agent_key: string;
  replaced_credential_id: string | null;
};

export function migrateLegacyBootstrapCredential(
  db: Database,
  input: { legacyKey: string; seatCredential: string; now?: number },
): BootstrapMigrationResult;
```

- Produces:

```typescript
export function recordBootstrapCredentialUse(
  db: Database,
  credentialId: string,
  now?: number,
): void;
```

- [ ] **Step 1: Write failing store tests for authorization**

In `packages/server/src/store/store.test.ts`, add cases proving:

```typescript
const migrated = migrateLegacyBootstrapCredential(db, {
  legacyKey,
  seatCredential: adaSeatCredential,
});
expect(migrated.credential.use_kind).toBe('claim_seat');
expect(migrated.credential.target).toBe('ada');
expect(migrated.credential.migration_target_member_id).toBe(ada.id);
expect(migrated.agent_key).toMatch(/^mskey_/);
```

Also assert that a cross-Team seat credential, human credential, disabled/banned Member, archived or
departed Member, revoked/expired legacy key, and non-legacy bootstrap key throw without inserting a
successor.

Run:

```bash
pnpm --filter @musterd/server test -- store.test.ts -t "legacy bootstrap migration"
```

Expected: FAIL because `migrateLegacyBootstrapCredential` is not exported.

- [ ] **Step 2: Implement migration as one store transaction**

In `teams.ts`, resolve the legacy row by credential hash without a caller-supplied Team, resolve the
seat credential with `authByAgentSeatCredential`, compare server-owned Team IDs, and apply the
existing Member lifecycle helpers. Mint this successor:

```typescript
{
  useKind: 'claim_seat',
  target: member.name,
  label: 'legacy-migration',
  createdBy: member.name,
}
```

Set `migration_target_member_id` in the same transaction. Do not create a request, grant, Presence,
or occupation.

- [ ] **Step 3: Write failing retry tests**

Add tests that call migration twice. Before any scoped use:

```typescript
expect(second.replaced_credential_id).toBe(first.credential.id);
expect(findById(db, first.credential.id)?.state).toBe('revoked');
expect(second.credential.id).not.toBe(first.credential.id);
```

After `recordBootstrapCredentialUse(db, first.credential.id)`:

```typescript
expect(() =>
  migrateLegacyBootstrapCredential(db, { legacyKey, seatCredential }),
).toThrow(/already migrated/);
expect(findById(db, first.credential.id)?.state).toBe('active');
```

Expected before implementation: the retry assertions fail.

- [ ] **Step 4: Implement unused-successor cleanup and use evidence**

Within the migration transaction, revoke only rows matching all of:

```sql
team_id = ?
AND migration_target_member_id = ?
AND state = 'active'
AND first_used_at IS NULL
```

Set `first_used_at = COALESCE(first_used_at, ?)` in
`recordBootstrapCredentialUse`. Preserve the first timestamp on subsequent uses.

- [ ] **Step 5: Add audit verbs and redaction assertions**

Extend `AuditAction` with:

```typescript
| 'bootstrap_credential.migrated'
| 'bootstrap_credential.migration_replaced'
| 'bootstrap_credential.cutover'
```

Store helpers return IDs; transport writes audit rows whose details contain only predecessor,
successor, target Member, result, and force/readiness metadata. Add an assertion that serialized
audit detail contains neither input token, token hash, nor filesystem path.

- [ ] **Step 6: Run and commit the store slice**

Run:

```bash
pnpm --filter @musterd/server test -- store.test.ts
```

Expected: PASS.

```bash
git add packages/server/src/store
git commit -m "feat(server): exchange legacy keys for seat credentials

Refs ADR-${RETIREMENT_ADR}

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 3: Add authenticated migration transport and record scoped use

**Files:**
- Modify: `packages/protocol/src/credentials.ts`
- Modify: `packages/protocol/src/credentials.test.ts`
- Modify: `packages/server/src/transport/http.ts`
- Modify: `packages/server/src/transport/ws.ts`
- Modify: `packages/server/src/transport/claim-http.test.ts`
- Modify: `packages/server/src/transport/integration.test.ts`
- Modify: `packages/server/src/transport/residency-http.test.ts`

**Interfaces:**
- Consumes: `migrateLegacyBootstrapCredential` and `recordBootstrapCredentialUse`
- Produces: `POST /agent-bootstrap-migrations`
- Produces protocol-boundary schema:

```typescript
export const BootstrapMigrationRequestSchema = z
  .object({
    legacy_key: z.string().startsWith('mskey_'),
    seat_credential: z.string().startsWith('msac_'),
  })
  .strict();
```

- Response:

```typescript
{
  credential: BootstrapCredentialSummary;
  agent_key: string;
}
```

- [ ] **Step 1: Write the failing protocol and endpoint tests**

In `credentials.test.ts`, reject missing, wrong-prefix, and unknown request fields. In
`claim-http.test.ts`, post valid legacy and seat credentials:

```typescript
const response = await post(base, '/agent-bootstrap-migrations', {
  legacy_key: legacyKey,
  seat_credential: adaSeatCredential,
});
expect(response.status).toBe(201);
expect(response.body.agent_key).toMatch(/^mskey_/);
expect(response.body.credential).toMatchObject({ use: 'claim_seat', target: 'ada' });
expect(listPresences(db, team.id)).toHaveLength(0);
```

Add refusal cases for every invalid store input and assert no request, grant, or Presence appears.

Run:

```bash
pnpm --filter @musterd/protocol test -- credentials.test.ts
pnpm --filter @musterd/server test -- claim-http.test.ts -t "legacy bootstrap migration"
```

Expected: FAIL with route not found.

- [ ] **Step 2: Implement the protocol schema and migration route**

Place the route outside `/teams/:slug` because Team and seat are credential-derived. Parse with the
exported protocol schema, call the store transaction, append redacted migration/replacement audit
rows, and return the plaintext once. Map invalid credentials to the existing authentication refusal
vocabulary.

- [ ] **Step 3: Replace direct use audits with durable evidence writes**

On successful scoped claim in both `http.ts` and `ws.ts`, call:

```typescript
recordBootstrapCredentialUse(ctx.db, bootstrapCredential.id);
```

before appending `bootstrap_credential.used`. In `authAgentKeyOnly`, do the same for successful host
authentication. Never mark a legacy credential as scoped-use evidence.

- [ ] **Step 4: Prove use evidence across HTTP, WS, and residency**

Extend the three transport test files to assert:

```typescript
expect(findBootstrapCredentialById(db, credential.id)?.first_used_at).not.toBeNull();
```

Cover HTTP seat claim, WS seat claim, and each host-authenticated wake route family. Assert minting
without authentication leaves `first_used_at` null.

- [ ] **Step 5: Run and commit transport migration**

Run:

```bash
pnpm --filter @musterd/server test -- claim-http.test.ts integration.test.ts residency-http.test.ts
pnpm --filter @musterd/protocol test -- credentials.test.ts
```

Expected: PASS.

```bash
git add packages/protocol/src packages/server/src/transport
git commit -m "feat(server): expose legacy bootstrap migration

Refs ADR-${RETIREMENT_ADR}

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 4: Implement readiness and transactional Team cutover

**Files:**
- Modify: `packages/protocol/src/credentials.ts`
- Modify: `packages/protocol/src/credentials.test.ts`
- Modify: `packages/server/src/store/teams.ts`
- Modify: `packages/server/src/store/store.test.ts`
- Modify: `packages/server/src/transport/http.ts`
- Modify: `packages/server/src/transport/claim-http.test.ts`
- Modify: `packages/server/src/transport/residency-http.test.ts`

**Interfaces:**
- Produces:

```typescript
export type BootstrapCutoverReadiness = {
  already_cut_over: boolean;
  unmet_seats: Array<{ member_id: string; name: string }>;
  unmet_hosts: string[];
};

export function bootstrapCutoverReadiness(
  db: Database,
  teamId: string,
): BootstrapCutoverReadiness;

export function cutoverLegacyBootstrap(
  db: Database,
  input: { teamId: string; actor: string; force: boolean; now?: number },
): BootstrapCutoverReadiness;
```

- Produces: `GET /teams/:slug/agent-bootstrap-cutover`
- Produces: `POST /teams/:slug/agent-bootstrap-cutover` parsed through:

```typescript
export const BootstrapCutoverRequestSchema = z
  .object({ force: z.boolean().default(false) })
  .strict();
```

- [ ] **Step 1: Write failing readiness tests**

Seed active held agent Members, an unheld Member, departed/disabled/banned Members, active residency
rows with duplicate host labels, and minted scoped credentials. Assert:

```typescript
expect(bootstrapCutoverReadiness(db, team.id)).toEqual({
  already_cut_over: false,
  unmet_seats: [{ member_id: ada.id, name: 'ada' }],
  unmet_hosts: ['mac-studio'],
});
```

Mark the seat and host credentials used and expect both unmet arrays to become empty. Minted-only
credentials must remain unmet.

- [ ] **Step 2: Implement readiness from server-owned state**

Query active agent Members with `bound_at IS NOT NULL`, excluding departed, archived, disabled, and
banned rows. Query distinct active residency host labels. Satisfy each target only with an active,
unexpired matching scoped credential whose `first_used_at IS NOT NULL`. Sort seat names and host
labels for deterministic CLI output.

- [ ] **Step 3: Write failing transactional cutover tests**

Test complete, forced-incomplete, rollback, and repeated cutovers:

```typescript
expect(() => cutoverLegacyBootstrap(db, { teamId, actor: 'admin', force: false }))
  .toThrow(/not ready/);
const result = cutoverLegacyBootstrap(db, { teamId, actor: 'admin', force: true });
expect(result.unmet_seats).toContainEqual({ member_id: ada.id, name: 'ada' });
expect(getAgentKeyHash(db, team.id)).toBeNull();
expect(activeLegacyCredentials(db, team.id)).toHaveLength(0);
expect(requireTeam(db, team.slug).bootstrap_cutover_at).not.toBeNull();
```

Inject an audit failure and assert the hash, legacy rows, and cutover timestamp all roll back.

- [ ] **Step 4: Implement cutover in one transaction**

Return successfully without writes when `bootstrap_cutover_at` is already set. Otherwise derive
readiness inside the transaction, refuse unless complete or forced, revoke all active legacy rows,
clear `teams.agent_key_hash`, set `bootstrap_cutover_at`, and append
`bootstrap_credential.cutover` with actor, force flag, and unmet IDs/labels.

- [ ] **Step 5: Add the protocol schema and admin-only readiness/cutover routes**

Test the cutover request schema's default, valid force, and unknown-field refusal in
`credentials.test.ts`. Both routes call `authAdmin`. GET returns readiness. POST parses with the
protocol schema, performs cutover, and returns:

```typescript
{ ok: true, already_cut_over: boolean, forced: boolean, readiness }
```

Test unauthenticated, non-admin, complete, forced, and idempotent calls. Verify the old key fails
claim and every residency route after cutover, before creating requests, Presences, or host work.
The refusal hint must direct the operator to:

```text
musterd team bootstrap mint --seat <name>
musterd team bootstrap mint --role <role>
musterd team bootstrap mint --host <label>
```

- [ ] **Step 6: Run and commit cutover**

Run:

```bash
pnpm --filter @musterd/server test -- store.test.ts claim-http.test.ts residency-http.test.ts
pnpm --filter @musterd/protocol test -- credentials.test.ts
```

Expected: PASS.

```bash
git add packages/protocol/src packages/server/src
git commit -m "feat(server): cut over Teams from legacy bootstrap authority

Refs ADR-${RETIREMENT_ADR}

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 5: Add `wire --migrate-bootstrap` with atomic publication recovery

**Files:**
- Modify: `packages/cli/src/client.ts`
- Modify: `packages/cli/src/commands/wire.ts`
- Modify: `packages/cli/src/commands/wire.test.ts`
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/config.test.ts`
- Modify: `packages/cli/src/help/catalog.ts`

**Interfaces:**
- Consumes: `POST /agent-bootstrap-migrations`
- Produces:

```typescript
HttpClient.migrateBootstrapCredential(body: {
  legacy_key: string;
  seat_credential: string;
}): Promise<{ credential: BootstrapCredentialSummary; agent_key: string }>;
```

- Produces: `wireCommand` branch for `flags['migrate-bootstrap'] === true`

- [ ] **Step 1: Write failing CLI migration tests**

In `wire.test.ts`, create a binding with Team, seat claim, legacy `agent_key`, `seat_credential`,
model, session, and unrelated fields. Stub the client response and assert:

```typescript
expect(saved).toEqual({ ...original, agent_key: successor });
expect(statSync(bindingPath).mode & 0o777).toBe(0o600);
```

Add refusals for missing binding, unresolved/non-seat claim, missing `agent_key`, and missing
`seat_credential`. Run:

```bash
pnpm --filter @musterd/cli test -- wire.test.ts -t "migrate bootstrap"
```

Expected: FAIL because the flag is not implemented.

- [ ] **Step 2: Implement the client and migration branch**

Read the current Workspace binding with `findBinding`, derive the seat with `bindingSeat`, validate
all three local prerequisites, call `migrateBootstrapCredential`, then publish:

```typescript
saveBinding(workspace, { ...binding, agent_key: migrated.agent_key });
```

JSON output contains only credential metadata and `migrated: true`; human output states that the
credential was shown to the binding once, not printed to stdout.

- [ ] **Step 3: Make atomic publication failure injectable**

Extend `saveBinding` options with a test-only filesystem operation seam or factor the tmp+rename
sequence into a focused internal helper. Add a test that makes rename fail and asserts the original
legacy key and file mode remain intact.

The user-facing error must say:

```text
could not publish the scoped credential; the legacy key remains in this binding.
Rerun `musterd wire --migrate-bootstrap` to replace the unused successor safely.
```

Do not include either credential or the binding path.

- [ ] **Step 4: Add exact help copy**

In `help/catalog.ts`, document:

```text
--migrate-bootstrap  replace this Workspace's legacy Team key with a seat-scoped credential
```

State that the operation requires the existing seat credential, preserves active Presence, and is
safe to retry after a local write failure.

- [ ] **Step 5: Run and commit Workspace migration**

Run:

```bash
pnpm --filter @musterd/cli test -- wire.test.ts config.test.ts
```

Expected: PASS.

```bash
git add packages/cli/src
git commit -m "feat(cli): migrate Workspace bootstrap credentials

Refs ADR-${RETIREMENT_ADR}

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 6: Add the administrator readiness and cutover CLI

**Files:**
- Modify: `packages/cli/src/client.ts`
- Modify: `packages/cli/src/commands/team.ts`
- Modify: `packages/cli/src/commands/team.test.ts`
- Modify: `packages/cli/src/help/catalog.ts`

**Interfaces:**
- Consumes: GET/POST `/teams/:slug/agent-bootstrap-cutover`
- Produces:

```typescript
HttpClient.bootstrapCutoverReadiness(slug: string): Promise<BootstrapCutoverReadiness>;
HttpClient.cutoverLegacyBootstrap(
  slug: string,
  force: boolean,
): Promise<BootstrapCutoverResponse>;
```

- [ ] **Step 1: Write failing preview/refusal tests**

In `team.test.ts`, call `team bootstrap cutover` with unmet seats/hosts and assert deterministic
output:

```text
legacy bootstrap cutover is not ready
  seats: ada, grace
  hosts: mac-studio
repair: migrate each Workspace and verify each host credential in use
```

Assert no POST occurs. Run:

```bash
pnpm --filter @musterd/cli test -- team.test.ts -t "bootstrap cutover"
```

Expected: FAIL because `cutover` is unknown.

- [ ] **Step 2: Implement confirmation and flag semantics**

Flow:

```typescript
const readiness = await http.bootstrapCutoverReadiness(team);
if (readiness.already_cut_over) return printAlreadyCutOver();
if (hasUnmet(readiness) && !force) return printRefusal(readiness);
if (!yes) await confirmDestructiveCutover(readiness, force);
return http.cutoverLegacyBootstrap(team, force);
```

Require both `--force` and `--yes` for forced non-interactive execution. `--yes` alone must not
bypass readiness. Keep JSON mode deterministic and credential-free.

- [ ] **Step 3: Cover complete, forced, cancelled, and idempotent output**

Add tests for:

- complete readiness plus confirmation;
- `--yes` complete non-interactive cutover;
- incomplete readiness refusal;
- forced interactive cutover showing unmet targets;
- `--force --yes` non-interactive cutover;
- cancelled confirmation sends no POST;
- already-cut-over reports success without confirmation.

- [ ] **Step 4: Update command help**

Document:

```text
musterd team bootstrap cutover [--force] [--yes]
```

Include the existing host migration command and explain that successful scoped use, not minting,
satisfies readiness.

- [ ] **Step 5: Run and commit the admin CLI**

Run:

```bash
pnpm --filter @musterd/cli test -- team.test.ts
```

Expected: PASS.

```bash
git add packages/cli/src
git commit -m "feat(cli): gate legacy Team key cutover

Refs ADR-${RETIREMENT_ADR}

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 7: Prove uninterrupted migration end to end

**Files:**
- Modify: `packages/cli/src/cli.e2e.test.ts`
- Modify: `packages/server/src/transport/integration.test.ts`

**Interfaces:**
- Consumes: all server and CLI interfaces from Tasks 2–6
- Produces: regression coverage for two Workspaces, one host, one live Presence, and post-cutover
  legacy refusal

- [ ] **Step 1: Write the end-to-end scenario before fixing its failures**

Build one Team with agent seats Ada and Grace, two binding directories using the same legacy key,
one residency host, and an active Presence for Ada. Execute:

```typescript
await runCli(adaDir, ['wire', '--migrate-bootstrap']);
await runCli(graceDir, ['wire', '--migrate-bootstrap']);
await runCli(adminDir, ['team', 'bootstrap', 'mint', '--host', 'mac-studio']);
await authenticateHost(hostCredential);
await claimWithMigratedBinding(adaDir);
await claimWithMigratedBinding(graceDir);
await runCli(adminDir, ['team', 'bootstrap', 'cutover', '--yes']);
```

Assert Ada's original Presence remains attached during binding replacement, both scoped seat
credentials and the host credential work after cutover, and the predecessor fails claim and host
routes.

- [ ] **Step 2: Run the scenario and fix only integration defects**

Run:

```bash
pnpm --filter @musterd/cli test -- cli.e2e.test.ts
pnpm --filter @musterd/server test -- integration.test.ts
```

Expected before integration fixes: FAIL at the first mismatched route, response, or output contract.
Apply only the smallest fixes needed to match the approved design.

- [ ] **Step 3: Re-run and commit the scenario**

Expected after fixes: PASS.

```bash
git add packages/cli/src/cli.e2e.test.ts packages/server/src/transport/integration.test.ts \
  packages/cli/src packages/server/src
git commit -m "test: prove legacy bootstrap cutover end to end

Refs ADR-${RETIREMENT_ADR}

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 8: Update operator, security, protocol, and architecture documentation

**Files:**
- Modify: `SPEC.md`
- Modify: `docs/architecture/01-data-model.md`
- Modify: `docs/architecture/03-server.md`
- Modify: `docs/architecture/04-cli.md`
- Modify: `docs/design/security.md`
- Modify: `SECURITY.md`
- Create: `docs/operations/legacy-bootstrap-cutover.md`
- Modify: `docs/superpowers/specs/2026-09-01-retire-legacy-team-key-design.md`

**Interfaces:**
- Consumes: final command names, route semantics, schema fields, and refusal behavior
- Produces: one operator runbook and current-state docs consistent with the implementation

- [ ] **Step 1: Update normative and implementation-facing docs**

In `SPEC.md`, move the compatibility window from indefinite acceptance to the ADR-gated per-Team
migration/cutover behavior without adding a new protocol Envelope or frame. Update architecture with
v54 fields, credential-use evidence, routes, CLI commands, and transactional cutover.

- [ ] **Step 2: Update security claims**

Replace the legacy-acceptance paragraph in `SECURITY.md` with:

```markdown
Teams created before scoped bootstrap credentials may still accept a marked legacy Team-wide key
until an administrator completes the documented cutover. `musterd team bootstrap cutover` refuses
unless every held agent seat and residency host has demonstrated scoped authentication, unless the
administrator explicitly forces the cutover.
```

Update `docs/design/security.md` to distinguish per-Team retirement from later product-wide
compatibility-code removal.

- [ ] **Step 3: Write the operator runbook**

`docs/operations/legacy-bootstrap-cutover.md` must contain these exact phases and commands:

```bash
musterd wire --migrate-bootstrap
musterd team bootstrap mint --host <label>
musterd team bootstrap cutover
musterd team bootstrap cutover --yes
musterd team bootstrap cutover --force --yes
```

Explain safe retry after local publication failure, observed-use readiness, how to distribute the
shown-once host credential, forced-cutover consequences, post-cutover verification, and why
`service refresh` is unrelated.

- [ ] **Step 4: Mark the approved design as implemented**

Add an implementation note to the design linking the retirement ADR and operator runbook. Do not
rewrite the approved design's Decision.

- [ ] **Step 5: Run documentation gates and commit**

Run:

```bash
pnpm format:check
pnpm change-adr:check
```

Expected: PASS, including architecture-tree, vocabulary, ADR-number, and frozen-Decision checks.

```bash
git add SPEC.md SECURITY.md docs packages/cli/src/help/catalog.ts
git commit -m "docs: publish legacy bootstrap cutover runbook

Refs ADR-${RETIREMENT_ADR}

Co-authored-by: big-body <big-body@revive.musterd>"
```

---

### Task 9: Run fast gates, update the draft PR, and hand off CI

**Files:**
- Modify only files required by gate failures attributable to this branch

**Interfaces:**
- Consumes: all prior tasks
- Produces: pushed review branch with fast local gates green and CI as authority

- [ ] **Step 1: Run the repository's required fast local gates**

Run:

```bash
pnpm typecheck && pnpm format:check
```

Expected: both pass. Do not run the full repository suite locally; CI is the authority.

- [ ] **Step 2: Review the complete branch diff**

Run:

```bash
git diff --check
git status --short
git diff origin/main...HEAD --stat
```

Expected: no whitespace errors, only intended files, and no `.musterd/` files staged.

- [ ] **Step 3: Push and convert the draft PR to ready**

```bash
git push
gh pr ready
gh pr edit --body-file /tmp/musterd-retire-legacy-team-key-pr.md
gh pr merge --squash --auto --delete-branch
```

The PR body must summarize migration authorization, observed-use readiness, transactional cutover,
safe retry, exact focused tests, and the fast local gates.

- [ ] **Step 4: Let CI land the change**

Use the CI watcher once; do not poll. If a required check fails, inspect that one failure, fix only
the cause, rerun `pnpm typecheck && pnpm format:check`, push, and return CI authority to GitHub.

- [ ] **Step 5: Submit for outcome acceptance after merge**

```bash
PR_NUMBER="$(gh pr view --json number --jq .number)"
MERGED_SHA="$(gh pr view --json mergeCommit --jq .mergeCommit.oid)"
musterd lane submit 01M1FPJ6JYRRWNF817AYFX94K1 \
  --pr "$PR_NUMBER" --sha "$MERGED_SHA" --authorized-by nick
```

After counterpart acceptance:

```bash
git fetch origin main --prune
git switch --detach origin/main
git branch -D feat/retire-legacy-team-key
```

Expected: the Lane records landed evidence and the Workspace rests detached at fresh `origin/main`.
