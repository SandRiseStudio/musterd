# Workspace self-heal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, in the owning seat's own lane (musterd: a lane per unit of work, never a writing subagent). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A seat whose workspace is behind the installed build repairs its guidance and in-worktree hooks at SessionStart, records one audit row per repair, and reports drift as structured data on every inbox check — while the permission floor and any write outside the worktree stay a human's command.

**Architecture:** `runSessionProbe` (the `--check-build` flag every SessionStart hook already runs) gains an inspect → repair → re-inspect → audit → report step, gated by a kill switch and the ADR 168 checkout-behind verdict. Drift is cached to `.musterd/drift.json` by the CLI on a 10-minute / build-change cadence; the MCP adapter only *reads* that file and surfaces it as `structuredContent.workspace` beside the `warnings` that lane `01M2NRYJEQ` already renders. One new daemon route carries the audit row; it is the design's only protocol edge.

**Tech Stack:** TypeScript, pnpm workspace (`@musterd/protocol`, `@musterd/server`, `@musterd/cli`, `@musterd/mcp`), zod, vitest, better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-09-16-workspace-self-heal-design.md`

## Global Constraints

- Self-heal touches **guidance** and **in-worktree hooks** only. It never writes the ADR 261 permission floor and never writes a path outside `cwd`.
- `runSessionProbe` keeps its contract: silent when clean, always exit 0, never throws, one bounded line. The flag stays `--check-build` — no hook-text change, no `FEATURE_EPOCH` bump (ADR 171).
- Every file the repair writes goes through an atomic write: stage → validate → rename. The existing backup is kept.
- The audit row is best-effort: a dead or unreachable daemon is silence, never a failed session start.
- `packages/mcp` must not gain a dependency on `@musterd/cli`. The adapter reads `.musterd/drift.json`; the CLI writes it.
- Any edit under `packages/protocol/src` or a new route in `packages/server/src/transport/http.ts` needs an ADR added or modified in the same PR (`change-adr:check`). Next free number on 2026-09-16 is **407**; re-check `ls docs/decisions | sort | tail -1` when you start.
- Run the gates the failing CI job runs, never a subset: docs job = `node scripts/format.ts --check` then `pnpm change-adr:check`; static job = `pnpm typecheck && pnpm perf:check && pnpm context:check && pnpm lint`. Root typecheck refuses on stale dist — `pnpm -r build` first. Never pipe a gate into `tail` inside an `&&` chain.
- `node@22` is at `/opt/homebrew/opt/node@22/bin`; `pnpm` at `/Users/nick/Library/pnpm/pnpm`. Do not hand-rebuild `/Users/nick/agents` (the auto-refresher owns it).
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

| file | responsibility |
| --- | --- |
| `packages/cli/src/onboard/atomicWrite.ts` (new) | `writeJsonAtomic(path, value, validate)` — stage, validate, rename; the one place a hook-written JSON file is committed to disk |
| `packages/cli/src/onboard/harness.ts` | `refreshHooks.run(dir, opts)` gains `{ withinWorktreeOnly?: boolean }`; result gains `skipped: string[]` |
| `packages/cli/src/onboard/harnesses/codexHooks.ts`, `codex.ts` | honour `withinWorktreeOnly` (the only implementer that writes outside the worktree) and route its JSON write through `writeJsonAtomic` |
| `packages/cli/src/onboard/harnesses/claudeCode.ts`, `cursor.ts`, `grok.ts` | route hook JSON writes through `writeJsonAtomic`; export `checkoutBehindHooks(cwd)` from `claudeCode.ts` |
| `packages/cli/src/onboard/init.ts` | `runRefreshHooks(dir, opts)` threads the option through and returns `{ code, files, skipped, refused }` |
| `packages/cli/src/onboard/selfHeal.ts` (new) | `selfHealWorkspace(cwd, deps)` — the inspect → repair → re-inspect step; pure over injected deps so tests never touch a real folder's hooks |
| `packages/cli/src/onboard/driftCache.ts` (new) | `refreshDriftCache(cwd, { daemonBuild, now })` and `readDriftCache(cwd)` — `.musterd/drift.json` |
| `packages/cli/src/onboard/doctor.ts` | `runSessionProbe` calls `selfHealWorkspace`, then prints the report line; `musterd inbox --interrupt-check` path calls `refreshDriftCache` |
| `packages/cli/src/client.ts` | `workspaceRepair(slug, body)` — the POST |
| `packages/protocol/src/workspace.ts` (new) | `WorkspaceRepairBodySchema`, `WorkspaceRepairBody`, `DriftCacheSchema` |
| `packages/server/src/store/audit.ts` | `'workspace.repaired'` on `AuditAction` |
| `packages/server/src/transport/http.ts` | `POST /teams/:slug/workspace/repair`, seat + lease authenticated, appends the audit row |
| `packages/mcp/src/tools/format.ts` | `workspaceOf(cwd)` — reads the cache and shapes `structuredContent.workspace` |
| `packages/mcp/src/tools/inboxCheck.ts` | adds `workspace` to `structuredContent` at both sites |
| `packages/cli/src/commands/service.ts` | the auto-refresher's bounce step refreshes the Codex common-dir hooks |
| `docs/decisions/407-*.md` | the route and the self-heal policy line |
| `docs/wiki/workspace-self-heal.md` | the live measurement, dated |

---

## Increment 3 — SessionStart self-heal + audit row

### Task 1: Atomic JSON write

**Files:**
- Create: `packages/cli/src/onboard/atomicWrite.ts`
- Test: `packages/cli/src/onboard/atomicWrite.test.ts`

**Interfaces:**
- Produces: `writeJsonAtomic(path: string, value: unknown, validate?: (parsed: unknown) => boolean): void` — writes `${path}.tmp-<pid>`, re-reads and parses it, runs `validate` if given, `renameSync`s over `path`. Throws and leaves `path` untouched on any failure; the `.tmp` is removed.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/src/onboard/atomicWrite.test.ts
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic } from './atomicWrite.js';

describe('writeJsonAtomic', () => {
  const dirs: string[] = [];
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'musterd-atomic-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('writes valid JSON with a trailing newline and leaves no temp file', () => {
    const p = join(dir(), 'hooks.json');
    writeJsonAtomic(p, { a: 1 });
    expect(readFileSync(p, 'utf8')).toBe('{\n  "a": 1\n}\n');
    expect(readdirSync(join(p, '..')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('a failing validator leaves the original byte-identical and removes the stage file', () => {
    const p = join(dir(), 'hooks.json');
    writeFileSync(p, '{"keep":true}\n');
    expect(() => writeJsonAtomic(p, { keep: false }, () => false)).toThrow(/validation/);
    expect(readFileSync(p, 'utf8')).toBe('{"keep":true}\n');
    expect(readdirSync(join(p, '..')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('a value that cannot serialise leaves nothing behind', () => {
    const p = join(dir(), 'hooks.json');
    const cyc: Record<string, unknown> = {};
    cyc['self'] = cyc;
    expect(() => writeJsonAtomic(p, cyc)).toThrow();
    expect(existsSync(p)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd packages/cli && npx vitest run src/onboard/atomicWrite.test.ts`
Expected: FAIL — `Cannot find module './atomicWrite.js'`

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/onboard/atomicWrite.ts
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Stage → validate → rename. A hook-driven repair (the self-heal path) writes files no human is
 * watching, and a malformed hooks file bricks the NEXT session start silently. So the write is
 * committed only after the staged bytes parse back and pass the caller's validator; any failure
 * leaves the original untouched and the stage removed.
 */
export function writeJsonAtomic(
  path: string,
  value: unknown,
  validate?: (parsed: unknown) => boolean,
): void {
  const stage = `${path}.tmp-${String(process.pid)}`;
  try {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(stage, body, { mode: 0o644 });
    const parsed: unknown = JSON.parse(readFileSync(stage, 'utf8'));
    if (validate && !validate(parsed)) throw new Error(`atomic write validation failed: ${path}`);
    renameSync(stage, path);
  } catch (err) {
    rmSync(stage, { force: true });
    throw err;
  }
}
```

- [ ] **Step 4: Run tests — pass**

Run: `cd packages/cli && npx vitest run src/onboard/atomicWrite.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard/atomicWrite.ts packages/cli/src/onboard/atomicWrite.test.ts
git commit -m "cli: writeJsonAtomic — stage, validate, rename, so a hook-written file can never land half-formed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: Route every hook JSON write through the atomic writer

**Files:**
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts`, `cursor.ts`, `grok.ts`, `codexHooks.ts`, `codex.ts` — every `writeFileSync` whose target is a hooks/settings JSON file
- Test: existing harness tests (`claudeCode.test.ts`, `cursor.test.ts`, `grok.test.ts`, `codexHooks.test.ts`) must stay green; add one assertion per file that the written file parses

**Interfaces:**
- Consumes: `writeJsonAtomic` from Task 1.

- [ ] **Step 1: Find every target**

Run: `grep -n "writeFileSync" packages/cli/src/onboard/harnesses/{claudeCode,cursor,grok,codexHooks,codex}.ts`
Record each line whose path ends in `.json` under `.claude/`, `.cursor/`, `.grok/`, `.codex/`. (Markdown guidance files and `config.toml` are NOT JSON — leave them.)

- [ ] **Step 2: Write the failing assertion (one per harness test file)**

In each of the four harness test files, find the existing test that installs or refreshes hooks into a temp dir and add at its end:

```ts
    // Task 2: the write went through writeJsonAtomic — parses, ends in one newline, no stage file left.
    const raw = readFileSync(hooksPath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw.endsWith('\n')).toBe(true);
    expect(readdirSync(dirname(hooksPath)).some((f) => f.includes('.tmp-'))).toBe(false);
```

(`hooksPath` is whatever that test already calls the file it checks; import `readdirSync` and `dirname` if missing.)

- [ ] **Step 3: Run — the newline assertion fails wherever the writer used `JSON.stringify(x)` without the trailing newline; the rest pass**

Run: `cd packages/cli && npx vitest run src/onboard/harnesses/`
Expected: at least one FAIL on `endsWith('\n')`

- [ ] **Step 4: Replace each JSON `writeFileSync` with `writeJsonAtomic`**

Pattern, at every line from Step 1:

```ts
// before
writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 0o644);
// after
writeJsonAtomic(path, next, (p) => typeof p === 'object' && p !== null);
```

In `codex.ts:476` (the fragment ledger write inside `ctx.fs === nodeFs`), keep the `ctx.fs.writeFile` branch for the in-memory fs used by tests and call `writeJsonAtomic` only when `ctx.fs === nodeFs`.

- [ ] **Step 5: Run the harness suites — all pass**

Run: `cd packages/cli && npx vitest run src/onboard/harnesses/`
Expected: all passed

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/onboard/harnesses
git commit -m "cli: every hook JSON write is atomic — stage, validate, rename (self-heal precondition)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: `withinWorktreeOnly` — a refresh that skips writes outside `cwd` and reports them

**Files:**
- Modify: `packages/cli/src/onboard/harness.ts:280-289`
- Modify: `packages/cli/src/onboard/harnesses/codex.ts` (the `refreshHooks.run` implementer) and `codexHooks.ts` (`installCodexHooks`)
- Modify: `packages/cli/src/onboard/init.ts:177-260` (`runRefreshHooks`)
- Test: `packages/cli/src/onboard/init.test.ts` (or `codexHooks.test.ts` if `runRefreshHooks` has no test file — check with `ls packages/cli/src/onboard/*.test.ts`)

**Interfaces:**
- Produces:
  - `harness.ts`: `refreshHooks.run: (dir: string, opts?: { withinWorktreeOnly?: boolean }) => { files: string[]; warnings: string[]; skipped: string[] }`
  - `init.ts`: `runRefreshHooks(dir?: string, opts?: { withinWorktreeOnly?: boolean; quiet?: boolean }): { code: number; files: string[]; skipped: string[]; refused: number }` — **note the return type changes from `number`**; `commands/init.ts` uses `.code`.
  - `codexHooks.ts`: `installCodexHooks(worktreeRoot: string): string | undefined` returns the common-dir path it wrote (unchanged behaviour, now reported).

- [ ] **Step 1: Write the failing test**

```ts
// in packages/cli/src/onboard/init.test.ts (create if absent, mirroring doctor.test.ts imports)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HARNESSES } from './harness.js';
import { runRefreshHooks } from './init.js';

describe('runRefreshHooks withinWorktreeOnly', () => {
  const dirs: string[] = [];
  afterEach(() => {
    dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
    vi.restoreAllMocks();
  });

  it('a harness whose refresh writes outside cwd is skipped and named, never written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-refresh-'));
    dirs.push(dir);
    mkdirSync(join(dir, '.musterd'));
    writeFileSync(join(dir, '.musterd', 'binding.json'), JSON.stringify({ team: 't', server: 'http://x' }));
    // A stand-in harness that reports one in-worktree file and one outside it.
    const fake = {
      id: 'fake',
      label: 'Fake',
      refreshHooks: {
        applies: () => true,
        run: (_d: string, opts?: { withinWorktreeOnly?: boolean }) =>
          opts?.withinWorktreeOnly
            ? { files: [join(dir, '.fake', 'hooks.json')], warnings: [], skipped: ['/outside/hooks.json'] }
            : { files: [join(dir, '.fake', 'hooks.json'), '/outside/hooks.json'], warnings: [], skipped: [] },
      },
    };
    vi.spyOn(HARNESSES, 'filter').mockReturnValue([fake as never]);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const res = runRefreshHooks(dir, { withinWorktreeOnly: true, quiet: true });
    expect(res.code).toBe(0);
    expect(res.files).toEqual([join(dir, '.fake', 'hooks.json')]);
    expect(res.skipped).toEqual(['/outside/hooks.json']);
  });
});
```

If `folderTeamHere(dir)` needs more than a `binding.json` to resolve, copy the fixture the nearest existing `init`/`doctor` test uses for a "bound folder" instead of the two-line stub above.

- [ ] **Step 2: Run — fails**

Run: `cd packages/cli && npx vitest run src/onboard/init.test.ts`
Expected: FAIL — `res.code` is undefined (function returns a number) / `opts` not accepted

- [ ] **Step 3: Change the interface and the driver**

`harness.ts:280-289`:

```ts
  refreshHooks?: {
    applies: (dir: string) => boolean;
    /**
     * `withinWorktreeOnly` (self-heal, spec 2026-09-16): skip any surface whose path resolves
     * outside `dir` and return it in `skipped` instead of writing it. A hook that runs in one
     * seat's session must not rewrite a file every seat shares (Codex's common-dir hooks.json).
     */
    run: (
      dir: string,
      opts?: { withinWorktreeOnly?: boolean },
    ) => { files: string[]; warnings: string[]; skipped: string[] };
    surfaces?: () => string[];
  };
```

`init.ts` `runRefreshHooks` — change signature and return shape; thread `opts` into `h.refreshHooks!.run(dir, opts)`; collect `skipped` across harnesses; when `opts.quiet` is set, write nothing to stdout (the self-heal caller prints its own one line). Return `{ code: refused > 0 ? 1 : 0, files, skipped, refused }`. Update `commands/init.ts` to `return runRefreshHooks().code`.

Every existing `refreshHooks.run` implementer (grep `refreshHooks: {` under `harnesses/`) returns `skipped: []` unless it writes outside `dir`. Only Codex does: in `codex.ts`, where `installCodexHooks(ctx.worktreeRoot)` is called after the ledger write, guard it:

```ts
        if (mutation.kind !== 'remove' && ctx.fs === nodeFs) {
          if (opts?.withinWorktreeOnly) {
            const common = codexCommonDirRoot(ctx.worktreeRoot);
            if (common && common !== ctx.worktreeRoot) skipped.push(codexHooksPath(common));
          } else {
            const wrote = installCodexHooks(ctx.worktreeRoot);
            if (wrote) files.push(wrote);
          }
        }
```

(`opts` must be threaded from the harness's `run` into wherever this mutation runs; `skipped`/`files` are the arrays that `run` returns.)

- [ ] **Step 4: Run — passes; then the whole cli suite**

Run: `cd packages/cli && npx vitest run src/onboard/init.test.ts && npx vitest run`
Expected: PASS; no other test broke on the return-type change (fix any caller still comparing `runRefreshHooks(...)` to a number)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard packages/cli/src/commands/init.ts
git commit -m "cli: refreshHooks gains withinWorktreeOnly — a write outside the worktree is skipped and named, not made

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: The two guards — kill switch and checkout-behind

**Files:**
- Modify: `packages/cli/src/onboard/declined.ts` (no code change; the surface name `musterd:self-heal` is just a `SurfaceName`, add it to the doc comment at line 29)
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts` — export `checkoutBehindHooks(cwd: string): boolean`
- Test: `packages/cli/src/onboard/harnesses/claudeCode.test.ts`

**Interfaces:**
- Produces: `checkoutBehindHooks(cwd): boolean` — true when any installed marker-owned Claude Code hook (machine-wide `~/.claude/settings.json` or the folder's `.claude/settings.local.json`) carries `hookEpochOf(command) > FEATURE_EPOCH`. Reuses the same `readSettingsSafe` + marker match `inspectClaudeHookDrift` uses at `claudeCode.ts:848-870`.
- The kill switch is `isDeclined(cwd, 'musterd:self-heal')` from `declined.ts:78` — nothing new to build; `musterd init --decline musterd:self-heal` (if a decline command exists) or a hand-written tombstone sets it.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/cli/src/onboard/harnesses/claudeCode.test.ts
import { checkoutBehindHooks, hookEpochOf } from './claudeCode.js';
import { FEATURE_EPOCH } from '@musterd/protocol';

describe('checkoutBehindHooks', () => {
  it('is true when an installed marker hook carries a newer epoch than this build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-behind-'));
    mkdirSync(join(dir, '.claude'));
    const newer = `d="x"; echo hi # musterd-interrupt-hook e${String(FEATURE_EPOCH + 1)}`;
    writeFileSync(
      join(dir, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: newer }] }] } }),
    );
    expect(hookEpochOf(newer)).toBe(FEATURE_EPOCH + 1);
    expect(checkoutBehindHooks(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is false with no settings file and false at the current epoch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-behind-'));
    expect(checkoutBehindHooks(dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

Adjust the marker string (`musterd-interrupt-hook`) to whatever `hookEpochOf` actually parses — read `claudeCode.ts:334`.

- [ ] **Step 2: Run — fails on missing export**

Run: `cd packages/cli && npx vitest run src/onboard/harnesses/claudeCode.test.ts`

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/onboard/harnesses/claudeCode.ts — beside inspectClaudeHookDrift
/**
 * ADR 168's checkout-behind verdict as a predicate: some installed marker-owned hook was written by
 * a NEWER musterd than this checkout. Self-heal must not run in that state — it would downgrade
 * what a newer build wrote (the same refusal `musterd init` makes). Reads the folder's local
 * settings and the machine-wide file; absent or unparseable → false, never invented drift.
 */
export function checkoutBehindHooks(cwd: string): boolean {
  const files = [join(cwd, '.claude', 'settings.local.json'), globalSettingsPath()];
  for (const f of files) {
    const settings = readSettingsSafe(f);
    if (!settings) continue;
    for (const matchers of Object.values(settings.hooks ?? {})) {
      for (const m of matchers) {
        for (const h of m.hooks) {
          if (h.command.includes('musterd') && hookEpochOf(h.command) > FEATURE_EPOCH) return true;
        }
      }
    }
  }
  return false;
}
```

- [ ] **Step 4: Run — passes**

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard/harnesses/claudeCode.ts packages/cli/src/onboard/harnesses/claudeCode.test.ts packages/cli/src/onboard/declined.ts
git commit -m "cli: checkoutBehindHooks — ADR 168's downgrade refusal as a predicate self-heal can consult

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: Protocol body + daemon route + audit action + ADR 407

**Files:**
- Create: `packages/protocol/src/workspace.ts`; export it from `packages/protocol/src/index.ts`
- Modify: `packages/server/src/store/audit.ts:13` (`AuditAction` union)
- Modify: `packages/server/src/transport/http.ts` — new route beside `/inbox/interrupt-check` (line ~5486)
- Create: `docs/decisions/407-a-workspace-repair-is-an-audit-row.md`
- Test: `packages/server/src/transport/workspace-repair-http.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // @musterd/protocol
  export const WorkspaceRepairBodySchema = z.object({
    build: z.string().min(7),
    repaired: z.object({ guidance: z.number().int().min(0), hooks: z.number().int().min(0) }),
    skipped: z.array(z.object({
      class: z.enum(['guidance', 'hooks', 'permissions']),
      reason: z.enum(['declined', 'checkout_behind', 'outside_worktree', 'policy']),
      path: z.string().optional(),
    })),
    remaining: z.object({ guidance: z.number().int().min(0), hooks: z.number().int().min(0), permissions: z.number().int().min(0) }),
  });
  export type WorkspaceRepairBody = z.infer<typeof WorkspaceRepairBodySchema>;
  ```
  - Route: `POST /teams/:slug/workspace/repair`, authenticated with `authTouch(ctx, slug, req)` (seat credential + session lease — the same auth as `interrupt-check`), body validated with `parseOrBadRequest(WorkspaceRepairBodySchema, await readJson(req))`, appends `appendAudit(ctx.db, team.id, { actor: member.name, action: 'workspace.repaired', target: member.name, result: 'allow', detail: body })`, returns `200 { ok: true }`.
  - `AuditAction` gains `| 'workspace.repaired'`.

- [ ] **Step 1: Write the failing route test**

```ts
// packages/server/src/transport/workspace-repair-http.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';

let server: RunningServer;
let base: string;
let nickCred: string;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { headers });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
const bearer = (auth: string) => ({ authorization: `Bearer ${auth}` });

const body = {
  build: 'abc1234',
  repaired: { guidance: 15, hooks: 3 },
  skipped: [{ class: 'permissions', reason: 'policy' }],
  remaining: { guidance: 0, hooks: 0, permissions: 1 },
};

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
  nickCred = team.json.human_credential;
});
afterEach(async () => {
  await server.close();
});

describe('POST /teams/:slug/workspace/repair (ADR 407)', () => {
  it('a seat with a live lease records one workspace.repaired audit row carrying the body', async () => {
    // Claim an agent seat the way claim-http.test.ts does, to get a seat credential + session lease.
    // Copy that file's `claimSeat` helper here verbatim; call it `const { cred, lease } = await claimSeat('ada')`.
    const { cred, lease } = await claimSeat('ada');
    const r = await post('/teams/dawn/workspace/repair', body, {
      ...bearer(cred),
      'x-musterd-session-lease': lease,
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    const audit = await get('/teams/dawn/audit', bearer(nickCred));
    const row = audit.json.entries.find((e: any) => e.action === 'workspace.repaired');
    expect(row.actor).toBe('ada');
    expect(row.detail).toMatchObject(body);
  });

  it('is refused without a session lease, exactly like interrupt-check', async () => {
    const { cred } = await claimSeat('ada');
    const r = await post('/teams/dawn/workspace/repair', body, bearer(cred));
    expect(r.status).toBe(401);
  });

  it('rejects a malformed body', async () => {
    const { cred, lease } = await claimSeat('ada');
    const r = await post('/teams/dawn/workspace/repair', { build: 'x' }, {
      ...bearer(cred),
      'x-musterd-session-lease': lease,
    });
    expect(r.status).toBe(400);
  });
});
```

Read `packages/server/src/transport/claim-http.test.ts` first for the seat-claim helper; the audit `GET` response shape is in `packages/cli/src/commands/audit.ts` — adjust `entries`/`detail` field names to what the server actually returns.

- [ ] **Step 2: Run — fails with 404**

Run: `cd packages/server && npx vitest run src/transport/workspace-repair-http.test.ts`

- [ ] **Step 3: Add the schema, the action, the route**

`packages/protocol/src/workspace.ts` — the schema block from Interfaces, with a doc comment naming the spec. Add `export * from './workspace.js';` to `packages/protocol/src/index.ts`.

`audit.ts:13` — add `| 'workspace.repaired'` with a comment: `// Spec 2026-09-16 workspace self-heal: what a SessionStart repair wrote, skipped and left.`

`http.ts`, directly after the `/inbox/interrupt-check` block:

```ts
      if (method === 'POST' && rest === '/workspace/repair') {
        // Spec 2026-09-16 (workspace self-heal), ADR 407: the one place a hook-driven repair
        // becomes attributable. Same auth as interrupt-check — a seat credential AND a live
        // session lease — because only a live occupancy repairs a workspace. Best-effort on the
        // client; here it is an ordinary audited write.
        const { team, member } = authTouch(ctx, slug, req);
        const body = parseOrBadRequest(WorkspaceRepairBodySchema, await readJson(req));
        appendAudit(ctx.db, team.id, {
          actor: member.name,
          action: 'workspace.repaired',
          target: member.name,
          result: 'allow',
          detail: body,
        });
        return sendJson(res, 200, { ok: true });
      }
```

Import `WorkspaceRepairBodySchema` from `@musterd/protocol`.

- [ ] **Step 4: Build protocol, run the route test, then the server suite**

Run: `pnpm --filter @musterd/protocol build && cd packages/server && npx vitest run src/transport/workspace-repair-http.test.ts && npx vitest run`
Expected: all passed

- [ ] **Step 5: Write ADR 407**

`docs/decisions/407-a-workspace-repair-is-an-audit-row.md`, in the house shape (copy the header block of `406-*.md`): Status proposed; Date 2026-09-16; Relates to ADR 135, 152, 161, 168, 171, 261, 391. Context: the 2026-09-16 census and the three defects, cited from the spec. Decision: (1) the SessionStart probe repairs guidance and in-worktree hooks; never the permission floor; never a path outside the worktree; (2) `POST /teams/:slug/workspace/repair`, seat + lease auth, records `workspace.repaired` — the design's only protocol edge; (3) `.musterd/drift.json` is CLI-written, adapter-read. Consequences: the propagation-accelerator argument from the spec's security section, verbatim; the four guards; what the human loses (a per-seat approval step for guidance/hooks) and keeps (permissions, cross-seat writes).

- [ ] **Step 6: Run the docs gates**

Run: `node scripts/format.ts --check && pnpm change-adr:check`
Expected: clean — the ADR satisfies `change-adr:check` for the protocol edit

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src/workspace.ts packages/protocol/src/index.ts packages/server/src/store/audit.ts packages/server/src/transport/http.ts packages/server/src/transport/workspace-repair-http.test.ts docs/decisions/407-a-workspace-repair-is-an-audit-row.md
git commit -m "ADR 407: a workspace repair is an audit row — POST /workspace/repair, seat + lease authenticated

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: `selfHealWorkspace` — the step itself, pure over injected deps

**Files:**
- Create: `packages/cli/src/onboard/selfHeal.ts`
- Test: `packages/cli/src/onboard/selfHeal.test.ts`

**Interfaces:**
- Consumes: `inspectArtifactDrift(cwd)` (`doctor.ts:1236`), `runRefreshGuidance(dir)` (`init.ts:128`, returns `number`), `runRefreshHooks(dir, opts)` (Task 3), `isDeclined(dir, surface)` (`declined.ts:78`), `checkoutBehindHooks(cwd)` (Task 4), `WorkspaceRepairBody` (Task 5).
- Produces:
  ```ts
  export interface SelfHealDeps {
    inspect: (cwd: string) => { guidance: string[]; hooks: string[]; permissions: string[] };
    refreshGuidance: (cwd: string) => number;
    refreshHooks: (cwd: string, opts: { withinWorktreeOnly: true; quiet: true }) => { code: number; files: string[]; skipped: string[]; refused: number };
    declined: (cwd: string) => boolean;
    checkoutBehind: (cwd: string) => boolean;
    build: string;
  }
  export interface SelfHealOutcome {
    ran: boolean;                       // false when declined / checkout-behind / nothing to do
    report: WorkspaceRepairBody | null; // null when nothing was attempted
    line: string;                       // '' when clean; otherwise ONE line, no trailing newline
  }
  export function selfHealWorkspace(cwd: string, deps: SelfHealDeps): SelfHealOutcome;
  export function defaultSelfHealDeps(build: string): SelfHealDeps; // wires the real functions
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/src/onboard/selfHeal.test.ts
import { describe, expect, it, vi } from 'vitest';
import { selfHealWorkspace, type SelfHealDeps } from './selfHeal.js';

const drifted = { guidance: ['a.md', 'b.md'], hooks: ['.claude/settings.local.json'], permissions: ['mcp__musterd'] };
const clean = { guidance: [], hooks: [], permissions: [] };

function deps(over: Partial<SelfHealDeps> = {}): SelfHealDeps {
  let calls = 0;
  return {
    inspect: vi.fn(() => (calls++ === 0 ? drifted : { ...clean, permissions: drifted.permissions })),
    refreshGuidance: vi.fn(() => 0),
    refreshHooks: vi.fn(() => ({ code: 0, files: ['.claude/settings.local.json'], skipped: [], refused: 0 })),
    declined: () => false,
    checkoutBehind: () => false,
    build: 'abc1234',
    ...over,
  };
}

describe('selfHealWorkspace', () => {
  it('repairs guidance and hooks, never permissions, and reports what remains', () => {
    const d = deps();
    const out = selfHealWorkspace('/w', d);
    expect(d.refreshGuidance).toHaveBeenCalledWith('/w');
    expect(d.refreshHooks).toHaveBeenCalledWith('/w', { withinWorktreeOnly: true, quiet: true });
    expect(out.ran).toBe(true);
    expect(out.report).toEqual({
      build: 'abc1234',
      repaired: { guidance: 2, hooks: 1 },
      skipped: [{ class: 'permissions', reason: 'policy' }],
      remaining: { guidance: 0, hooks: 0, permissions: 1 },
    });
    expect(out.line).toBe(
      'musterd: repaired 2 guidance files and 1 hook; the harness permission layer is still behind — run `musterd init --refresh-permissions`.',
    );
  });

  it('is silent and does nothing when clean', () => {
    const d = deps({ inspect: vi.fn(() => clean) });
    const out = selfHealWorkspace('/w', d);
    expect(out).toEqual({ ran: false, report: null, line: '' });
    expect(d.refreshGuidance).not.toHaveBeenCalled();
  });

  it('declined: repairs nothing, falls back to the prescription, says why', () => {
    const d = deps({ declined: () => true });
    const out = selfHealWorkspace('/w', d);
    expect(d.refreshGuidance).not.toHaveBeenCalled();
    expect(out.ran).toBe(false);
    expect(out.report?.skipped).toEqual([
      { class: 'guidance', reason: 'declined' },
      { class: 'hooks', reason: 'declined' },
      { class: 'permissions', reason: 'policy' },
    ]);
    expect(out.line).toContain('self-heal is declined in this folder');
    expect(out.line).toContain('`musterd init --refresh-guidance`');
  });

  it('checkout behind: repairs nothing and says the checkout, not the hook, is the problem', () => {
    const d = deps({ checkoutBehind: () => true });
    const out = selfHealWorkspace('/w', d);
    expect(d.refreshHooks).not.toHaveBeenCalled();
    expect(out.report?.skipped.map((s) => s.reason)).toContain('checkout_behind');
    expect(out.line).toContain('this checkout is behind');
  });

  it('a write outside the worktree is reported as skipped, and what it left is counted as remaining', () => {
    const d = deps({
      refreshHooks: vi.fn(() => ({ code: 0, files: [], skipped: ['/shared/.codex/hooks.json'], refused: 0 })),
      inspect: vi.fn().mockReturnValueOnce(drifted).mockReturnValueOnce({ ...drifted, guidance: [] }),
    });
    const out = selfHealWorkspace('/w', d);
    expect(out.report?.skipped).toContainEqual({ class: 'hooks', reason: 'outside_worktree', path: '/shared/.codex/hooks.json' });
    expect(out.report?.remaining.hooks).toBe(1);
    expect(out.line).toContain('/shared/.codex/hooks.json');
  });

  it('a throwing refresh never escapes — the line still reports and the report says nothing was repaired', () => {
    const d = deps({ refreshGuidance: vi.fn(() => { throw new Error('boom'); }) });
    const out = selfHealWorkspace('/w', d);
    expect(out.report?.repaired.guidance).toBe(0);
    expect(out.line.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — fails on missing module**

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/onboard/selfHeal.ts
import type { WorkspaceRepairBody } from '@musterd/protocol';
import { isDeclined } from './declined.js';
import { inspectArtifactDrift } from './doctor.js';
import { checkoutBehindHooks } from './harnesses/claudeCode.js';
import { runRefreshGuidance, runRefreshHooks } from './init.js';

/** The tombstone surface that switches self-heal off for one folder (spec 2026-09-16). */
export const SELF_HEAL_SURFACE = 'musterd:self-heal';

export interface SelfHealDeps { /* as in Interfaces */ }
export interface SelfHealOutcome { /* as in Interfaces */ }

type Skip = WorkspaceRepairBody['skipped'][number];

export function selfHealWorkspace(cwd: string, deps: SelfHealDeps): SelfHealOutcome {
  const before = deps.inspect(cwd);
  const drift = before.guidance.length + before.hooks.length + before.permissions.length;
  if (drift === 0) return { ran: false, report: null, line: '' };

  const skipped: Skip[] = [];
  if (before.permissions.length > 0) skipped.push({ class: 'permissions', reason: 'policy' });

  const declined = deps.declined(cwd);
  const behind = !declined && deps.checkoutBehind(cwd);
  let repairedGuidance = 0;
  let repairedHooks = 0;

  if (declined || behind) {
    const reason = declined ? 'declined' : 'checkout_behind';
    if (before.guidance.length > 0) skipped.unshift({ class: 'guidance', reason });
    if (before.hooks.length > 0) skipped.splice(before.guidance.length > 0 ? 1 : 0, 0, { class: 'hooks', reason });
  } else {
    if (before.guidance.length > 0) {
      try { if (deps.refreshGuidance(cwd) === 0) repairedGuidance = before.guidance.length; } catch { /* reported as unrepaired below */ }
    }
    if (before.hooks.length > 0) {
      try {
        const r = deps.refreshHooks(cwd, { withinWorktreeOnly: true, quiet: true });
        repairedHooks = r.files.length;
        for (const p of r.skipped) skipped.push({ class: 'hooks', reason: 'outside_worktree', path: p });
      } catch { /* reported as unrepaired below */ }
    }
  }

  const after = deps.inspect(cwd);
  const report: WorkspaceRepairBody = {
    build: deps.build,
    repaired: { guidance: repairedGuidance, hooks: repairedHooks },
    skipped,
    remaining: { guidance: after.guidance.length, hooks: after.hooks.length, permissions: after.permissions.length },
  };
  return { ran: !(declined || behind), report, line: composeLine(report, declined, behind) };
}

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** ONE line. Bounded by construction: counts and repair commands, never file lists. */
function composeLine(r: WorkspaceRepairBody, declined: boolean, behind: boolean): string {
  const fixes = [
    r.remaining.guidance > 0 ? '`musterd init --refresh-guidance`' : null,
    r.remaining.hooks > 0 ? '`musterd init --refresh-hooks`' : null,
    r.remaining.permissions > 0 ? '`musterd init --refresh-permissions`' : null,
  ].filter((s): s is string => s !== null);
  if (declined) {
    return `musterd: this folder's provisioning is behind what this build writes and self-heal is declined in this folder — run ${fixes.join(' and ')} to repair.`;
  }
  if (behind) {
    return `musterd: this folder's provisioning differs from this build, but a hook here was written by a NEWER musterd — this checkout is behind. Update it (\`git pull\` + \`pnpm build\`); nothing was rewritten (ADR 168).`;
  }
  const did = [
    r.repaired.guidance > 0 ? plural(r.repaired.guidance, 'guidance file', 'guidance files') : null,
    r.repaired.hooks > 0 ? plural(r.repaired.hooks, 'hook', 'hooks') : null,
  ].filter((s): s is string => s !== null);
  const outside = r.skipped.filter((s) => s.reason === 'outside_worktree').map((s) => s.path ?? '');
  const still: string[] = [];
  if (r.remaining.permissions > 0) still.push('the harness permission layer is still behind');
  if (outside.length > 0) still.push(`${outside.join(', ')} is shared by every seat and needs a human`);
  if (r.remaining.guidance > 0 || (r.remaining.hooks > 0 && outside.length === 0)) still.push('some drift could not be repaired');
  const head = did.length > 0 ? `musterd: repaired ${did.join(' and ')}` : 'musterd: repaired nothing';
  const tail = still.length > 0 ? `; ${still.join('; ')} — run ${fixes.join(' and ')}.` : '.';
  return head + tail;
}

export function defaultSelfHealDeps(build: string): SelfHealDeps {
  return {
    inspect: inspectArtifactDrift,
    refreshGuidance: runRefreshGuidance,
    refreshHooks: (cwd, opts) => runRefreshHooks(cwd, opts),
    declined: (cwd) => isDeclined(cwd, SELF_HEAL_SURFACE),
    checkoutBehind: checkoutBehindHooks,
    build,
  };
}
```

Fix the `skipped` ordering in the declined/behind branch until the test's expected array order holds (guidance, hooks, permissions) — the `unshift`/`splice` above is one way; a simpler rebuild of the array in class order is fine.

- [ ] **Step 4: Run — passes**

Run: `cd packages/cli && npx vitest run src/onboard/selfHeal.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard/selfHeal.ts packages/cli/src/onboard/selfHeal.test.ts
git commit -m "cli: selfHealWorkspace — inspect, repair guidance and in-worktree hooks, re-inspect, one line

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: Wire it into `runSessionProbe`, post the audit row

**Files:**
- Modify: `packages/cli/src/onboard/doctor.ts:1239-1290` (`runSessionProbe`)
- Modify: `packages/cli/src/client.ts` — add `workspaceRepair`
- Test: `packages/cli/src/onboard/doctor.test.ts:1529` (extend the existing `runSessionProbe` test block)

**Interfaces:**
- Consumes: `selfHealWorkspace`, `defaultSelfHealDeps` (Task 6); `WorkspaceRepairBody` (Task 5).
- Produces:
  - `client.ts`: `async workspaceRepair(slug: string, body: WorkspaceRepairBody): Promise<{ ok: boolean }>` → `this.request('POST', \`/teams/${slug}/workspace/repair\`, body)`.
  - `runSessionProbe(deps?: { cliRef?; daemonBuild?; cwd?; selfHeal?: (cwd: string, build: string) => SelfHealOutcome; postRepair?: (body: WorkspaceRepairBody) => Promise<void> })` — two new injectables; defaults are `selfHealWorkspace(cwd, defaultSelfHealDeps(build))` and a `MusterdClient` built the way `buildSkewNotes` builds its client, calling `workspaceRepair`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe` that holds the `runSessionProbe` test at `doctor.test.ts:1529`:

```ts
  it('runSessionProbe self-heals, prints the outcome line, posts the audit row, and still exits 0 when the daemon is down', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => { lines.push(String(c)); return true; }) as never);
    const bare = mkdtempSync(join(tmpdir(), 'musterd-heal-'));
    const report = {
      build: sha('a'),
      repaired: { guidance: 2, hooks: 1 },
      skipped: [{ class: 'permissions' as const, reason: 'policy' as const }],
      remaining: { guidance: 0, hooks: 0, permissions: 1 },
    };
    const posted: unknown[] = [];
    try {
      const code = await runSessionProbe({
        cliRef: sha('a'),
        daemonBuild: async () => sha('a'),
        cwd: bare,
        selfHeal: () => ({ ran: true, report, line: 'musterd: repaired 2 guidance files and 1 hook; the harness permission layer is still behind — run `musterd init --refresh-permissions`.' }),
        postRepair: async (b) => { posted.push(b); },
      });
      expect(code).toBe(0);
      expect(lines.join('')).toBe('musterd: repaired 2 guidance files and 1 hook; the harness permission layer is still behind — run `musterd init --refresh-permissions`.\n');
      expect(posted).toEqual([report]);

      lines.length = 0;
      // Daemon down: the post throws; the line still prints; exit is still 0.
      const down = await runSessionProbe({
        cliRef: sha('a'),
        daemonBuild: async () => { throw new Error('ECONNREFUSED'); },
        cwd: bare,
        selfHeal: () => ({ ran: true, report, line: 'musterd: repaired 2 guidance files and 1 hook.' }),
        postRepair: async () => { throw new Error('ECONNREFUSED'); },
      });
      expect(down).toBe(0);
      expect(lines.join('')).toContain('repaired 2 guidance files');

      lines.length = 0;
      // Clean: nothing printed, nothing posted.
      await runSessionProbe({ cliRef: sha('a'), daemonBuild: async () => sha('a'), cwd: bare, selfHeal: () => ({ ran: false, report: null, line: '' }), postRepair: async (b) => { posted.push(b); } });
      expect(lines.join('')).toBe('');
      expect(posted).toHaveLength(1);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run — fails (unknown options / old line shape)**

- [ ] **Step 3: Implement**

In `doctor.ts` `runSessionProbe`, replace the second `try` block (the `inspectArtifactDrift` → prescription line) with:

```ts
  try {
    const cwd = deps?.cwd ?? process.cwd();
    const build = ref ?? 'unstamped';
    const heal = deps?.selfHeal ?? ((c: string, b: string) => selfHealWorkspace(c, defaultSelfHealDeps(b)));
    const out = heal(cwd, build);
    if (out.report && out.ran) {
      // Attribution (ADR 407): best-effort, never a gate. A dead daemon is silence.
      const post = deps?.postRepair ?? defaultPostRepair;
      await post(out.report).catch(() => undefined);
    }
    if (out.line) process.stdout.write(`${out.line}\n`);
  } catch {
    // A health probe never fails a session start, and never invents drift from a folder it cannot read.
  }
  return 0;
```

Add `defaultPostRepair` beside it, building a client exactly as `buildSkewNotes` (`doctor.ts:1134`) does and calling `client.workspaceRepair(team, body)` — copy that client construction; do not invent a new one. Keep the ADR 171 doc comment above the function and add one paragraph: *"Since spec 2026-09-16 the probe also repairs (guidance, in-worktree hooks) before it reports; the contract — silent when clean, exit 0, one line — is unchanged."*

In `client.ts`, next to `wakeTurn` (line 1108):

```ts
  /** Spec 2026-09-16 / ADR 407 — one audit row per SessionStart repair. Seat + lease auth. */
  async workspaceRepair(slug: string, body: WorkspaceRepairBody): Promise<{ ok: boolean }> {
    return (await this.request('POST', `/teams/${slug}/workspace/repair`, body)) as { ok: boolean };
  }
```

- [ ] **Step 4: Run the doctor suite, then typecheck**

Run: `cd packages/cli && npx vitest run src/onboard/doctor.test.ts && cd ../.. && pnpm -r build && pnpm typecheck`
Expected: PASS; typecheck clean

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard/doctor.ts packages/cli/src/onboard/doctor.test.ts packages/cli/src/client.ts
git commit -m "cli: the SessionStart probe repairs before it reports, and posts the repair as an audit row (ADR 407)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8: Live measurement, wiki page, PR for increment 3

**Files:**
- Create: `docs/wiki/workspace-self-heal.md`
- Run: `pnpm wiki:index`

- [ ] **Step 1: Pick a seat worktree and make it stale on purpose**

Choose an idle seat (check `musterd status`; wanderer or ryder if offline). In its worktree, downgrade ONE guidance file's stamp by hand — e.g. edit the `<!-- musterd:content v23 ... -->` line of `.musterd/skill/orient.md` to `v22`. Confirm `musterd init --check` there reports 1 stale guidance file.

- [ ] **Step 2: Build this branch's dist into that worktree and start a fresh session there**

`pnpm -r build` in THIS branch's worktree; then in the target worktree run the SessionStart hook's command by hand first: `musterd init --check-build` — expect the one line `musterd: repaired 1 guidance file.`; expect `musterd init --check` now clean. Then start a real session in that worktree (or ask nick to) and capture the `SessionStart hook additional context` line from its transcript.

- [ ] **Step 3: Read the audit row back**

`sqlite3 ~/.musterd/musterd.db "select datetime(ts/1000,'unixepoch'), actor, action, detail from audit where action='workspace.repaired' order by ts desc limit 1"` — expect the seat, and `detail` matching the line.

- [ ] **Step 4: Write the wiki page**

```markdown
# Workspace self-heal

A seat whose guidance or in-worktree hooks are behind the installed build repairs them at session start and records one audit row — measured live on <seat>, <date>.

## The measurement (<date>)

<the exact line from the SessionStart hook context, the audit row, the `init --check` before/after, the build sha>

## What it will never touch

The ADR 261 permission floor, and any file outside the seat's worktree (Codex's common-dir hooks.json) — spec 2026-09-16, ADR 407. Falsify: put a seat's `.claude/settings.local.json` one floor entry short, start a session, and check the entry is STILL absent and the line names `--refresh-permissions`. <!-- claim: other -->

## Related

[the-instrument-discharges-the-act](the-instrument-discharges-the-act.md), ADR 407, `docs/superpowers/specs/2026-09-16-workspace-self-heal-design.md`.
```

- [ ] **Step 5: Gates, PR**

Run: `pnpm wiki:index && node scripts/format.ts --check && pnpm change-adr:check && pnpm -r build && pnpm typecheck && pnpm perf:check && pnpm context:check && pnpm lint`
Then push the branch, open the PR titled `A stale workspace repairs itself at session start (increment 3 of the 2026-09-16 spec, ADR 407)`, body listing the four commits and the live measurement, and `lane_update` `01M2NV5JNY` with the branch. Merge on nick's word; `lane_submit`; do what the reply says.

---

## Increment 4 — drift on every inbox check

### Task 9: The drift cache — CLI writes it

**Files:**
- Create: `packages/cli/src/onboard/driftCache.ts`
- Modify: `packages/protocol/src/workspace.ts` — add `DriftCacheSchema`
- Modify: the `musterd inbox --interrupt-check` code path (`packages/cli/src/commands/inbox.ts`; find the branch that handles `--interrupt-check`) — call `refreshDriftCache` before the probe
- Test: `packages/cli/src/onboard/driftCache.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // protocol/workspace.ts
  export const DriftCacheSchema = z.object({
    inspected_at: z.number().int(),
    build: z.string(),
    guidance: z.number().int().min(0),
    hooks: z.number().int().min(0),
    permissions: z.number().int().min(0),
    declined: z.boolean(),
  });
  export type DriftCache = z.infer<typeof DriftCacheSchema>;
  // cli/onboard/driftCache.ts
  export const DRIFT_CACHE_TTL_MS = 10 * 60 * 1000;
  export function driftCachePath(cwd: string): string; // <cwd>/.musterd/drift.json
  export function readDriftCache(cwd: string): DriftCache | null; // null when absent/unparseable
  export function refreshDriftCache(cwd: string, deps: { daemonBuild: string | undefined; now: number; inspect?: typeof inspectArtifactDrift; declined?: (cwd: string) => boolean }): DriftCache;
  ```
  Re-inspects when the cache is absent, older than `DRIFT_CACHE_TTL_MS`, or `deps.daemonBuild` is defined and differs from `cache.build`. Writes with `writeJsonAtomic`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/src/onboard/driftCache.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRIFT_CACHE_TTL_MS, driftCachePath, readDriftCache, refreshDriftCache } from './driftCache.js';

describe('drift cache', () => {
  const dirs: string[] = [];
  const dir = () => { const d = mkdtempSync(join(tmpdir(), 'musterd-drift-')); mkdirSync(join(d, '.musterd')); dirs.push(d); return d; };
  afterEach(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const drifted = { guidance: ['a'], hooks: [], permissions: ['x'] };

  it('inspects and writes when absent', () => {
    const d = dir();
    const inspect = vi.fn(() => drifted);
    const c = refreshDriftCache(d, { daemonBuild: 'abc', now: 1000, inspect, declined: () => false });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(c).toEqual({ inspected_at: 1000, build: 'abc', guidance: 1, hooks: 0, permissions: 1, declined: false });
    expect(JSON.parse(readFileSync(driftCachePath(d), 'utf8'))).toEqual(c);
  });

  it('does not re-inspect inside the TTL with the same build', () => {
    const d = dir();
    const inspect = vi.fn(() => drifted);
    refreshDriftCache(d, { daemonBuild: 'abc', now: 1000, inspect, declined: () => false });
    refreshDriftCache(d, { daemonBuild: 'abc', now: 1000 + DRIFT_CACHE_TTL_MS - 1, inspect, declined: () => false });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('re-inspects when the TTL passes, and immediately when the daemon build changes', () => {
    const d = dir();
    const inspect = vi.fn(() => drifted);
    refreshDriftCache(d, { daemonBuild: 'abc', now: 1000, inspect, declined: () => false });
    refreshDriftCache(d, { daemonBuild: 'abc', now: 1000 + DRIFT_CACHE_TTL_MS, inspect, declined: () => false });
    refreshDriftCache(d, { daemonBuild: 'def', now: 1001 + DRIFT_CACHE_TTL_MS, inspect, declined: () => false });
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it('readDriftCache is null on absent or garbage', () => {
    const d = dir();
    expect(readDriftCache(d)).toBeNull();
    writeFileSync(driftCachePath(d), '{nope');
    expect(readDriftCache(d)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement** (`driftCache.ts` per the Interfaces; `readDriftCache` parses with `DriftCacheSchema.safeParse`; `refreshDriftCache` returns the cache it read when fresh, else inspects, builds the record, `writeJsonAtomic`s it, returns it). In `commands/inbox.ts`'s `--interrupt-check` branch, before the probe: `try { refreshDriftCache(process.cwd(), { daemonBuild: <the build the probe already learned, or undefined>, now: Date.now() }); } catch { /* never noise on the interrupt line */ }`.

- [ ] **Step 4: Run — passes; cli suite green**

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard/driftCache.ts packages/cli/src/onboard/driftCache.test.ts packages/protocol/src/workspace.ts packages/cli/src/commands/inbox.ts
git commit -m "cli: .musterd/drift.json — provisioning drift cached on the interrupt-check cadence (10m / daemon build change)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

(Amend ADR 407's Consequences with one line naming the cache file; `change-adr:check` needs the ADR modified in the same PR as the protocol edit.)

### Task 10: `structuredContent.workspace` on inbox check — adapter reads it

**Files:**
- Modify: `packages/mcp/src/tools/format.ts` — add `workspaceOf(cwd, adapterBuild, daemonBuild)`
- Modify: `packages/mcp/src/tools/inboxCheck.ts:337` and `:519` (both `structuredContent` blocks)
- Test: `packages/mcp/src/tools/inboxCheck.test.ts` (the existing structuredContent tests from lane `01M2NRYJEQ`)

**Interfaces:**
- Consumes: `DriftCacheSchema` from `@musterd/protocol` (Task 9). The adapter reads `<cwd>/.musterd/drift.json` itself with `readFileSync` + `DriftCacheSchema.safeParse` — **no import from `@musterd/cli`**.
- Produces:
  ```ts
  export interface WorkspaceFact {
    build: { adapter: string | undefined; daemon: string | undefined; stale: boolean };
    provisioning: { guidance: number; hooks: number; permissions: number; repairable_at: 'session-start' | 'manual'; declined: boolean; inspected_at: number } | null;
  }
  /** null when nothing is stale — a structured-first reader renders nothing rather than an empty object. */
  export function workspaceOf(cwd: string, adapterBuild: string | undefined, daemonBuild: string | undefined): WorkspaceFact | null;
  ```
  `repairable_at` is `'session-start'` when `guidance + hooks > 0 && !declined`, else `'manual'`.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/mcp/src/tools/inboxCheck.test.ts, inside the structuredContent describe
  it('structuredContent.workspace carries the drift cache when stale and is absent when clean', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'musterd-ws-'));
    mkdirSync(join(cwd, '.musterd'));
    writeFileSync(join(cwd, '.musterd', 'drift.json'), JSON.stringify({ inspected_at: 1, build: 'abc', guidance: 2, hooks: 0, permissions: 1, declined: false }));
    const res = await inboxCheckWith({ cwd }); // use whatever helper the file already uses to invoke the tool with a fake client; pass cwd through
    expect(res.structuredContent.workspace).toEqual({
      build: { adapter: expect.any(String), daemon: expect.any(String), stale: expect.any(Boolean) },
      provisioning: { guidance: 2, hooks: 0, permissions: 1, repairable_at: 'session-start', declined: false, inspected_at: 1 },
    });
    writeFileSync(join(cwd, '.musterd', 'drift.json'), JSON.stringify({ inspected_at: 1, build: 'abc', guidance: 0, hooks: 0, permissions: 0, declined: false }));
    const clean = await inboxCheckWith({ cwd });
    expect(clean.structuredContent.workspace).toBeUndefined();
    rmSync(cwd, { recursive: true, force: true });
  });
```

Read the top of `inboxCheck.test.ts` for how the tool is invoked and how `cwd` (or the adapter's config) reaches it; thread a `cwd` the same way `buildSkewOf` gets `client.build`.

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement `workspaceOf` in `format.ts` and spread `...(workspace ? { workspace } : {})` into both `structuredContent` objects in `inboxCheck.ts`**, computing `const workspace = workspaceOf(cwd, client.build, await client.daemonBuild().catch(() => undefined))` once per call, next to the `warnings` array at line 508 and equivalently at the empty-inbox path.

- [ ] **Step 4: Run — passes; mcp suite green; `pnpm typecheck`**

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/tools/format.ts packages/mcp/src/tools/inboxCheck.ts packages/mcp/src/tools/inboxCheck.test.ts
git commit -m "mcp: structuredContent.workspace — provisioning drift beside the build-skew warning on every inbox check

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11: PR for increment 4

- [ ] Gates: `pnpm -r build && pnpm typecheck && pnpm perf:check && pnpm context:check && pnpm lint && node scripts/format.ts --check && pnpm change-adr:check`.
- [ ] Coordinate: message stanley on `01M2NRYJEQ` with the final `workspace` shape before opening the PR; if his lane has moved the `warnings` assembly, rebase onto it rather than around it.
- [ ] PR titled `Every inbox check says whether this workspace is stale (increment 4 of the 2026-09-16 spec)`; merge on nick's word; `lane_submit`.

---

## Increment 5 — the Codex common-dir copy moves to the auto-refresher

### Task 12: Refresh the shared Codex hooks on the bounce

**Files:**
- Modify: `packages/cli/src/commands/service.ts` — in the auto-refresh tick, after the bounce succeeds and before `announceRefreshBounce` (~line 1472)
- Test: the existing auto-refresh test file (`ls packages/cli/src/commands/service*.test.ts`), one new case

**Interfaces:**
- Consumes: `installCodexHooks(worktreeRoot: string): string | undefined` from `onboard/harnesses/codexHooks.ts` (Task 3 made it return the path).

- [ ] **Step 1: Write the failing test** — in the auto-refresh test, with the tick's deps stubbed the way the existing bounce test stubs them, assert that a successful bounce calls an injected `refreshSharedHooks(checkoutDir)` exactly once and that a failed bounce does not.

- [ ] **Step 2: Run — fails**

- [ ] **Step 3: Implement** — add `refreshSharedHooks?: (dir: string) => string | undefined` to the tick's deps (default `installCodexHooks`); call it after the bounce with the shared checkout path the tick already knows; on a returned path, append `, refreshed the shared Codex hooks` to the bounce's `status_update` body in `announceRefreshBounce` (pass a flag through). Never throw: wrap in `try/catch` and log through the tick's `ok` callback.

- [ ] **Step 4: Run — passes**

- [ ] **Step 5: Commit, PR titled `The auto-refresher owns the shared Codex hooks (increment 5 of the 2026-09-16 spec)`; merge on nick's word; `lane_submit`; the lane closes with this increment.**

---

## Self-review (run before handing this plan over)

- **Spec coverage.** Security table → Tasks 3, 4, 6 (permissions never written: Task 6 has no permissions call; outside-worktree: Task 3; kill switch and checkout-behind: Task 4). Atomic write → Tasks 1–2. Audit row + route → Tasks 5, 7. SessionStart path → Tasks 6–7. Recurring seam → Tasks 9–10. Agent-facing lines → Task 6 (`composeLine`) and Task 10 (the fact stanley's lane renders). Codex common-dir ownership → Task 12. Live measurement → Task 8. `--check-build` stays → Task 7 edits the body of `runSessionProbe` only.
- **Placeholders.** None: every step has code or an exact command. Two steps say "copy the helper from `claim-http.test.ts`" / "read the top of `inboxCheck.test.ts`" — those name the file and what to take, which is the instruction.
- **Type consistency.** `runRefreshHooks` returns `{ code, files, skipped, refused }` in Task 3 and is consumed that way in Task 6's `SelfHealDeps.refreshHooks`. `WorkspaceRepairBody.skipped[].reason` is the same four-value enum in Tasks 5 and 6. `DriftCache` fields in Task 9 are the fields `workspaceOf` reads in Task 10. `installCodexHooks` returns `string | undefined` in Tasks 3 and 12.
