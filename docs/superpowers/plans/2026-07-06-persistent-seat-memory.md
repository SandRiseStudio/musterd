# Persistent Seat Memory Implementation Plan (ADR 093)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un-stub the reserved `memory` seam: a seat-scoped continuity blob the occupant saves explicitly, whose headline+age envelope rides the `occupied` frame and whose body is fetched on demand.

**Architecture:** Protocol-first (build order rule): `MemoryEnvelope` replaces the always-`null` `memory` field on `OccupiedFrame`; a daemon-private `seat_memory` table with a store module + three seat-authenticated HTTP routes; `team_memory_save`/`team_memory_read` MCP tools with a one-line join hint; `musterd memory save|show|clear` CLI. Spec: `docs/decisions/093-persistent-seat-memory.md` (read it first — it is the contract).

**Tech Stack:** TypeScript, zod, better-sqlite3 (existing), vitest. No new runtime dependency.

**Conventions that bind every task:** parse all external input through `@musterd/protocol` zod schemas at the boundary; never log/audit memory *content* (sizes only); CLI/MCP talk to the server over the wire, never import `@musterd/server`; each new source file gets a described line in the relevant `docs/architecture/0N-*.md` file tree (the `arch-trees:check` gate fails otherwise); `pnpm -r build && pnpm -r lint && pnpm test` green before any "done".

---

### Task 1: Protocol — `MemoryEnvelope` + un-stub `OccupiedFrame.memory`

**Files:**
- Modify: `packages/protocol/src/claim-handshake.ts` (the `memory: z.null()` field, ~line 90)
- Modify: `packages/protocol/src/claim-handshake.test.ts`
- Modify: `packages/protocol/src/index.ts` (export the new schema/type)

- [ ] **Step 1: Write the failing tests** — in `claim-handshake.test.ts`, replace the "requires memory to be null" test and add:

```ts
it('parses an occupied frame carrying a memory envelope (ADR 093)', () => {
  const f = OccupiedFrame.parse({
    type: 'occupied', seat, presence_id: '01J', server_time: 7,
    memory: { headline: 'mid-refactor of ws.ts eviction, tests red', saved_at: 1751830000000, size_bytes: 512 },
  });
  expect(f.memory?.headline).toContain('mid-refactor');
});

it('still accepts memory: null (no saved memory) and rejects a body on the envelope', () => {
  const f = OccupiedFrame.parse({ type: 'occupied', seat, presence_id: '01J', server_time: 7, memory: null });
  expect(f.memory).toBeNull();
  const bad = OccupiedFrame.safeParse({
    type: 'occupied', seat, presence_id: '01J', server_time: 7,
    memory: { headline: 'x', saved_at: 1, size_bytes: 1, body: 'nope' },
  });
  expect(bad.success).toBe(false); // envelope is strict: the body never rides occupy
});

it('rejects a headline over 120 chars', () => {
  const bad = OccupiedFrame.safeParse({
    type: 'occupied', seat, presence_id: '01J', server_time: 7,
    memory: { headline: 'x'.repeat(121), saved_at: 1, size_bytes: 1 },
  });
  expect(bad.success).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @musterd/protocol test` → FAIL (`MemoryEnvelope`/shape mismatch).

- [ ] **Step 3: Implement** — in `claim-handshake.ts`:

```ts
/** The memory envelope delivered on occupy (ADR 093): headline + age + size, never the body — the
 *  body travels only over an explicit read (GET /teams/:slug/memory). `.strict()` so a body can
 *  never silently ride the occupied frame. */
export const MemoryEnvelopeSchema = z
  .object({
    headline: z.string().min(1).max(120),
    saved_at: z.number().int(),
    size_bytes: z.number().int().nonnegative(),
  })
  .strict();
export type MemoryEnvelope = z.infer<typeof MemoryEnvelopeSchema>;
```

and on `OccupiedFrame` change `memory: z.null()` → `memory: MemoryEnvelopeSchema.nullable()` (update the doc comment: no longer "always null"; cite ADR 093). Export both from `index.ts`.

- [ ] **Step 4: Run** — `pnpm --filter @musterd/protocol test` → PASS (envelope round-trip + version-pin suites all green).

- [ ] **Step 5: Commit** — `git add packages/protocol && git commit -m "feat(protocol): MemoryEnvelope on the occupied frame — the memory seam un-stubbed (ADR 093)"`

### Task 2: SPEC + protocol doc

**Files:**
- Modify: `SPEC.md` (A.3 `occupied` frame: `memory: null` reservation → optional envelope; bump the SPEC minor per its own versioning section)
- Modify: `docs/architecture/02-protocol.md` (occupied-frame description)

- [ ] **Step 1:** In `SPEC.md` A.3, replace the "`memory` … always `null`" sentence with the envelope contract (headline ≤120, `saved_at`, `size_bytes`; body via `GET /teams/:slug/memory`; additive — clients ignoring `memory` lose nothing). Follow the file's own version-bump convention (rewritten in place, ADR-gated → cite ADR 093).
- [ ] **Step 2:** Mirror the same in `02-protocol.md` where `occupied` is described.
- [ ] **Step 3:** `pnpm format:check` → PASS. Commit: `docs(spec): memory envelope on occupied — SPEC minor (ADR 093)`.

### Task 3: Server store — `seat_memory` table + module

**Files:**
- Modify: `packages/server/src/db/migrations.ts` (append the next forward-only migration)
- Create: `packages/server/src/store/memory.ts`
- Create: `packages/server/src/store/memory.test.ts`
- Modify: `packages/server/src/store/audit.ts` (`AuditAction` union: `'memory.save' | 'memory.clear'`)
- Modify: `docs/architecture/03-server.md` (file-tree line for `store/memory.ts` + a short §)

- [ ] **Step 1: Failing tests** — `memory.test.ts`, using the in-memory DB pattern from `store.test.ts`:

```ts
describe('seat memory (ADR 093)', () => {
  it('save → get round-trips headline/body/saved_at; envelope() has no body', () => {
    saveMemory(db, memberId, { headline: 'h', body: 'b' });
    const m = getMemory(db, memberId)!;
    expect(m.body).toBe('b');
    const env = memoryEnvelope(db, memberId)!;
    expect(env).toEqual({ headline: 'h', saved_at: expect.any(Number), size_bytes: 1 });
  });
  it('is last-write-wins (single row per member)', () => { /* save twice, expect second */ });
  it('rejects a body over 8192 bytes and a headline over 120 chars with named limits', () => {
    expect(() => saveMemory(db, memberId, { headline: 'h', body: 'x'.repeat(8193) }))
      .toThrow(/8192/);
  });
  it('clear removes the row; envelope() returns null after', () => { /* ... */ });
  it('size_bytes counts UTF-8 bytes, not code units', () => { /* body: '€€' → 6 */ });
});
```

- [ ] **Step 2:** `pnpm --filter @musterd/server test -- memory` → FAIL.
- [ ] **Step 3: Migration** — append to `migrations.ts` (next version number in sequence):

```ts
// ADR 093: seat memory — daemon-private continuity blob, one row per member, last-write-wins.
// Deliberately NOT in the git seat-file (live working state, ADR 058 durable/live line).
db.exec(`CREATE TABLE seat_memory (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  headline  TEXT NOT NULL,
  body      TEXT NOT NULL,
  saved_at  INTEGER NOT NULL
)`);
```

- [ ] **Step 4: Store module** — `store/memory.ts` exporting (match the style of `store/goals.ts`):

```ts
export const MEMORY_BODY_MAX_BYTES = 8192;
export const MEMORY_HEADLINE_MAX_CHARS = 120;
export function saveMemory(db, memberId, input: { headline: string; body: string }): void; // validates caps, upserts, saved_at = Date.now()
export function getMemory(db, memberId): { headline: string; body: string; saved_at: number } | null;
export function memoryEnvelope(db, memberId): MemoryEnvelope | null; // Buffer.byteLength(body) for size_bytes
export function clearMemory(db, memberId): boolean; // true if a row existed
```

Add `'memory.save' | 'memory.clear'` to `AuditAction` with a comment: detail carries sizes only, never content (hard rule 5).

- [ ] **Step 5:** Tests PASS. Add the `store/memory.ts` described line to the `03-server.md` file tree (drift-checked). Commit: `feat(server): seat_memory store — save/get/envelope/clear with caps (ADR 093)`.

### Task 4: Server HTTP + occupy wiring

**Files:**
- Modify: `packages/server/src/transport/http.ts` (three routes + the three `memory: null` occupied-body sites at ~709/996/1028)
- Modify: `packages/server/src/transport/ws.ts` (the `memory: null` occupied-frame site at ~520)
- Modify: `packages/server/src/transport/integration.test.ts`
- Modify: `docs/architecture/03-server.md` (HTTP route table)

- [ ] **Step 1: Failing integration tests** — in `integration.test.ts` (follow its existing occupied-flow helpers):

```ts
describe('seat memory endpoints + occupy envelope (ADR 093)', () => {
  it('PUT /teams/:slug/memory saves for the authenticated seat; GET returns the body; DELETE clears', ...);
  it('a seat cannot read or write another seat's memory — 403 even for an admin token', ...);
  it('an occupied frame (WS claim) carries the envelope when memory exists, null when not', ...);
  it('oversize body → 400 naming the 8192 limit; missing headline → 400', ...);
  it('audit rows for memory.save carry size_bytes and headline_len, never headline or body text', ...);
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Routes** — in `http.ts`, seat-resolved from the presented token (the same auth helper the other member-scoped routes use; the target seat is always *the caller's own*, so the URL carries no member name):
  - `PUT /teams/:slug/memory` — body parsed by a zod schema `{ headline, body }`, calls `saveMemory`, appends audit `memory.save` with `{ size_bytes, headline_len }`, returns `204`.
  - `GET /teams/:slug/memory` — `200 { headline, body, saved_at }` or `404` when none.
  - `DELETE /teams/:slug/memory` — `clearMemory`, audit `memory.clear`, `204` (idempotent).
- [ ] **Step 4: Occupy wiring** — replace all four `memory: null` literals (ws.ts ~520; http.ts ~709/996/1028) with `memory: memoryEnvelope(ctx.db, member.id)`.
- [ ] **Step 5:** Integration tests PASS; `pnpm --filter @musterd/server test` fully green (coverage ≥85% holds). Update the `03-server.md` route table. Commit: `feat(server): seat-scoped memory routes + envelope on occupy (ADR 093)`.

### Task 5: MCP — `team_memory_save` / `team_memory_read` + the join one-liner

**Files:**
- Create: `packages/mcp/src/tools/memory.ts`
- Modify: `packages/mcp/src/toolNames.ts`, `packages/mcp/src/index.ts` (register), `packages/mcp/src/tools/join.ts` (one-liner)
- Modify: `packages/mcp/src/tools/tools.test.ts`, `packages/mcp/src/mcp.test.ts`
- Modify: `docs/architecture/05-mcp.md` (tool table + file tree)

- [ ] **Step 1: Failing tests** — tool handlers (mock the HTTP client like the other tool tests) and the join rendering:

```ts
it('team_memory_save PUTs headline+body and reports the saved size', ...);
it('team_memory_read returns headline, age and body; explains when none is saved', ...);
it('team_join result appends one memory line when the occupied frame carries an envelope', () => {
  // expect a single line matching: /Saved memory from .* ago: ".*" — team_memory_read to load it\./
});
it('team_join result has no memory line when memory is null', ...);
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** — `tools/memory.ts` follows `tools/goals.ts`'s shape (zod input schemas, wire calls via the shared HTTP client — never importing the server). Join one-liner rendered from the envelope with a relative age (reuse the existing relative-time helper if one exists in `render`/utils; otherwise a local `formatAge(ms)`).
- [ ] **Step 4:** `pnpm --filter @musterd/mcp test` → PASS. Update `05-mcp.md`. Commit: `feat(mcp): team_memory_save/read + the join memory one-liner (ADR 093)`.

### Task 6: CLI — `musterd memory save|show|clear` + claim/status one-liner

**Files:**
- Create: `packages/cli/src/commands/memory.ts`
- Create: `packages/cli/src/commands/memory.test.ts`
- Modify: `packages/cli/src/bin.ts` (dispatch), `packages/cli/src/args.ts` (flags), `packages/cli/src/help.ts` (command entry — required, `guidance:check` asserts the skill only names commands HELP knows)
- Modify: `packages/cli/src/commands/claim.ts` + `status.ts` (print the one-liner from the occupied response envelope)
- Modify: `docs/architecture/04-cli.md` (command table + file tree)

- [ ] **Step 1: Failing tests** — follow `commands/goal.ts`/`audit.ts` test patterns (stubbed fetch):

```ts
it('memory save --headline "<s>" reads the body from the arg, else stdin, and PUTs it', ...);
it('memory save without --headline exits non-zero naming the flag', ...);
it('memory (show) prints headline, age, and body; a clean empty-state message when none', ...);
it('memory clear DELETEs and confirms', ...);
it('claim prints the saved-memory one-liner when the occupied body carries an envelope', ...);
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** — `memory.ts` with subcommands `save` (headline flag required; body: positional arg, else stdin when piped), `show` (default), `clear`. Wire into `bin.ts`/`args.ts`/`help.ts`. One-liner in `claim.ts`: same wording as the MCP join line but naming `musterd memory` as the read command.
- [ ] **Step 4:** `pnpm --filter @musterd/cli test` → PASS. Update `04-cli.md`. Commit: `feat(cli): musterd memory save/show/clear + claim one-liner (ADR 093)`.

### Task 7: Guidance — the skill playbook line

**Files:**
- Modify: the skill template in `@musterd/protocol` (the guidance templates module — find via `rg -l "handoff-with-branch" packages/protocol/src`), bump its content version (a snapshot test forces this)
- Modify: its snapshot test

- [ ] **Step 1:** Add one playbook line to the skill body (NOT the primer — ADR 085 keeps the kernel lean): saving your memory before a handoff or wrap-up (`musterd memory save --headline "<subject>"` / `team_memory_save`), and that a saved memory surfaces one line on your next claim.
- [ ] **Step 2:** Bump the template content version; update the snapshot. `pnpm guidance:check` (part of `format:check`) → PASS — it asserts every command/tool the skill names exists in HELP + the MCP registry, which Tasks 5–6 made true.
- [ ] **Step 3:** Commit: `docs(guidance): memory-save playbook line in the skill (ADR 093)`.

### Task 8: Telemetry attributes + ADR flip + full gate

**Files:**
- Modify: the CLI/MCP telemetry span attrs (`packages/mcp/src/telemetry.ts` seam — the tool-call span already exists per ADR 089; add `memory.size_bytes`/`memory.headline_len` attrs on the memory ops only, never content)
- Modify: `docs/decisions/093-persistent-seat-memory.md` (Status: proposed → accepted — built YYYY-MM-DD, listing the shipped pieces, matching the house style of ADR 090's status line)
- Modify: `docs/architecture/05-mcp.md`/`03-server.md` acceptance checklists if they enumerate tools/routes

- [ ] **Step 1:** Add the span attributes with a size-only assertion in the existing telemetry tests.
- [ ] **Step 2:** Flip the ADR status line.
- [ ] **Step 3: Full gate** — `pnpm -r build && pnpm -r lint && pnpm test && pnpm format:check` → all green (this is the 07-conventions Definition of Done).
- [ ] **Step 4:** Commit: `feat(telemetry): memory op span attrs; ADR 093 accepted`.

---

## Self-review notes

- Spec coverage: ADR §1→Tasks 5/6 (verbs), §2→Tasks 1/3 (caps, headline, saved_at), §3→Tasks 1/4/5/6 (envelope + one-liners + on-demand body), §4→Tasks 3/4 (daemon-private, seat-only auth, seat-owned), §5→Tasks 4/5/6/7 (surfaces + audit sizes-only + skill line), §6→Task 2 (SPEC minor), Observability→Task 8. The read-after-occupy *eval* is measurement over emitted data, not code — no task needed beyond the Task 8 attributes.
- Type consistency: `MemoryEnvelope { headline, saved_at, size_bytes }` is used identically in Tasks 1/3/4/5/6; store functions named `saveMemory/getMemory/memoryEnvelope/clearMemory` throughout.
- Line numbers (`ws.ts:520`, `http.ts:709/996/1028`) are anchors as of 2026-07-06; re-locate with `rg -n "memory: null" packages/server/src` if drifted.
