# Model Attestation Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a musterd seat attest the model it is actually running, so a wire-time snapshot can never outrank a live observation again.

**Architecture:** Split attestation into two tiers by kind of claim — `observed` (a harness probe, seen this session) beats `declared` (`MUSTERD_MODEL` env, then `binding.model`), newest-wins, falling to `unknown`. Provisioning stops baking `MUSTERD_MODEL` into harness MCP entries. Every harness gets the same `observeModel()` slot, precedence, tripwire, and degradation; only the fidelity behind the slot differs. Increment 2 blocks the mechanism that planted the bad value: an MCP entry written for workspace W must not launch a sibling seat's adapter or carry a foreign grant.

**Tech Stack:** TypeScript (ESM, NodeNext), zod schemas in `@musterd/protocol`, vitest, pnpm workspaces.

**Spec:** [docs/design/model-attestation-truth.md](../../design/model-attestation-truth.md)

## Global Constraints

- **A hook must never fail.** Every code path reachable from `musterd session start|end --stdin` exits 0 — missing stdin, no session_id, no binding, unreadable file, unreachable daemon. Inherited from `packages/cli/src/commands/session.ts:27-29`.
- **Attested, never verified** (ADR 101). No task verifies a model against a provider.
- **Never infer model from MCP `clientInfo`** (ADR 120). The contradiction check is a warning signal only, never a source.
- **Warn-never-block**, with exactly one deliberate exception: Task 9's entry-write refusal.
- **`unknown` is legal** and must never block a claim, a send, or a hook.
- Secrets (`agent_key`, `grant`, session id, transcript path) stay in the gitignored 0600 `binding.json`, never in the committed `workspace.json`, never over the wire.
- Run tests from the **repo root only** (`pnpm test`), never from inside a package directory.
- `pnpm lint` is a separate gate from `pnpm format:check` — run both before pushing.
- Build before typecheck (`pnpm build && pnpm typecheck`) or you get phantom `.d.ts` errors.
- Branch from fresh `origin/main`; PR; `gh pr merge --squash --auto --delete-branch` (ADR 106).

## File Structure

**Increment 1 — attestation truth**

| File                                               | Responsibility                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/protocol/src/binding.ts`                 | Add `model_observed` to `BindingSchema` (modify)                                   |
| `packages/protocol/src/model.ts`                   | Add `resolveAttestation()` — the tier resolver (modify)                            |
| `packages/cli/src/session/transcript-model.ts`     | **Create.** The only module that knows a harness's on-disk transcript format       |
| `packages/cli/src/onboard/harness.ts`              | Add `observeModel?` to the `Harness` interface (modify)                            |
| `packages/cli/src/onboard/harnesses/claudeCode.ts` | `observeModel` via transcript (modify)                                             |
| `packages/cli/src/onboard/harnesses/codex.ts`      | `observeModel` via rollout log (modify)                                            |
| `packages/cli/src/onboard/harnesses/cursor.ts`     | `observeModel` returning `undefined` — the declared gap (modify)                   |
| `packages/cli/src/commands/session.ts`             | Call the probe in `captureSession`, persist `model_observed` (modify)              |
| `packages/mcp/src/config.ts`                       | Resolve `observed > declared > unknown`; `ModelSource` gains `'observed'` (modify) |
| `packages/mcp/src/binding.ts`                      | Merge-guard `model_observed` like `session` (modify)                               |
| `packages/cli/src/onboard/mcpEntry.ts`             | **Delete the `MUSTERD_MODEL` bake** (modify)                                       |
| `packages/cli/src/onboard/doctor.ts`               | Tripwire gains the `observed ≠ declared` case (modify)                             |

**Increment 2 — provisioning identity guard**

| File                                               | Responsibility                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/cli/src/onboard/entryGuard.ts`           | **Create.** Validates an entry against the workspace it is being written for |
| `packages/cli/src/onboard/harness.ts`              | `DetectResult` gains `registeredModel` / `registeredArgs` (modify)           |
| `packages/cli/src/onboard/harnesses/claudeCode.ts` | Read back model + args from `claude mcp get` (modify)                        |
| `packages/cli/src/onboard/doctor.ts`               | Report poisoned existing entries (modify)                                    |

---

### Task 1: `model_observed` on the binding schema

**Files:**

- Modify: `packages/protocol/src/binding.ts:70-84` (`BindingSchema`)
- Test: `packages/protocol/src/binding.test.ts`

**Interfaces:**

- Consumes: nothing (first task).
- Produces: `Binding.model_observed?: { model: string; harness: string; observed_at: number }`, via `ModelObservationSchema` exported from `@musterd/protocol`.

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/binding.test.ts`:

```typescript
import { BindingSchema } from './binding.js';

describe('model_observed', () => {
  it('parses a full observation', () => {
    const b = BindingSchema.parse({
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      surface: 'claude-code',
      model_observed: {
        model: 'claude-opus-4-8',
        harness: 'claude-code',
        observed_at: 1784911286433,
      },
    });
    expect(b.model_observed?.model).toBe('claude-opus-4-8');
  });

  it('is optional — an existing binding without it still parses', () => {
    const b = BindingSchema.parse({
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      surface: 'claude-code',
    });
    expect(b.model_observed).toBeUndefined();
  });

  it('is stripped from the committed workspace spec', () => {
    const spec = WorkspaceSpecSchema.parse({
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      surface: 'claude-code',
      model_observed: { model: 'claude-opus-4-8', harness: 'claude-code', observed_at: 1 },
    });
    expect('model_observed' in spec).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/protocol/src/binding.test.ts`
Expected: FAIL — `model_observed` is stripped by `BindingSchema` (zod drops unknown keys), so `b.model_observed` is `undefined` in the first test.

- [ ] **Step 3: Write minimal implementation**

In `packages/protocol/src/binding.ts`, above `BindingSchema`:

```typescript
/**
 * A model **observation** (ADR: model attestation truth) — what a harness was seen running this
 * session, as opposed to `model`, which is what a human or config *declares*. Written ONLY by the
 * SessionStart hook via `musterd session start --stdin`; per-machine like `session`, so it is kept
 * out of the committed `workspace.json`.
 *
 * Deliberately NOT merged into `model`: an observation that overwrote a declaration would launder
 * itself into one on the next session (the field's epistemic status becomes unknowable), and the
 * `observed ≠ declared` tripwire — the metric for how often provisioning snapshots rot — would have
 * nothing left to compare.
 */
export const ModelObservationSchema = z.object({
  /** The model id the harness reported. Attested, never verified. */
  model: z.string().min(1).max(120),
  /** Harness class that produced it (`claude-code`, `codex`) — which probe to trust it from. */
  harness: z.string().min(1).max(40),
  /** Epoch ms of the observation; newest-wins against a prior observation. */
  observed_at: z.number().int(),
});

export type ModelObservation = z.infer<typeof ModelObservationSchema>;
```

Then add to `BindingSchema.extend({...})`, after `model`:

```typescript
  /** The hook-observed model (see {@link ModelObservationSchema}) — outranks `model` at attestation
   *  time. Local-only and per-machine, like `session`. */
  model_observed: ModelObservationSchema.optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/protocol/src/binding.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/binding.ts packages/protocol/src/binding.test.ts
git commit -m "feat(protocol): add model_observed to the workspace binding"
```

---

### Task 2: The tier resolver

**Files:**

- Modify: `packages/protocol/src/model.ts` (add after `resolveAttestedModel`)
- Test: `packages/protocol/src/model.test.ts`

**Interfaces:**

- Consumes: `ModelObservation` from Task 1.
- Produces: `resolveAttestation(input: AttestationInput): AttestationResult` where

```typescript
export interface AttestationInput {
  observed?: ModelObservation | undefined;
  env?: string | undefined; // MUSTERD_MODEL / ANTHROPIC_MODEL, already resolved
  binding?: string | undefined; // binding.model
}
export interface AttestationResult {
  model: string | undefined; // undefined ⇒ unknown
  source: 'observed' | 'environment' | 'binding' | 'unknown';
  /** True when an observation contradicts a declaration — the tripwire signal. */
  drift: boolean;
  /** The declared value that lost to an observation, for the tripwire message. */
  declared?: string | undefined;
}
```

- [ ] **Step 1: Write the failing test**

Add to `packages/protocol/src/model.test.ts`:

```typescript
import { resolveAttestation } from './model.js';

const obs = (model: string) => ({ model, harness: 'claude-code', observed_at: 1 });

describe('resolveAttestation', () => {
  it('prefers an observation over both declarations', () => {
    const r = resolveAttestation({
      observed: obs('claude-opus-4-8'),
      env: 'grok-4.5',
      binding: 'grok-4.5',
    });
    expect(r).toEqual({
      model: 'claude-opus-4-8',
      source: 'observed',
      drift: true,
      declared: 'grok-4.5',
    });
  });

  it('does not report drift when the observation agrees', () => {
    const r = resolveAttestation({ observed: obs('claude-opus-4-8'), env: 'claude-opus-4-8' });
    expect(r.drift).toBe(false);
  });

  it('does not report drift when nothing was declared', () => {
    const r = resolveAttestation({ observed: obs('claude-opus-4-8') });
    expect(r).toEqual({
      model: 'claude-opus-4-8',
      source: 'observed',
      drift: false,
      declared: undefined,
    });
  });

  it('falls back to env, then binding', () => {
    expect(resolveAttestation({ env: 'grok-4.5', binding: 'x' }).source).toBe('environment');
    expect(resolveAttestation({ binding: 'grok-4.5' })).toEqual({
      model: 'grok-4.5',
      source: 'binding',
      drift: false,
      declared: undefined,
    });
  });

  it('degrades to unknown', () => {
    expect(resolveAttestation({})).toEqual({
      model: undefined,
      source: 'unknown',
      drift: false,
      declared: undefined,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/protocol/src/model.test.ts`
Expected: FAIL — `resolveAttestation is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/protocol/src/model.ts`:

```typescript
/** Which tier supplied the attested model. `observed` outranks both declarations. */
export type AttestationSource = 'observed' | 'environment' | 'binding' | 'unknown';

export interface AttestationInput {
  observed?: ModelObservation | undefined;
  env?: string | undefined;
  binding?: string | undefined;
}

export interface AttestationResult {
  model: string | undefined;
  source: AttestationSource;
  drift: boolean;
  declared?: string | undefined;
}

/**
 * Resolve what this session should attest, by **kind of claim**: an observation (what a harness was
 * seen running) always beats a declaration (what a human or config says), which beats `unknown`.
 *
 * This inverts the defect the ADR exists for — a wire-time snapshot sitting above every later
 * observation. `drift` is true only when an observation and a declaration disagree: that is the
 * tripwire signal, and the rate at which it fires measures how often provisioning snapshots rot.
 */
export function resolveAttestation(input: AttestationInput): AttestationResult {
  const declared = input.env ?? input.binding;
  if (input.observed) {
    return {
      model: input.observed.model,
      source: 'observed',
      drift: declared !== undefined && declared !== input.observed.model,
      declared,
    };
  }
  if (input.env)
    return { model: input.env, source: 'environment', drift: false, declared: undefined };
  if (input.binding)
    return { model: input.binding, source: 'binding', drift: false, declared: undefined };
  return { model: undefined, source: 'unknown', drift: false, declared: undefined };
}
```

Add the import at the top of the file:

```typescript
import type { ModelObservation } from './binding.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/protocol/src/model.test.ts`
Expected: PASS (5 new tests, existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/model.ts packages/protocol/src/model.test.ts
git commit -m "feat(protocol): resolveAttestation — observation beats declaration"
```

---

### Task 3: The transcript reader

**Files:**

- Create: `packages/cli/src/session/transcript-model.ts`
- Test: `packages/cli/src/session/transcript-model.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `readModelFromTranscript(path: string): string | undefined`.

This is the **only** module that knows a harness's on-disk format. The path is a documented hook input; the format is not. Every failure returns `undefined`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/session/transcript-model.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readModelFromTranscript } from './transcript-model.js';

function fixture(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-transcript-'));
  const p = join(dir, 'transcript.jsonl');
  writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

const assistant = (model: string) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', model } });

describe('readModelFromTranscript', () => {
  it('reads the model from the last assistant message', () => {
    const p = fixture([
      assistant('claude-sonnet-5'),
      JSON.stringify({ type: 'user' }),
      assistant('claude-opus-4-8'),
    ]);
    expect(readModelFromTranscript(p)).toBe('claude-opus-4-8');
  });

  it('ignores a synthetic <synthetic> model', () => {
    const p = fixture([assistant('claude-opus-4-8'), assistant('<synthetic>')]);
    expect(readModelFromTranscript(p)).toBe('claude-opus-4-8');
  });

  it('tolerates a truncated final line (mid-write)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-transcript-'));
    const p = join(dir, 't.jsonl');
    writeFileSync(p, assistant('claude-opus-4-8') + '\n{"type":"assist', 'utf8');
    expect(readModelFromTranscript(p)).toBe('claude-opus-4-8');
  });

  it('returns undefined for an empty file', () => {
    expect(readModelFromTranscript(fixture([]))).toBeUndefined();
  });

  it('returns undefined when no line carries a model (format moved)', () => {
    const p = fixture([JSON.stringify({ type: 'assistant', message: { role: 'assistant' } })]);
    expect(readModelFromTranscript(p)).toBeUndefined();
  });

  it('returns undefined for a missing file rather than throwing', () => {
    expect(readModelFromTranscript('/nonexistent/nope.jsonl')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/cli/src/session/transcript-model.test.ts`
Expected: FAIL — cannot resolve `./transcript-model.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/session/transcript-model.ts`:

```typescript
import { readFileSync, statSync } from 'node:fs';

/**
 * The single place that knows a harness transcript's on-disk shape (ADR: model attestation truth).
 *
 * The harness hands a hook `transcript_path` on stdin — a documented input — but the file's *format*
 * is not documented and can move without notice. Isolating the parse here means a format change
 * degrades this whole feature to `undefined` (i.e. back to declaration-only attestation) instead of
 * breaking a hook. Every failure path returns `undefined`; this function never throws.
 */

/** Cap the tail we read: transcripts grow unbounded, and the newest model is always at the end. */
const TAIL_BYTES = 256 * 1024;

/** Claude Code writes this in place of a model id for synthetic//-command turns — not a real model. */
const SYNTHETIC = '<synthetic>';

export function readModelFromTranscript(path: string): string | undefined {
  let raw: string;
  try {
    const size = statSync(path).size;
    if (size === 0) return undefined;
    const fd = readFileSync(path);
    raw = fd.subarray(Math.max(0, size - TAIL_BYTES)).toString('utf8');
  } catch {
    return undefined; // missing, unreadable, a directory — a hook must never fail
  }
  const lines = raw.split('\n');
  // Walk backwards: the newest assistant turn wins (a session can switch models mid-run).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // truncated head (we sliced mid-line) or tail (mid-write) — skip, never fail
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const message = (parsed as Record<string, unknown>)['message'];
    if (typeof message !== 'object' || message === null) continue;
    const model = (message as Record<string, unknown>)['model'];
    if (typeof model !== 'string' || model === '' || model === SYNTHETIC) continue;
    return model.slice(0, 120);
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/cli/src/session/transcript-model.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/session/transcript-model.ts packages/cli/src/session/transcript-model.test.ts
git commit -m "feat(cli): transcript-model — the isolated harness format reader"
```

---

### Task 4: The `observeModel` slot on every harness

**Files:**

- Modify: `packages/cli/src/onboard/harness.ts` (the `Harness` interface, after `unprovision`)
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts` (the exported harness object, near `surface: 'claude-code'` at line 424)
- Modify: `packages/cli/src/onboard/harnesses/codex.ts` (near `surface: 'codex'` at line 44)
- Modify: `packages/cli/src/onboard/harnesses/cursor.ts` (near `surface: 'cursor'` at line 40)
- Test: `packages/cli/src/onboard/harnesses/observeModel.test.ts`

**Interfaces:**

- Consumes: `readModelFromTranscript` (Task 3).
- Produces: `Harness.observeModel?: (payload: ModelObservationInput) => string | undefined`, where

```typescript
export interface ModelObservationInput {
  transcript_path?: string | undefined;
  session_id?: string | undefined;
}
```

Every harness declares the slot. This is the even-contract guarantee: same signature, same never-throw rule, same `undefined` degradation. Only fidelity differs.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/onboard/harnesses/observeModel.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeHarness } from './claudeCode.js';
import { codexHarness } from './codex.js';
import { cursorHarness } from './cursor.js';

describe('observeModel — even contract', () => {
  it('every harness declares the slot', () => {
    for (const h of [claudeCodeHarness, codexHarness, cursorHarness]) {
      expect(typeof h.observeModel).toBe('function');
    }
  });

  it('every harness returns undefined for an empty payload, never throws', () => {
    for (const h of [claudeCodeHarness, codexHarness, cursorHarness]) {
      expect(h.observeModel?.({})).toBeUndefined();
    }
  });

  it('claude-code observes from the transcript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-obs-'));
    const p = join(dir, 't.jsonl');
    writeFileSync(p, JSON.stringify({ message: { model: 'claude-opus-4-8' } }) + '\n', 'utf8');
    expect(claudeCodeHarness.observeModel?.({ transcript_path: p })).toBe('claude-opus-4-8');
  });

  it('cursor declares its gap explicitly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-obs-'));
    const p = join(dir, 't.jsonl');
    writeFileSync(p, JSON.stringify({ message: { model: 'claude-opus-4-8' } }) + '\n', 'utf8');
    expect(cursorHarness.observeModel?.({ transcript_path: p })).toBeUndefined();
  });
});
```

Check the exported names first — if the harness objects are exported under different identifiers, use those:

```bash
grep -n "^export const" packages/cli/src/onboard/harnesses/{claudeCode,codex,cursor}.ts
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/cli/src/onboard/harnesses/observeModel.test.ts`
Expected: FAIL — `h.observeModel` is `undefined`, so `typeof` is `"undefined"`.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/onboard/harness.ts`, add above `export interface Harness`:

```typescript
/** What a harness gets to work with when observing its own session's model. */
export interface ModelObservationInput {
  /** Absolute transcript path as the harness reported it on hook stdin, if it reports one. */
  transcript_path?: string | undefined;
  /** The harness session id, for harnesses that key their own logs by it. */
  session_id?: string | undefined;
}
```

Add to the `Harness` interface:

```typescript
  /**
   * Observe the model this harness is *actually* running for the current session (ADR: model
   * attestation truth). An observation outranks any declaration, so this is the tier that stops a
   * wire-time snapshot from lying forever.
   *
   * Even contract: every harness declares this slot with the same signature, the same never-throw
   * rule, and the same `undefined` degradation. Fidelity behind it differs because harnesses differ
   * — that is a property of the harness, not a difference in musterd's guarantees. `undefined` means
   * "this harness cannot tell us right now", which is honest and falls back to the declared tier.
   *
   * MUST NOT throw: this runs inside a hook.
   */
  observeModel?: (payload: ModelObservationInput) => string | undefined;
```

In `claudeCode.ts`, add to the harness object:

```typescript
  // Claude Code hands its hooks a `transcript_path`; the newest assistant turn carries the real id.
  observeModel: (payload) =>
    payload.transcript_path ? readModelFromTranscript(payload.transcript_path) : undefined,
```

with the import:

```typescript
import { readModelFromTranscript } from '../../session/transcript-model.js';
```

In `codex.ts`:

```typescript
  // Codex rollout logs use the same JSONL-with-a-model shape; when musterd spawns Codex itself the
  // model is already authoritative from the spawn arguments and never needs this path.
  observeModel: (payload) =>
    payload.transcript_path ? readModelFromTranscript(payload.transcript_path) : undefined,
```

with the same import.

In `cursor.ts`:

```typescript
  // Cursor exposes no per-session record we can read and runs no hooks, so there is nothing to
  // observe. A declared, visible gap: this seat falls back to the declared tier and the doctor says
  // so, rather than a silent pretence of knowledge.
  observeModel: () => undefined,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/cli/src/onboard/harnesses/observeModel.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard/harness.ts packages/cli/src/onboard/harnesses/
git commit -m "feat(cli): observeModel slot on every harness — the even contract"
```

---

### Task 5: The hook writes the observation

**Files:**

- Modify: `packages/cli/src/commands/session.ts:107-138` (`captureSession`)
- Test: `packages/cli/src/commands/session.test.ts`

**Interfaces:**

- Consumes: `Harness.observeModel` (Task 4), `ModelObservationSchema` (Task 1).
- Produces: `binding.model_observed` written on `SessionStart`.

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/src/commands/session.test.ts` (follow the file's existing workspace-fixture helper; it already builds a temp `.musterd/binding.json` for capture tests):

```typescript
it('records the observed model on session start', async () => {
  const dir = makeWorkspace({ surface: 'claude-code', model: 'grok-4.5' });
  const transcript = join(dir, 't.jsonl');
  writeFileSync(
    transcript,
    JSON.stringify({ message: { model: 'claude-opus-4-8' } }) + '\n',
    'utf8',
  );

  await captureSession('start', { session_id: 's1', transcript_path: transcript, cwd: dir });

  const binding = JSON.parse(readFileSync(join(dir, '.musterd/binding.json'), 'utf8'));
  expect(binding.model_observed.model).toBe('claude-opus-4-8');
  expect(binding.model_observed.harness).toBe('claude-code');
  expect(binding.model).toBe('grok-4.5'); // the declaration is preserved, not overwritten
});

it('leaves model_observed absent when the transcript yields nothing', async () => {
  const dir = makeWorkspace({ surface: 'claude-code' });
  await captureSession('start', { session_id: 's1', transcript_path: '/nope.jsonl', cwd: dir });
  const binding = JSON.parse(readFileSync(join(dir, '.musterd/binding.json'), 'utf8'));
  expect(binding.model_observed).toBeUndefined();
  expect(binding.session.id).toBe('s1'); // capture still succeeded
});

it('keeps a prior observation when a later session observes nothing', async () => {
  const dir = makeWorkspace({ surface: 'claude-code' });
  const transcript = join(dir, 't.jsonl');
  writeFileSync(
    transcript,
    JSON.stringify({ message: { model: 'claude-opus-4-8' } }) + '\n',
    'utf8',
  );
  await captureSession('start', { session_id: 's1', transcript_path: transcript, cwd: dir });
  await captureSession('start', { session_id: 's2', transcript_path: '/nope.jsonl', cwd: dir });
  const binding = JSON.parse(readFileSync(join(dir, '.musterd/binding.json'), 'utf8'));
  expect(binding.model_observed.model).toBe('claude-opus-4-8');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/cli/src/commands/session.test.ts`
Expected: FAIL — `binding.model_observed` is `undefined` in the first test.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/commands/session.ts`, inside `captureSession`, replace the single `saveBinding(dir, { ...binding, session });` call with:

```typescript
// The observation (ADR: model attestation truth). Best-effort and additive: a harness that cannot
// observe, or a transcript that is missing/moved, leaves any prior observation in place rather
// than erasing it — losing a good observation to a bad read would re-open the lie.
const observedModel = event === 'start' ? observeModelFor(CAPTURE_HARNESS, payload) : undefined;
const model_observed = observedModel
  ? { model: observedModel, harness: CAPTURE_HARNESS, observed_at: Date.now() }
  : binding.model_observed;

saveBinding(dir, {
  ...binding,
  session,
  ...(model_observed ? { model_observed } : {}),
});
```

Add the helper above `captureSession` in the same file:

```typescript
/**
 * Ask the harness that owns this capture to observe its model. Never throws — a probe failure must
 * not fail a hook, and `undefined` simply falls through to the declared tier.
 */
function observeModelFor(harnessId: string, payload: HookPayload): string | undefined {
  try {
    const harness = HARNESSES.find((h) => h.id === harnessId);
    return harness?.observeModel?.({
      ...(payload.transcript_path ? { transcript_path: payload.transcript_path } : {}),
      ...(payload.session_id ? { session_id: payload.session_id } : {}),
    });
  } catch {
    return undefined;
  }
}
```

Import the registry (confirm the exported name with `grep -n "export" packages/cli/src/onboard/harnesses/index.ts`):

```typescript
import { HARNESSES } from '../onboard/harnesses/index.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/cli/src/commands/session.test.ts`
Expected: PASS (3 new tests, existing capture tests still green).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/session.ts packages/cli/src/commands/session.test.ts
git commit -m "feat(cli): SessionStart hook records the observed model"
```

---

### Task 6: The adapter attests the observation

**Files:**

- Modify: `packages/mcp/src/config.ts:15-16` (`ModelSource`), `:130-135` and `:150-160` (the resolution + return)
- Modify: `packages/mcp/src/binding.ts:168-184` (`saveBinding` merge guard)
- Test: `packages/mcp/src/config.test.ts`, `packages/mcp/src/binding.test.ts`

**Interfaces:**

- Consumes: `resolveAttestation` (Task 2), `binding.model_observed` (Task 5).
- Produces: `McpConfig.model` now reflects the observation; `McpConfig.modelSource` gains `'observed'`; `McpConfig.modelDrift?: { declared: string; observed: string }`.

- [ ] **Step 1: Write the failing test**

Add to `packages/mcp/src/config.test.ts` (follow the file's existing binding-fixture helper):

```typescript
it('attests the observation over a stale env declaration', () => {
  writeBinding({
    model: 'grok-4.5',
    model_observed: { model: 'claude-opus-4-8', harness: 'claude-code', observed_at: 1 },
  });
  const config = loadMcpConfig({ ...baseEnv, MUSTERD_MODEL: 'grok-4.5' });
  expect(config.model).toBe('claude-opus-4-8');
  expect(config.modelSource).toBe('observed');
  expect(config.modelDrift).toEqual({ declared: 'grok-4.5', observed: 'claude-opus-4-8' });
});

it('reports no drift when observation and declaration agree', () => {
  writeBinding({
    model: 'claude-opus-4-8',
    model_observed: { model: 'claude-opus-4-8', harness: 'claude-code', observed_at: 1 },
  });
  const config = loadMcpConfig(baseEnv);
  expect(config.modelDrift).toBeUndefined();
});

it('still honours a declaration when there is no observation', () => {
  writeBinding({ model: 'grok-4.5' });
  const config = loadMcpConfig(baseEnv);
  expect(config.model).toBe('grok-4.5');
  expect(config.modelSource).toBe('binding');
});
```

Add to `packages/mcp/src/binding.test.ts`:

```typescript
it('carries model_observed through a rebuild-from-boot-config save', () => {
  const dir = makeWorkspaceDir();
  saveBinding(dir, {
    server: 's',
    team: 't',
    surface: 'claude-code',
    model_observed: { model: 'claude-opus-4-8', harness: 'claude-code', observed_at: 1 },
  });
  // The adapter rebuilds from boot-time config, which never carries an observation.
  saveBinding(dir, { server: 's', team: 't', surface: 'claude-code' });
  const onDisk = JSON.parse(readFileSync(join(dir, '.musterd/binding.json'), 'utf8'));
  expect(onDisk.model_observed.model).toBe('claude-opus-4-8');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/mcp/src/config.test.ts packages/mcp/src/binding.test.ts`
Expected: FAIL — `config.model` is `'grok-4.5'`; `onDisk.model_observed` is `undefined` (the adapter's rebuild wipes it — this is the exact clobber shape that defeated the manual fix in §1 of the spec).

- [ ] **Step 3: Write minimal implementation**

In `packages/mcp/src/binding.ts`, extend the merge guard (it currently carries `session` only):

```typescript
const onDisk = readBinding(p);
// Carry hook-written fields through a rebuild-from-boot-config save. The adapter builds its
// binding from boot-time config, which never carries `session` or `model_observed`; without this
// guard every autojoin would erase the hook's observation moments after it was written — the ADR
// 101 model-wipe shape, and exactly why hand-editing binding.json could never fix a stale model.
const merged: Binding = {
  ...binding,
  ...(binding.session === undefined && onDisk?.session !== undefined
    ? { session: onDisk.session }
    : {}),
  ...(binding.model_observed === undefined && onDisk?.model_observed !== undefined
    ? { model_observed: onDisk.model_observed }
    : {}),
};
```

In `packages/mcp/src/config.ts`, change `ModelSource` and the resolution:

```typescript
/** Where this adapter obtained its model. `observed` outranks both declarations; `unknown` is legal. */
export type ModelSource = 'observed' | 'environment' | 'binding' | 'unknown';
```

Add to `McpConfig`:

```typescript
  /** Set when an observation contradicted a declaration — the tripwire signal (never blocks). */
  modelDrift?: { declared: string; observed: string } | undefined;
```

Replace the `declaredModel` / `modelSource` block:

```typescript
// Attestation (ADR: model attestation truth). An observation — what the harness was *seen*
// running, written by the SessionStart hook — outranks any declaration, because a declaration is
// a snapshot and snapshots rot. Env still beats binding.json within the declared tier.
const attestation = resolveAttestation({
  observed: binding?.model_observed,
  env: resolveModel(env),
  binding: binding?.model,
});
```

and the corresponding fields in the returned object:

```typescript
    model: attestation.model,
    modelSource: attestation.source,
    ...(attestation.drift && attestation.declared
      ? { modelDrift: { declared: attestation.declared, observed: attestation.model! } }
      : {}),
```

Import it:

```typescript
import { resolveAttestation } from '@musterd/protocol';
```

Confirm `resolveAttestation` is re-exported from the protocol package index; if not, add it:

```bash
grep -n "model.js" packages/protocol/src/index.ts
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/mcp/src/config.test.ts packages/mcp/src/binding.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/config.ts packages/mcp/src/binding.ts packages/mcp/src/config.test.ts packages/mcp/src/binding.test.ts
git commit -m "feat(mcp): attest the observed model, preserve it across binding rebuilds"
```

---

### Task 7: Stop baking `MUSTERD_MODEL`

**Files:**

- Modify: `packages/cli/src/onboard/mcpEntry.ts:24-27` (drop `model` from `AgentBinding`), `:41-50` (`buildMcpEnv`)
- Test: `packages/cli/src/onboard/mcpEntry.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `buildMcpEnv()` no longer emits `MUSTERD_MODEL`. Callers passing `model` must be updated — find them with `grep -rn "model" packages/cli/src/commands/agent.ts packages/cli/src/onboard/init.ts`.

This is the regression guard: the test below is what stops this bug returning.

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/src/onboard/mcpEntry.test.ts`:

```typescript
it('never bakes MUSTERD_MODEL — a wire-time snapshot must not outrank a live observation', () => {
  const env = buildMcpEnv({
    server: 'http://127.0.0.1:4849',
    team: 'revive',
    surface: 'claude-code',
    claim: { mode: 'seat', name: 'ryder' },
  } as AgentBinding);
  expect(env).not.toHaveProperty('MUSTERD_MODEL');
});

it('still bakes the fields that are not observable', () => {
  const env = buildMcpEnv({
    server: 'http://127.0.0.1:4849',
    team: 'revive',
    surface: 'claude-code',
    agent_key: 'mskey_x',
    claim: { mode: 'seat', name: 'ryder' },
  } as AgentBinding);
  expect(env.MUSTERD_SERVER).toBe('http://127.0.0.1:4849');
  expect(env.MUSTERD_SURFACE).toBe('claude-code');
  expect(env.MUSTERD_AGENT_KEY).toBe('mskey_x');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/cli/src/onboard/mcpEntry.test.ts`
Expected: The first test PASSES only if no `model` is passed — so also add a case proving the bake is gone even when a model is supplied. Replace the first test's binding with one carrying `model: 'grok-4.5'` cast through `as unknown as AgentBinding`; then it FAILS with `expected { MUSTERD_MODEL: 'grok-4.5', … } not to have property 'MUSTERD_MODEL'`.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/onboard/mcpEntry.ts`, delete the `model` field from `AgentBinding` (lines 24-27) and delete this line from `buildMcpEnv`:

```typescript
    ...(b.model !== undefined ? { MUSTERD_MODEL: b.model } : {}),
```

Extend the existing `buildMcpEnv` doc comment, which already makes this argument for `MUSTERD_CLAIM`:

```typescript
 * The same reasoning retired `MUSTERD_MODEL` (ADR: model attestation truth). A model is a *harness*
 * fact that changes with no musterd action at all, so a baked copy began rotting the moment it was
 * written — and sat at the TOP of the adapter's ladder, where no later observation could correct it.
 * One seat attested `grok-4.5` for weeks while running `claude-opus-4-8`. The model now comes from
 * an observation (the SessionStart hook) or `binding.model`; `MUSTERD_MODEL` remains a supported
 * *manual* override for headless/CI, it just isn't materialized by default provisioning.
```

Then fix the callers surfaced by the grep above: drop `model` from the object literals they pass. Keep writing `binding.model` where they already do — the binding is the declared tier and stays.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/cli/src/onboard/ && pnpm build && pnpm typecheck`
Expected: PASS; typecheck clean (it catches any caller still passing `model`).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard/
git commit -m "fix(cli): stop baking MUSTERD_MODEL into harness MCP entries"
```

---

### Task 8: The `observed ≠ declared` tripwire

**Files:**

- Modify: `packages/cli/src/onboard/doctor.ts:145-165` (the model-declaration check)
- Test: `packages/cli/src/onboard/doctor.test.ts`

**Interfaces:**

- Consumes: `binding.model_observed`, `binding.model` (Tasks 1/5).
- Produces: a drift line from `inspectProvisioning`, naming the stale knob and where it lives.

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/src/onboard/doctor.test.ts`:

```typescript
it('flags a declaration contradicted by an observation, naming both', async () => {
  const dir = makeWorkspace({
    surface: 'claude-code',
    model: 'grok-4.5',
    model_observed: { model: 'claude-opus-4-8', harness: 'claude-code', observed_at: 1 },
  });
  const report = await inspectProvisioning(dir);
  const line = report.drift.find((d) => d.includes('claude-opus-4-8'));
  expect(line).toBeDefined();
  expect(line).toContain('grok-4.5');
  expect(line).toContain('binding.json');
});

it('says nothing when the declaration agrees with the observation', async () => {
  const dir = makeWorkspace({
    surface: 'claude-code',
    model: 'claude-opus-4-8',
    model_observed: { model: 'claude-opus-4-8', harness: 'claude-code', observed_at: 1 },
  });
  const report = await inspectProvisioning(dir);
  expect(report.drift.find((d) => d.includes('model'))).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/cli/src/onboard/doctor.test.ts`
Expected: FAIL — no drift line mentions `claude-opus-4-8`.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/onboard/doctor.ts`, inside `inspectProvisioning` where `drift` is assembled, add:

```typescript
// The tripwire this ADR exists for. #273 only caught an *absent* declaration; a confidently wrong
// one looked identical to a correct one, which is the mode that poisons ADR 056 diversity
// conclusions while looking healthy. Compare the two tiers and name the knob that lies.
if (binding?.model_observed && binding.model && binding.model !== binding.model_observed.model) {
  drift.push(
    `this workspace declares model "${binding.model}" but its ${binding.model_observed.harness} ` +
      `session was observed running "${binding.model_observed.model}" — the observation is what ` +
      `gets attested; fix or remove the stale declaration in .musterd/binding.json`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/cli/src/onboard/doctor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard/doctor.ts packages/cli/src/onboard/doctor.test.ts
git commit -m "feat(cli): tripwire fires when an observation contradicts a declaration"
```

---

### Task 9: The provisioning identity guard (increment 2)

**Files:**

- Create: `packages/cli/src/onboard/entryGuard.ts`
- Create: `packages/cli/src/onboard/entryGuard.test.ts`
- Modify: `packages/cli/src/onboard/mcpEntry.ts` (call the guard from `buildEntry`)

**Interfaces:**

- Consumes: `McpServerEntry`, `AgentBinding` (`mcpEntry.ts`).
- Produces: `assertEntryIdentity(entry: McpServerEntry, opts: EntryIdentityOpts): void` — throws `EntryIdentityError` on violation, where

```typescript
export interface EntryIdentityOpts {
  /** Absolute path of the workspace this entry is being written for. */
  workspaceDir: string;
  /** The binding that workspace holds, if any — its secrets must match the entry's. */
  binding?: { agent_key?: string | undefined; grant?: string | undefined } | undefined;
  /** Sibling seat worktrees to reject paths into. Defaults to the workspace's parent's children. */
  siblingDirs?: string[] | undefined;
}
```

This is the one deliberate block in the design. It refuses rather than warns because the failure is silent, cross-seat, and produced a lie that survived weeks; the cost of a refusal is re-running one provisioning command.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/onboard/entryGuard.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { assertEntryIdentity, EntryIdentityError } from './entryGuard.js';

const entry = (adapterPath: string, env: Record<string, string> = {}) => ({
  command: '/usr/bin/node',
  args: [adapterPath],
  env: { MUSTERD_SERVER: 'http://127.0.0.1:4849', ...env },
});

describe('assertEntryIdentity', () => {
  it('accepts an adapter inside the target workspace', () => {
    expect(() =>
      assertEntryIdentity(entry('/Users/x/agents-ryder/packages/mcp/dist/index.js'), {
        workspaceDir: '/Users/x/agents-ryder',
      }),
    ).not.toThrow();
  });

  it('accepts a shared global install', () => {
    expect(() =>
      assertEntryIdentity(entry('/opt/homebrew/lib/node_modules/@musterd/mcp/dist/index.js'), {
        workspaceDir: '/Users/x/agents-ryder',
        siblingDirs: ['/Users/x/agents-miley'],
      }),
    ).not.toThrow();
  });

  it('refuses an adapter inside a sibling seat worktree', () => {
    expect(() =>
      assertEntryIdentity(entry('/Users/x/agents-miley/packages/mcp/dist/index.js'), {
        workspaceDir: '/Users/x/agents-ryder',
        siblingDirs: ['/Users/x/agents-miley'],
      }),
    ).toThrow(EntryIdentityError);
  });

  it('names both workspaces in the refusal', () => {
    try {
      assertEntryIdentity(entry('/Users/x/agents-miley/packages/mcp/dist/index.js'), {
        workspaceDir: '/Users/x/agents-ryder',
        siblingDirs: ['/Users/x/agents-miley'],
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('agents-miley');
      expect((e as Error).message).toContain('agents-ryder');
    }
  });

  it('refuses a grant that does not match the workspace binding', () => {
    expect(() =>
      assertEntryIdentity(
        entry('/Users/x/agents-ryder/packages/mcp/dist/index.js', { MUSTERD_GRANT: 'msgr_other' }),
        { workspaceDir: '/Users/x/agents-ryder', binding: { grant: 'msgr_mine' } },
      ),
    ).toThrow(/grant/);
  });

  it('allows an entry whose grant matches', () => {
    expect(() =>
      assertEntryIdentity(
        entry('/Users/x/agents-ryder/packages/mcp/dist/index.js', { MUSTERD_GRANT: 'msgr_mine' }),
        { workspaceDir: '/Users/x/agents-ryder', binding: { grant: 'msgr_mine' } },
      ),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/cli/src/onboard/entryGuard.test.ts`
Expected: FAIL — cannot resolve `./entryGuard.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/cli/src/onboard/entryGuard.ts`:

```typescript
import { relative, resolve, sep } from 'node:path';

/**
 * The provisioning identity guard (ADR: model attestation truth, increment 2).
 *
 * `resolveMcpLaunch()` resolves the adapter path from the *provisioning process's* own location, so
 * provisioning seat A's folder by running seat B's CLI wires A to launch B's adapter permanently.
 * Found in the wild: ryder's folder launching `/Users/nick/agents-miley/…/mcp/dist/index.js`, with a
 * grant from a different provisioning run. That is what planted the stale model this ADR removes —
 * fixing only the precedence ladder would leave the planting mechanism intact.
 *
 * This is the one place musterd blocks rather than warns. The failure is silent, cross-seat, and
 * survived weeks undetected; the cost of a refusal is re-running one provisioning command.
 */
export class EntryIdentityError extends Error {}

export interface EntryIdentityOpts {
  workspaceDir: string;
  binding?: { agent_key?: string | undefined; grant?: string | undefined } | undefined;
  siblingDirs?: string[] | undefined;
}

/** Is `child` inside `parent` (or the same path)? Path-segment aware, so `/a/bc` is not in `/a/b`.
 *  Exported because Task 10's doctor check needs exactly this comparison — one definition, not two. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

export function assertEntryIdentity(
  entry: { args: string[]; env: Record<string, string> },
  opts: EntryIdentityOpts,
): void {
  const adapter = entry.args[entry.args.length - 1];
  if (adapter) {
    for (const sibling of opts.siblingDirs ?? []) {
      if (isInside(adapter, sibling) && !isInside(adapter, opts.workspaceDir)) {
        throw new EntryIdentityError(
          `refusing to wire ${opts.workspaceDir}: the adapter path ${adapter} lives inside another ` +
            `seat's workspace (${sibling}). Re-run provisioning from ${opts.workspaceDir} (or with a ` +
            `shared install) so this seat launches its own adapter.`,
        );
      }
    }
  }
  const entryGrant = entry.env['MUSTERD_GRANT'];
  if (entryGrant && opts.binding?.grant && entryGrant !== opts.binding.grant) {
    throw new EntryIdentityError(
      `refusing to wire ${opts.workspaceDir}: the entry carries a grant that does not match this ` +
        `workspace's binding — it belongs to a different provisioning run. Re-mint with ` +
        `\`musterd agent <seat> --path ${opts.workspaceDir}\`.`,
    );
  }
  const entryKey = entry.env['MUSTERD_AGENT_KEY'];
  if (entryKey && opts.binding?.agent_key && entryKey !== opts.binding.agent_key) {
    throw new EntryIdentityError(
      `refusing to wire ${opts.workspaceDir}: the entry's agent key does not match this workspace's ` +
        `binding — it belongs to a different team or provisioning run.`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/cli/src/onboard/entryGuard.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard/entryGuard.ts packages/cli/src/onboard/entryGuard.test.ts
git commit -m "feat(cli): entry identity guard — refuse cross-seat adapter paths and grants"
```

---

### Task 10: Find already-poisoned entries

**Files:**

- Modify: `packages/cli/src/onboard/harness.ts` (`DetectResult`)
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts:440-455` (the `claude mcp get` read-back)
- Modify: `packages/cli/src/onboard/doctor.ts` (report on the read-back)
- Test: `packages/cli/src/onboard/doctor.test.ts`

**Interfaces:**

- Consumes: `DetectResult.registeredClaim`'s existing read-back pattern.
- Produces: `DetectResult.registeredModel?: string`, `DetectResult.registeredArgs?: string[]`.

The guard in Task 9 stops new poisonings; this finds the ones already written. There may be more than the one I found by hand.

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/src/onboard/doctor.test.ts`:

```typescript
it('flags a registered MUSTERD_MODEL as a legacy baked snapshot', async () => {
  const dir = makeWorkspace({ surface: 'claude-code' });
  stubClaudeMcpGet({ MUSTERD_MODEL: 'grok-4.5' }, [
    '/Users/x/agents-ryder/packages/mcp/dist/index.js',
  ]);
  const report = await inspectProvisioning(dir);
  expect(report.drift.find((d) => d.includes('MUSTERD_MODEL'))).toBeDefined();
});

it('flags an adapter path pointing into another seat workspace', async () => {
  const dir = makeWorkspace({ surface: 'claude-code' });
  stubClaudeMcpGet({}, ['/Users/x/agents-miley/packages/mcp/dist/index.js']);
  const report = await inspectProvisioning(dir);
  expect(report.drift.find((d) => d.includes('agents-miley'))).toBeDefined();
});
```

Follow the file's existing stubbing style for `claude mcp get` — check how `registeredClaim` tests fake it:

```bash
grep -n "registeredClaim" packages/cli/src/onboard/*.test.ts packages/cli/src/onboard/harnesses/*.test.ts
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/cli/src/onboard/doctor.test.ts`
Expected: FAIL — no drift line mentions `MUSTERD_MODEL` or `agents-miley`.

- [ ] **Step 3: Write minimal implementation**

In `harness.ts`, add to `DetectResult`:

```typescript
  /**
   * The `MUSTERD_MODEL` baked into this harness's registered musterd server, if any. Provisioning
   * no longer emits it (see {@link buildMcpEnv}), so a present value is a *legacy* snapshot that
   * outranks every live observation — the doctor flags it for removal.
   */
  registeredModel?: string;
  /** The registered launch args, so the doctor can spot an adapter inside another seat's workspace. */
  registeredArgs?: string[];
```

In `claudeCode.ts`, beside the existing `claimMatch` parse of `claude mcp get` output:

```typescript
// Same read-back as the claim check: `claude mcp get` prints env as `    MUSTERD_MODEL=<value>`
// and the launch line as `  Args: <path>`.
const modelMatch = /^\s*MUSTERD_MODEL=(.*)$/m.exec(stdout);
const argsMatch = /^\s*Args:\s*(.+)$/m.exec(stdout);
```

and add to the returned object:

```typescript
      ...(modelMatch ? { registeredModel: modelMatch[1] } : {}),
      ...(argsMatch ? { registeredArgs: argsMatch[1].trim().split(/\s+/) } : {}),
```

In `doctor.ts`, where harness states are collected:

```typescript
// Legacy baked snapshots (ADR: model attestation truth). Provisioning stopped emitting
// MUSTERD_MODEL, but entries written before that still carry one at the top of the ladder, where
// no observation can correct it — the exact shape that made one seat attest grok-4.5 for weeks.
if (state.registeredModel) {
  drift.push(
    `${state.label}'s registered musterd server bakes MUSTERD_MODEL=${state.registeredModel}, a ` +
      `wire-time snapshot that outranks what the harness is actually running. Remove it: ` +
      `\`claude mcp remove musterd -s local\` then re-run \`musterd init\`.`,
  );
}
const adapterArg = state.registeredArgs?.[state.registeredArgs.length - 1];
if (adapterArg && !isInside(adapterArg, cwd) && /packages\/mcp\/dist/.test(adapterArg)) {
  drift.push(
    `${state.label}'s registered musterd server launches its adapter from ${adapterArg}, which is ` +
      `outside this workspace — it was wired by another seat's CLI. Re-run \`musterd init\` here.`,
  );
}
```

Export `isInside` from `entryGuard.ts` (Task 9) and import it here rather than duplicating the logic.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/cli/src/onboard/doctor.test.ts && pnpm build && pnpm typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard/ packages/cli/src/onboard/harnesses/
git commit -m "feat(cli): doctor finds legacy baked models and cross-seat adapter paths"
```

---

### Task 11: End-to-end proof through the DB

**Files:**

- Create: `tests/scenarios/model-attestation-truth.test.ts`
- Test: itself

**Interfaces:**

- Consumes: everything above.
- Produces: nothing — this is the acceptance test for the whole ADR.

The standing rule in this repo is one through-the-DB integration test per new act/behavior. This proves the roster shows the observation and the audit records the correction.

- [ ] **Step 1: Write the failing test**

Create `tests/scenarios/model-attestation-truth.test.ts`, following the existing scenario harness in `tests/scenarios/` (they boot a daemon on a temp DB — copy the setup from a neighbouring scenario file):

```typescript
import { describe, expect, it } from 'vitest';

describe('model attestation truth', () => {
  it('a wrong declaration is corrected by an observation, and the correction is audited', async () => {
    const { server, team, workspace } = await bootScenario();

    // A seat provisioned with a stale declaration — the §1 incident, reproduced.
    writeBinding(workspace, { model: 'grok-4.5' });
    writeTranscript(workspace, 'claude-opus-4-8');

    // The SessionStart hook observes what is actually running.
    await captureSession('start', {
      session_id: 's1',
      transcript_path: transcriptPath(workspace),
      cwd: workspace,
    });

    // The adapter's next claim attests the observation, not the declaration.
    const session = await connectMcp({ server, team, cwd: workspace });
    const roster = await session.call('team_status');
    expect(roster).toContain('claude-opus-4-8');
    expect(roster).not.toContain('grok-4.5');

    const audit = await queryAudit(server, { action: 'occupancy.model_attested' });
    expect(audit.at(-1)).toMatchObject({ old: 'grok-4.5', new: 'claude-opus-4-8' });
  });

  it('a seat with no observation still attests its declaration', async () => {
    const { server, team, workspace } = await bootScenario();
    writeBinding(workspace, { model: 'grok-4.5' });
    const session = await connectMcp({ server, team, cwd: workspace });
    expect(await session.call('team_status')).toContain('grok-4.5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:scenarios`
Expected: FAIL — write the helpers (`bootScenario`, `writeTranscript`, `queryAudit`) by copying the neighbouring scenario file's setup before this passes.

- [ ] **Step 3: Write minimal implementation**

No production code. Fill in the scenario helpers from the existing harness so the test runs. If the assertions fail, the bug is in Tasks 1-8 — fix there, not here.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:scenarios`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/scenarios/model-attestation-truth.test.ts
git commit -m "test(scenarios): observation corrects a stale declaration end to end"
```

---

### Task 12: The ADR and the ship

**Files:**

- Create: `docs/adr/NNN-model-attestation-truth.md` (number picked at this step, not before)
- Modify: `docs/design/model-attestation-truth.md` (Status line → the assigned ADR number)
- Modify: `ROADMAP.md` (last, and never prettier'd)

**Interfaces:**

- Consumes: the shipped implementation.
- Produces: the merged PR.

- [ ] **Step 1: Pick the ADR number against fresh main**

```bash
git fetch origin main
ls docs/adr/ | sort -V | tail -5
```

Take the next free number. ADR numbers have collided in both directions in this repo, and `pnpm adr-numbers:check` fails on duplicates **or** on an H1 that does not match the filename — so pick it now, at the end, not at design time.

- [ ] **Step 2: Write the ADR**

Promote `docs/design/model-attestation-truth.md` into `docs/adr/NNN-model-attestation-truth.md`. The H1 must match the filename exactly. It **must** include an `## Observability & Evaluation` section (`pnpm obs-evals:check` fails without one for every ADR ≥ 060) — the design doc's §8 is that section.

- [ ] **Step 3: Run every gate**

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
```

Expected: all green. `format:check` runs the doc gates (`adr-numbers:check`, `obs-evals:check`, `vocab:check`) too. Note `pnpm lint` is separate and easy to forget.

- [ ] **Step 4: Verify the fix on this machine, not just in tests**

```bash
claude mcp get musterd | grep MUSTERD_MODEL || echo "no baked model — correct"
musterd status | head -3
```

Expected: no `MUSTERD_MODEL` line after re-provisioning; the roster shows the model the session is actually running. Evidence before assertions — do not claim this works without this output.

- [ ] **Step 5: Ship**

```bash
git push -u origin design/model-attestation-truth
gh pr create --title "feat: model attestation truth — observation beats declaration (ADR NNN)" --body "$(cat <<'EOF'
## Summary
- attestation splits into observed (harness probe) > declared (env, binding) > unknown, newest-wins
- provisioning stops baking MUSTERD_MODEL into harness MCP entries — the wire-time snapshot that
  outranked every live observation and made one seat attest grok-4.5 for weeks while running
  claude-opus-4-8
- every harness declares the same observeModel() slot, precedence, tripwire, and degradation
- the #273 tripwire grows the case it was missing: observed != declared
- increment 2 refuses to wire a workspace with a sibling seat's adapter path or a foreign grant

## Test plan
- unit: transcript reader (truncated, empty, moved format, missing file), tier resolver table
- regression: buildMcpEnv never emits MUSTERD_MODEL
- integration: a stale declaration is corrected by an observation, with the audit row to prove it
EOF
)"
gh pr merge --squash --auto --delete-branch
```

Then resolve the lane: `musterd lane resolve 01KYAG1M5260CXJPZFC2VD7N3E`.

---

## Notes for the implementer

- **The trap that makes this feature subtle:** `saveBinding` rebuilds the binding from _boot-time config_. Any field a hook writes must be carried through the merge guard (Task 6) or the adapter's next autojoin silently erases it, moments after it was written. This is why hand-editing `binding.json` could never fix the stale model, and it will silently defeat Task 5 if Task 6 is skipped or reordered.
- **Ambient vs connected presence:** an `x-musterd-model` HTTP touch re-attests only the ambient presence row (`conn_id IS NULL`). The roster renders the _connected_ MCP occupancy. If a manual test seems to do nothing, this is why — check `packages/server/src/transport/http.ts:544-549`.
- **A live MCP session does not pick up a rebuilt `dist`.** After changing adapter code, `pnpm build` then `/mcp reload` in the harness, or you are testing the old bytes.
- **Do not run `pnpm format`** (it reformats the world). Use `pnpm exec prettier --write <your files>`.
