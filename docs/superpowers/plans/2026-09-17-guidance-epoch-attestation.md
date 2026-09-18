# Guidance epoch attestation — increment 1 implementation plan

> **Execution:** this plan is executed by the lane owner in their own seat, task by task, with a
> commit per task. No subagents (`~/.claude/CLAUDE.md`: a writing agent has no seat, no lane and no
> model attestation). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every occupancy carries the guidance epoch the seat is *actually running*, so "which seats
acted on a superseded rule" is a roster query instead of a nine-worktree shell script.

**Architecture:** one optional integer, `guidance_epoch`, rides the paths model attestation already
uses — the claim handshake, the heartbeat frame, and the HTTP claim mirror — onto the presence row
and out through the roster read. The CLI derives it by parsing the `<!-- musterd:content vN … -->`
stamp out of the guidance files *installed in this workspace*, never from
`GUIDANCE_CONTENT_VERSION` (the build's ceiling). Nothing new is plumbed: `epoch` (ADR 148) and
`build` (ADR 135) are the exact siblings this field copies.

**Tech Stack:** TypeScript, zod schemas in `@musterd/protocol`, better-sqlite3 + numbered migrations
in `@musterd/server`, vitest throughout.

**Spec:** `docs/superpowers/specs/2026-09-17-guidance-currency-receipt-design.md` — §3 "The
attestation" and the "Increments" section, which puts this increment FIRST and says why.

---

## Global Constraints

- **Increment 1 only.** The receipt (`~/.musterd/refresh/receipt.json`), the reader, and the
  `composeLine` currency states are increment 2 and get their own plan and ADR. Nothing in this plan
  reads a receipt or changes a session-start line.
- **`guidance_epoch` is the INSTALLED stamp, never `GUIDANCE_CONTENT_VERSION`.** Spec §3: the files
  are the text that was in the model's context; the constant is only what the build *could* have
  written. Attesting the constant would attest a capability instead of a fact, which is the exact
  self-referential defect `runtime.ts:59` already names.
- **No second field.** `seat_knew_it_was_behind` is deliberately omitted and the second wire change
  is accepted knowingly (spec §3). Do not re-litigate; the reason is that the field's meaning depends
  on a receipt verdict the threshold finding proved is not yet trustworthy.
- **Additive and optional everywhere.** Absent ⇒ unknown, never a block and never a clear. Old
  clients, thin harnesses and unstamped workspaces stay legal, exactly as `model`/`build`/`epoch` do.
- **Heartbeat re-attestation never clears.** `COALESCE(?, guidance_epoch)`, same rule and same
  reason as `model` (`presence.ts:378`).
- **Self-reported, and the ADR says so.** Nothing proves a seat's claim about its own files — the
  same limit `model_source: 'observed'` carries. Honest bookkeeping, not cryptographic attestation.
- **Two known traps, from prior sessions in this lane** (spec, "Testing"): rebuild
  `packages/protocol` before trusting any `packages/cli` typecheck, and **commit before running
  `change-adr:check`** — it diffs committed changes only.

## Sequencing against work already in flight

Read this before Task 1; it changes what you rebase onto, not what you write.

- **dolly's PR #1549** (lane `01M2PAFNAS`, green, unmerged at the time of writing) touches
  `packages/protocol/src/member.ts`, `packages/server/src/store/presence.ts`,
  `packages/server/src/db/migrations.ts` (adds **migration 68**), `packages/server/src/transport/http.ts`
  and the claim-HTTP tests — the same five files this plan edits. It is the same field travelling the
  same route.
  **Rule: land after it.** Rebase this branch onto `main` once #1549 merges, take **migration 69**,
  and follow whatever column/serialisation shape it set rather than inventing a parallel one. If it
  is still unmerged when this plan starts, do Tasks 1 and 2 (which do not touch their files) and hold
  Task 3 until it lands.
- **dolly's follow-on lane `01M2RTF2D0`** — "the CLI never SENDS `model_source` on the HTTP claim
  mirror" — is the *same defect* for `model_source` that Task 5 of this plan fixes for
  `guidance_epoch`. Coordinate before writing Task 5: if they have already repaired the mirror's send
  path, Task 5 shrinks to adding one field to a body that is already correct.
- **ADR number:** 416 is taken by #1549 (unmerged), so this increment is **ADR 417**. Reserve it with
  a draft push at Task 2 before building — ryder lost 413 to exactly this collision.
- **This worktree is itself behind.** `GUIDANCE_CONTENT_VERSION` here reads 24; main is at 25.
  `git rebase origin/main` and `pnpm build` before Task 1, or every epoch number in every test will
  be off by one against the tree you are testing on.

---

### Task 1: Read the workspace's installed guidance epoch

The CLI-local derivation, with no wire and no server in it. Self-contained and independently
testable, which is why it goes first.

**Files:**
- Modify: `packages/cli/src/onboard/guidance.ts` (add one exported function near `strippedBody`)
- Test: `packages/cli/src/onboard/guidance.test.ts`

**Interfaces:**
- Consumes: `parseContentStamp` (already imported at `guidance.ts:6`), `guidanceTargets`,
  `establishedHarnesses` (both already exported from this file).
- Produces:
  ```ts
  export function installedGuidanceEpoch(
    cwd: string,
    harnesses: Harness[],
  ): number | undefined;
  ```
  Task 4 and Task 5 call exactly this.

**The three rulings this task locks in** — decide them here, in code and in the doc comment, so no
later task re-derives them:

1. **Disagreement takes the MINIMUM.** A workspace whose files carry different stamps ran the
   weakest rule in the set; attesting the highest would over-claim precisely in the case the census
   exists to catch.
2. **Unstamped or unparseable files are skipped, not zeroed.** A file with no stamp is not epoch 0 —
   it is no evidence. If that leaves nothing, return `undefined`.
3. **No file, no provisioning, no harness ⇒ `undefined` ⇒ the field is omitted.** ADR 135's doctrine:
   degrade to silence, never to a guessed value.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/src/onboard/guidance.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDANCE_CONTENT_VERSION, renderContentStamp } from '@musterd/protocol';
import { installedGuidanceEpoch, guidanceTargets, establishedHarnesses } from './guidance.js';
import { claudeCode } from './harnesses/claudeCode.js';
import { cursor } from './harnesses/cursor.js';

// `Harness` is an OBJECT, not a name string — `guidanceTargets([claudeCode])`, never
// `guidanceTargets([claudeCode])`. The existing tests in this file already import them this way.

function workspaceWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-epoch-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

/** A guidance file body carrying exactly the stamp `renderContentStamp` writes. */
function stamped(version: number): string {
  return `# skill\n\nbody text\n${renderContentStamp(version, 'a'.repeat(16))}\n`;
}

describe('installedGuidanceEpoch', () => {
  it('returns the stamp version when every installed file agrees', () => {
    const targets = guidanceTargets([claudeCode]);
    const dir = workspaceWith(Object.fromEntries(targets.map((t) => [t, stamped(22)])));
    expect(installedGuidanceEpoch(dir, [claudeCode])).toBe(22);
  });

  it('takes the MINIMUM when installed files disagree — the seat ran the weakest rule', () => {
    const targets = guidanceTargets([claudeCode]);
    expect(targets.length).toBeGreaterThan(1); // the disagreement case needs two files
    const bodies = Object.fromEntries(targets.map((t) => [t, stamped(24)]));
    bodies[targets[0]] = stamped(21);
    const dir = workspaceWith(bodies);
    expect(installedGuidanceEpoch(dir, [claudeCode])).toBe(21);
  });

  it('skips an unstamped file rather than counting it as epoch 0', () => {
    const targets = guidanceTargets([claudeCode]);
    const bodies = Object.fromEntries(targets.map((t) => [t, stamped(23)]));
    bodies[targets[0]] = '# skill\n\nhand-written, no stamp\n';
    const dir = workspaceWith(bodies);
    expect(installedGuidanceEpoch(dir, [claudeCode])).toBe(23);
  });

  it('returns undefined for a workspace with no guidance files at all', () => {
    expect(installedGuidanceEpoch(workspaceWith({}), [claudeCode])).toBeUndefined();
  });

  it('returns undefined when every installed file is unstamped', () => {
    const targets = guidanceTargets([claudeCode]);
    const dir = workspaceWith(Object.fromEntries(targets.map((t) => [t, 'no stamp here\n'])));
    expect(installedGuidanceEpoch(dir, [claudeCode])).toBeUndefined();
  });

  it('reads the FILES, not the build constant — a workspace stamped one behind says so', () => {
    const behind = GUIDANCE_CONTENT_VERSION - 1;
    const targets = guidanceTargets([claudeCode]);
    const dir = workspaceWith(Object.fromEntries(targets.map((t) => [t, stamped(behind)])));
    expect(installedGuidanceEpoch(dir, [claudeCode])).toBe(behind);
    expect(installedGuidanceEpoch(dir, [claudeCode])).not.toBe(GUIDANCE_CONTENT_VERSION);
  });

  it('scopes to established harnesses — a harness with nothing installed contributes nothing', () => {
    const targets = guidanceTargets([claudeCode]);
    const dir = workspaceWith(Object.fromEntries(targets.map((t) => [t, stamped(24)])));
    expect(installedGuidanceEpoch(dir, establishedHarnesses(dir, [claudeCode, cursor]))).toBe(24);
  });
});
```

- [ ] **Step 2: Run the tests and watch every one fail**

Run: `cd packages/cli && pnpm vitest run src/onboard/guidance.test.ts -t installedGuidanceEpoch`
Expected: FAIL — `installedGuidanceEpoch is not a function` / no such export.

If the second test fails on its `expect(targets.length).toBeGreaterThan(1)` guard instead, the
harness writes a single guidance file; use two harnesses (`[claudeCode, cursor]`) for that one
case rather than deleting it — the minimum rule is the ruling most likely to be broken later.

- [ ] **Step 3: Implement it**

```ts
/**
 * The guidance epoch this WORKSPACE is running — parsed out of the files installed here, never
 * `GUIDANCE_CONTENT_VERSION` (ADR 417, spec §3).
 *
 * The constant is this build's CEILING: what it *would* write. The stamps are what is actually in
 * the model's context at this moment. Attesting the constant would repeat the self-referential
 * defect `runtime.ts:59` already names — a binary that writes v21 pronouncing v21 current — one
 * layer up, on the wire, where it would be much harder to see.
 *
 * Three rulings, all of them deliberate:
 * - **Disagreement takes the minimum.** A workspace whose files carry different stamps ran the
 *   weakest rule in the set, and the weakest rule is the one a census exists to find.
 * - **An unstamped file is skipped, not zeroed.** No stamp is an absence of evidence, not evidence
 *   of epoch 0 — zeroing it would drag the minimum to 0 and report every hand-edited workspace as
 *   maximally stale.
 * - **Nothing readable ⇒ `undefined` ⇒ the field is omitted on the wire** (ADR 135: degrade to
 *   silence, never to a guessed value).
 */
export function installedGuidanceEpoch(cwd: string, harnesses: Harness[]): number | undefined {
  let lowest: number | undefined;
  for (const rel of guidanceTargets(harnesses)) {
    const abs = join(cwd, rel);
    // `existsSync` + `safeRead` is this file's own idiom (see `removeGuidance`) — reuse it rather
    // than a bare read, so an unreadable file degrades to "no evidence" like an absent one.
    const text = existsSync(abs) ? safeRead(abs) : null;
    if (text === null) continue; // absent or unreadable: no evidence, not a zero
    const stamp = parseContentStamp(text);
    if (stamp === null) continue; // unstamped or hand-written: likewise no evidence
    lowest = lowest === undefined ? stamp.version : Math.min(lowest, stamp.version);
  }
  return lowest;
}
```

`existsSync`, `join`, `safeRead` and `parseContentStamp` are all already imported at the top of this
file — reuse them, do not re-import.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/cli && pnpm vitest run src/onboard/guidance.test.ts -t installedGuidanceEpoch`
Expected: PASS, 7/7.

- [ ] **Step 5: Mutation-check the two rulings that are easy to get wrong**

Not a new test — a manual falsifier, run and then reverted:
1. Change `Math.min` to `Math.max`. The minimum test must go red. If it stays green the fixture does
   not actually disagree; fix the fixture, not the assertion.
2. Change the `if (stamp === null) continue` to `lowest = 0`. The unstamped test must go red.
Revert both.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/onboard/guidance.ts packages/cli/src/onboard/guidance.test.ts
git commit -m "A workspace's guidance epoch is in its files, not in the build that would write them"
```

---

### Task 2: The wire field, and the ADR that says what it means

Protocol-only. It must be its own commit because `change-adr:check` gates a protocol change on a
committed ADR, and because reserving the ADR number early is what stops the 413 collision.

**Files:**
- Create: `docs/decisions/417-a-seat-attests-the-guidance-it-is-running.md`
- Modify: `packages/protocol/src/claim-handshake.ts` (beside `epoch`, ~line 121)
- Modify: `packages/protocol/src/frames.ts` (`HeartbeatFrame`, beside `model_source`, ~line 59)
- Modify: `packages/protocol/src/member.ts` (`PresenceSchema`, beside `epoch`, ~line 86)
- Test: `packages/protocol/src/claim-handshake.test.ts`, `packages/protocol/src/frames.test.ts`

**Interfaces:**
- Produces: `guidance_epoch?: number` on `ClaimFrame` and `HeartbeatFrame`;
  `guidance_epoch?: number | null` on `PresenceSchema`. Tasks 3, 4 and 5 all key on these names.

- [ ] **Step 1: Reserve ADR 417 and push a draft branch**

```bash
pnpm adr:next   # confirm 417 is next; if it prints higher, dolly's 416 landed and you take that number
git push -u origin izzo/guidance-currency-receipt
```

Do this before writing code. The number is reserved by the push, not by the intention.

- [ ] **Step 2: Write the ADR**

`docs/decisions/417-a-seat-attests-the-guidance-it-is-running.md`, in the repo's ADR shape
(Context / Decision / Consequences). It must state, in this order:

- **Context.** ADR 408 self-heal repairs a seat to match *the local build*; nothing ties that build
  to `origin/main`; `WorkspaceRepairBody.build` is recorded and dropped from the line
  (`selfHeal.ts:89` vs `:111`). The near-miss that let this survive review: `composeLine`'s `behind`
  state cannot fire when every seat is repaired by the same stale linked dist — **a guard that
  detects disagreement is blind to uniform error.** Include the measured census: on 2026-09-17,
  twenty minutes after v25 landed, one of nine seats was current, and the seat running v24 was the
  one that *authored* v25.
- **Decision.** One optional field, `guidance_epoch`, on the claim handshake, the heartbeat frame and
  the presence row. It is the **installed stamp**, not `GUIDANCE_CONTENT_VERSION`, and the ADR says
  why in one sentence: the constant attests a capability, the stamp attests a fact.
- **Decision — what is deliberately NOT here.** No `seat_knew_it_was_behind`, and the second wire
  change is accepted knowingly: that field's meaning depends on the receipt's verdict, and the
  threshold finding (35.75% of wall-clock time sits inside a >15min tick gap, because the laptop
  sleeps) proved the verdict is not trustworthy yet. Shipping it now would mean redefining its
  semantics later — a worse cost than a second migration.
- **Consequences — the limit, stated plainly.** Self-reported. A seat says what it ran and nothing
  proves it, exactly as `model_source: 'observed'` already carries. Honest bookkeeping, not
  cryptographic attestation; a reader who assumes otherwise is assuming something this ADR denies.
- **Consequences — what this does NOT buy.** Visibility, not prevention. The gate (spec §4) stays
  deferred and unscheduled until this increment has produced false-positive data.

- [ ] **Step 3: Write the failing schema tests**

```ts
// packages/protocol/src/claim-handshake.test.ts
it('carries an optional guidance_epoch — the stamp the seat is running', () => {
  const base = {
    type: 'claim', v: PROTOCOL_VERSION, team: 't', key: 'k',
    target: { seat: 'izzo' }, surface: 'claude-code',
  };
  expect(ClaimFrame.parse({ ...base, guidance_epoch: 24 }).guidance_epoch).toBe(24);
  // absent is legal and stays absent — never defaulted to 0, which would read as "maximally stale"
  expect(ClaimFrame.parse(base).guidance_epoch).toBeUndefined();
  // a version is a non-negative integer; a float or a negative is a malformed stamp, not a low one
  expect(() => ClaimFrame.parse({ ...base, guidance_epoch: -1 })).toThrow();
  expect(() => ClaimFrame.parse({ ...base, guidance_epoch: 24.5 })).toThrow();
});
```

```ts
// packages/protocol/src/frames.test.ts
it('re-attests guidance_epoch on a heartbeat — a mid-session refresh is real', () => {
  const hb = HeartbeatFrame.parse({ type: 'heartbeat', guidance_epoch: 25 });
  expect(hb.guidance_epoch).toBe(25);
  // absent ⇒ no change, never a clear: the same never-clear rule `model` carries
  expect(HeartbeatFrame.parse({ type: 'heartbeat' }).guidance_epoch).toBeUndefined();
});
```

- [ ] **Step 4: Run them and watch them fail**

Run: `cd packages/protocol && pnpm vitest run src/claim-handshake.test.ts src/frames.test.ts -t guidance_epoch`
Expected: FAIL — the parsed frame has no `guidance_epoch`, so the first `expect` is `undefined`, and
the `-1` / `24.5` cases do not throw (zod strips unknown keys rather than rejecting them).

- [ ] **Step 5: Add the field in all three schemas**

`claim-handshake.ts`, immediately after `epoch` (~line 121):

```ts
  /**
   * The guidance epoch this seat is RUNNING (ADR 417) — the `<!-- musterd:content vN -->` stamp in
   * the workspace's own guidance files, not `GUIDANCE_CONTENT_VERSION`, which is only what this
   * build would write. Omitted for unstamped or unprovisioned workspaces and by older clients;
   * absent reads as unknown and never blocks. Re-attested on the heartbeat, because a
   * `--refresh-guidance` mid-session is real. Self-reported and never verified, the same limit
   * `model_source` carries.
   */
  guidance_epoch: z.number().int().nonnegative().optional(),
```

`frames.ts`, in `HeartbeatFrame` after `model_source`:

```ts
  // Guidance re-attestation (ADR 417, additive): self-heal or `--refresh-guidance` can move the
  // workspace's stamp mid-occupancy, so the adapter may carry the current one on a heartbeat.
  // Absent ⇒ no change, never a clear — the same rule `model` carries, for the same reason.
  guidance_epoch: z.number().int().nonnegative().optional(),
```

`member.ts`, in `PresenceSchema` after `epoch`:

```ts
  /** The guidance epoch this occupancy attested (ADR 417) — the stamp in the seat's own guidance
   *  files, not its build's ceiling. Null/absent for unstamped workspaces and older clients. This
   *  is the field that makes the nine-worktree census a query. */
  guidance_epoch: z.number().int().nonnegative().nullish(),
```

- [ ] **Step 6: Run the tests and the protocol suite**

Run: `cd packages/protocol && pnpm vitest run`
Expected: PASS, and the pre-existing count (583 at the time of writing) plus the new cases.

- [ ] **Step 7: Commit, THEN run the docs gate**

```bash
git add docs/decisions/417-*.md packages/protocol/src
git commit -m "ADR 417: a seat attests the guidance it is running, not the guidance it could write"
pnpm adr-numbers:check && pnpm format:check
```

`change-adr:check` diffs committed changes only — running it before the commit reports nothing and
proves nothing. This ordering is one of the lane's two recorded traps.

---

### Task 3: Persist it on the presence row and read it back

**Files:**
- Modify: `packages/server/src/db/migrations.ts` (append **migration 69** — see sequencing note)
- Modify: `packages/server/src/store/presence.ts` (claim insert ~`:134`, heartbeat update ~`:378`,
  the row type at `:18`, the context type at `:53`, the read at `:159`)
- Test: `packages/server/src/db/db.test.ts`, `packages/server/src/store/store.test.ts`

**Interfaces:**
- Consumes: `guidance_epoch` from Task 2's schemas.
- Produces: `PresenceContext.guidance_epoch?: number | null`, and `guidance_epoch` on the presence
  row the roster read returns.

- [ ] **Step 1: Write the failing store tests**

```ts
// packages/server/src/store/store.test.ts
it('records the claimed guidance_epoch on the presence row', () => {
  const s = freshStore();
  s.claimSeat({ ...baseCtx, guidance_epoch: 23 });
  expect(s.roster().find((m) => m.name === 'izzo')?.presence?.guidance_epoch).toBe(23);
});

it('omitted guidance_epoch stores null, not 0', () => {
  const s = freshStore();
  s.claimSeat({ ...baseCtx });
  expect(s.roster().find((m) => m.name === 'izzo')?.presence?.guidance_epoch).toBeNull();
});

it('a heartbeat moves guidance_epoch forward — a mid-session refresh is real', () => {
  const s = freshStore();
  s.claimSeat({ ...baseCtx, guidance_epoch: 23 });
  s.heartbeat({ ...baseCtx, guidance_epoch: 25 });
  expect(s.roster().find((m) => m.name === 'izzo')?.presence?.guidance_epoch).toBe(25);
});

it('a heartbeat WITHOUT guidance_epoch never clears the attested one', () => {
  const s = freshStore();
  s.claimSeat({ ...baseCtx, guidance_epoch: 23 });
  s.heartbeat({ ...baseCtx });
  expect(s.roster().find((m) => m.name === 'izzo')?.presence?.guidance_epoch).toBe(23);
});
```

Use whatever `freshStore` / `baseCtx` helpers `store.test.ts` already defines — match the file's
existing fixture style rather than introducing a second one.

```ts
// packages/server/src/db/db.test.ts — beside the existing migration assertions
it('migration 69 adds presence.guidance_epoch, nullable and defaulting to null', () => {
  const db = migratedDb();
  const cols = db.prepare('PRAGMA table_info(presence)').all() as { name: string; notnull: number }[];
  const col = cols.find((c) => c.name === 'guidance_epoch');
  expect(col).toBeDefined();
  expect(col?.notnull).toBe(0);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/server && pnpm vitest run src/store/store.test.ts src/db/db.test.ts -t guidance_epoch`
Expected: FAIL — `no such column: guidance_epoch`.

- [ ] **Step 3: Add the migration**

Append to `migrations.ts`, taking the next free version (**69** if dolly's 68 has landed; re-check
`pnpm migrations:check` rather than trusting this number):

```ts
  {
    // ADR 417: the presence row carries the guidance epoch the seat attested — the stamp in its own
    // workspace files, not its build's ceiling. Nullable because absence is a real and permanent
    // state (unstamped workspaces, older clients) and must not read as epoch 0, which a NOT NULL
    // DEFAULT 0 would make indistinguishable from "maximally stale".
    version: 69,
    up: (db) => {
      db.exec(`ALTER TABLE presence ADD COLUMN guidance_epoch INTEGER`);
    },
  },
```

- [ ] **Step 4: Thread it through the three places `epoch` already goes**

In `presence.ts`, follow `epoch` exactly — it is the sibling this field copies:
- the row type (`:18`): `guidance_epoch: number | null;`
- the context type (`:53`): `guidance_epoch?: number | null;` with a one-line doc comment
- the claim insert (`:134`): `guidance_epoch: ctx.guidance_epoch ?? null,` and add the column and
  `@guidance_epoch` to the INSERT statement
- the read (`:159`): `guidance_epoch: row.guidance_epoch,`
- the heartbeat UPDATE (`:378`): add `guidance_epoch = COALESCE(?, guidance_epoch)` and bind
  `ctx.guidance_epoch ?? null` in the matching position

**Bind-order warning:** that UPDATE uses positional `?` parameters. Adding a column means adding the
bind in the right slot; get it wrong and you will silently write `status` into `guidance_epoch`. The
"heartbeat moves it forward" test catches a wrong *value*; read the bind list once by eye as well.

- [ ] **Step 5: Run the server suite**

Run: `cd packages/server && pnpm vitest run`
Expected: PASS, the pre-existing count plus 5.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src
git commit -m "The presence row carries the guidance epoch the seat attested (migration 69)"
```

---

### Task 4: The CLI attests it — WS claim and heartbeat

**Files:**
- Modify: `packages/cli/src/claim-client.ts` (`buildClaimFrame`, ~`:85`)
- Modify: `packages/cli/src/client.ts` (the heartbeat sender, and the claim forward at ~`:1302`)
- Modify: `packages/cli/src/host/backends/nativeBridge.ts` (~`:137`)
- Test: `packages/cli/src/claim-client.test.ts`, `packages/cli/src/client.test.ts`

**Interfaces:**
- Consumes: `installedGuidanceEpoch` (Task 1), `guidance_epoch` on the frames (Task 2).

**The one design point in this task:** `epoch: FEATURE_EPOCH` is unconditional because it is a
compiled-in constant. `guidance_epoch` is **not** — it is a filesystem read that can legitimately
answer "nothing here", so it is spread conditionally like `model` and `build` are. Copying the
`epoch` line's unconditional shape would attest `undefined` and defeat Task 1's third ruling.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/src/claim-client.test.ts
it('attests the workspace guidance epoch when the files carry a stamp', () => {
  const frame = buildClaimFrame({ ...base, guidanceEpoch: 24 });
  expect(frame.guidance_epoch).toBe(24);
});

it('OMITS guidance_epoch when the workspace has no readable stamp', () => {
  const frame = buildClaimFrame({ ...base, guidanceEpoch: undefined });
  expect('guidance_epoch' in frame).toBe(false);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/cli && pnpm vitest run src/claim-client.test.ts -t guidance`
Expected: FAIL — `buildClaimFrame` has no `guidanceEpoch` input, so the field is absent in both.
Note the second test fails for the *right reason* only once the first is addressed; check the
failure message says "expected 24, got undefined" and not a type error.

- [ ] **Step 3: Add the input and the conditional spread**

In `buildClaimFrame`'s input type: `guidanceEpoch?: number;`, and in the returned object, beside the
`build` spread:

```ts
    // Guidance attestation (ADR 417) — the stamp in THIS workspace's files. Conditional, unlike
    // `epoch` below: that is a compiled-in constant and always known, this is a filesystem read
    // that legitimately answers "nothing here", and an absent stamp must stay absent on the wire.
    ...(input.guidanceEpoch !== undefined ? { guidance_epoch: input.guidanceEpoch } : {}),
```

- [ ] **Step 4: Wire the callers**

Every site that builds a claim or a heartbeat computes it from the workspace it is claiming FOR —
not from `process.cwd()` unless that is the workspace. Call
`installedGuidanceEpoch(workspaceDir, establishedHarnesses(workspaceDir, harnesses))`.

Read each call site before editing it and confirm which directory is the claiming workspace;
`nativeBridge.ts` in particular may be claiming on behalf of a different folder.

For the heartbeat in `client.ts`: recompute on each heartbeat rather than caching the claim-time
value. Recomputing is the entire point — a mid-session `--refresh-guidance` is exactly the event this
field exists to catch, and a cached value would make the heartbeat a slower copy of the claim.

- [ ] **Step 5: Run the CLI suite**

Run: `cd packages/cli && pnpm vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src
git commit -m "A claiming seat says which guidance it is running, and a heartbeat says so again"
```

---

### Task 5: The HTTP claim mirror

The route `musterd claim` takes. dolly found this mirror silently dropping `model_source` — three
resolved-then-dropped fields on one path — so this task is written on the assumption that the same
hole will swallow `guidance_epoch` unless a test pins it.

**Files:**
- Modify: `packages/server/src/transport/http.ts` (the claim route's body parse)
- Modify: the CLI's HTTP claim sender (find it with
  `grep -rn "claim" packages/cli/src --include=*.ts | grep -i http`)
- Test: `packages/server/src/transport/claim-http.test.ts`

**Coordinate first:** dolly's lane `01M2RTF2D0` is the same repair for `model_source`. If it is in
flight, agree who owns the send path before writing — otherwise you will both fix the same function.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/src/transport/claim-http.test.ts
it('the HTTP claim mirror carries guidance_epoch onto the presence row', async () => {
  const res = await post('/claim', { ...baseBody, guidance_epoch: 23 });
  expect(res.status).toBe(200);
  expect(rosterPresenceFor('izzo').guidance_epoch).toBe(23);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/server && pnpm vitest run src/transport/claim-http.test.ts -t guidance_epoch`
Expected: FAIL — `guidance_epoch` is null on the row, because the route's body schema drops the
unknown key. **This failure is the defect dolly named, reproduced for this field.** Note the null in
the commit message; it is the evidence.

- [ ] **Step 3: Accept it on the route and pass it to the store; send it from the CLI**

- [ ] **Step 4: Run the server and CLI suites**

Run: `cd packages/server && pnpm vitest run && cd ../cli && pnpm vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src packages/cli/src
git commit -m "The HTTP claim mirror stops dropping the guidance epoch on the floor"
```

---

### Task 6: The census becomes a query

The amended acceptance in the spec is *"the nine-worktree census is answerable as a query rather than
a script."* Tasks 1–5 make the data exist; nothing yet lets a human ask. This task is what the
acceptance is actually checked against, so it is not optional dressing.

**Files:**
- Modify: the roster read / `team_members` surface so `guidance_epoch` reaches a reader
- Test: the corresponding transport or MCP test

- [ ] **Step 1: Decide the surface and write the failing test**

Follow whatever shape dolly's #1549 set for `model_source` on `MemberSummarySchema` — one field on
one surface that already exists, not a new command. Two seats inventing two roster shapes for two
attestation fields in the same week is the outcome to avoid.

- [ ] **Step 2: Run it, watch it fail, implement, run it again**

- [ ] **Step 3: Verify against the real thing**

```bash
musterd status --json | jq '[.[] | {name, guidance_epoch: .presence.guidance_epoch}]'
```

(`musterd status --json` is the roster command — verified; there is no `musterd members`.)

Expected: the live nine-seat census in one command. Compare it against the files themselves:

```bash
for d in ~/agents-*/; do
  printf '%-24s %s\n' "$(basename "$d")" \
    "$(grep -ho 'musterd:content v[0-9]*' "$d".claude/skills/musterd/SKILL.md 2>/dev/null | head -1)"
done
```

The query and the files must agree. **If they disagree, the query is wrong** — the files are the
ground truth this whole increment is built on, and a census that argues with them has no standing.

- [ ] **Step 4: Commit**

```bash
git commit -am "Nine worktrees, one query: which seats are running which rules"
```

---

### Task 7: The falsifier, the gates, and the submit

- [ ] **Step 1: Induce the real thing**

With a seat live: run `musterd init --refresh-guidance` in a worktree that is one epoch behind,
confirm the heartbeat moves the roster's `guidance_epoch` forward within one interval. Then check a
worktree that has never been provisioned reads null, not 0.

This is the end-to-end arm this increment can honestly claim. The induced-outage falsifier in the
spec's Testing section belongs to **increment 2** — it tests the receipt reader's states, and there
is no receipt yet. Do not claim it here.

- [ ] **Step 2: Run every gate**

```bash
pnpm build && pnpm -r test && pnpm lint && pnpm format:check
```

`format:check` runs `adr-numbers:check`, `migrations:check`, `guidance:check` and `wiki:check` among
others — the whole docs gate is inside it. Rebuild `packages/protocol` first if you have not;
a stale local dist makes the CLI typecheck lie, which is the lane's other recorded trap.

- [ ] **Step 3: Write the wiki page**

A fact the team learned is a wiki page (`docs/wiki/README.md` for conventions). The page this
increment earns: **a guard that detects disagreement is blind to uniform error** — `composeLine`'s
`behind` state could not fire because every seat on this laptop was repaired by the same stale linked
dist, so all nine were wrong together and consistently. Claims carry dates and falsifiers.

- [ ] **Step 4: Open the PR, then submit the lane**

The PR body states the amended acceptance and what it does NOT buy (visibility, not prevention).
After merge: `lane_submit`, then **do what its reply says** (ADR 235).

**Acceptance routing:** a cross-family reviewer is owed. ryder is opus-5 like this seat, so they cannot
be the acceptor — route to a seat on a different family (dolly and miley are fable-5-1, big-body is
gpt-5.6-luna, ghost is muse-spark) and say in the ask that the grade needs to be real.

---

## Self-review against the spec

- **§3 "One field: `guidance_epoch`"** → Tasks 2–5. The installed-stamp-not-constant ruling is Task 1
  and is restated in the ADR.
- **§3 "makes the lane's acceptance a query"** → Task 6, and its Step 3 checks the query against the
  files rather than against itself.
- **§3 "Deliberately omitted… `seat_knew_it_was_behind`"** → Global Constraints, and written into the
  ADR at Task 2 Step 2 so the next reader does not re-open it.
- **§3 "this is self-reported"** → ADR Consequences, Task 2 Step 2.
- **Increments §1 "Own ADR (protocol change)"** → Task 2, with the number reserved by a push first.
- **Contention §3 "`01M2PAFNAS` … the same field travelling the same route"** → the Sequencing
  section, which makes landing after #1549 a rule rather than a hope.
- **Not in this plan, on purpose:** §1 the receipt, §2 the reader and the `composeLine` states, §4
  the gate. Increment 2 gets its own plan; increment 3 stays unscheduled until this one has produced
  false-positive data.
