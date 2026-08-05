# Seat Footprint Implementation Plan

> **For agentic workers:** Per CLAUDE.md, this repo uses musterd lanes, not subagents. Execute inline in the owning seat's session (lane 01KZ9ZVZB5). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-agent machine cost measurable, dieted, and reapable — Phase 0 ops diet for the 8 GB laptop, then the daemon footprint sampler, `musterd reap`, and status surfacing.

**Architecture:** A pure classifier (allowlist → stacks → live/orphaned/unattributed) is written once and used twice: first by a standalone perf probe script (Phase 0), then inside the daemon as a periodic sampler persisting to a `footprint` table. The CLI reads the daemon over HTTP (`GET /footprint`); reaping is daemon-side (`POST /footprint/reap`) so kill + re-verify + audit live in one place.

**Tech Stack:** TypeScript ESM (Node 22), better-sqlite3 via existing db layer, vitest, `ps`/`vm_stat`/`sysctl`/`lsof` on darwin behind a platform module.

**Spec:** `docs/superpowers/specs/2026-08-05-seat-footprint-design.md`

## Global Constraints

- **Git loop (ADR 106):** branch from fresh `origin/main` → PR → `gh pr merge --squash --auto --delete-branch`. Three product PRs: (1) sampler + doctor read-only + ADR, (2) reap, (3) status surfacing.
- **ADR number picked late** against `origin/main` right before PR 1 (collision trap); ADR must include an `## Observability & Evaluation` section (CI gate).
- **vitest runs from repo root only:** `pnpm exec vitest run <path>`.
- **Never `pnpm format`** — `pnpm exec prettier --write <changed files>` only. `pnpm lint` is a separate gate; build before typecheck (phantom .d.ts errors).
- **ESM imports carry `.js` suffix** (match every existing module).
- **Warn-never-block:** no surface ever blocks a launch or a claim; reap only ever kills allowlist matches, re-verified at kill time, SIGTERM → 3 s grace → SIGKILL, audited.
- **Ambiguity is honest:** unattributable stacks are `unattributed`, never guessed onto a seat.
- **Ops steps that touch live processes or nick's global config require nick's go-ahead in-session** (they act outside this repo).

## File Structure

```
scripts/perf/seat-footprint.mjs            Phase 0 probe (standalone, no imports from src)
docs/perf/seat-footprint.md                measurement log (append-only)
packages/server/src/footprint/classify.ts  pure: allowlist, stack grouping, classification
packages/server/src/footprint/classify.test.ts
packages/server/src/footprint/scan.ts      darwin: ps / vm_stat / sysctl / lsof wrappers
packages/server/src/footprint/sampler.ts   periodic tick, mirrors presence/reaper.ts
packages/server/src/footprint/sampler.test.ts
packages/server/src/store/footprint.ts     footprint table access + retention
packages/server/src/store/footprint.test.ts
packages/server/src/db/migrations.ts       +1 migration (footprint table)
packages/server/src/config.ts              footprintIntervalMs / footprintRetentionMs knobs
packages/server/src/index.ts               start/stop sampler wiring
packages/server/src/transport/http.ts      GET /footprint, POST /footprint/reap
packages/cli/src/commands/reap.ts          musterd reap [--yes]
packages/cli/src/commands/reap.test.ts
packages/cli/src/commands/status.ts        machine line + per-seat cost chip
packages/cli/src/onboard/doctor.ts         orphan report line
docs/adr/NNN-seat-footprint.md             ADR (number picked at PR time)
```

---

### Task 1: Phase 0 probe script + baseline snapshot

**Files:**
- Create: `scripts/perf/seat-footprint.mjs`
- Create: `docs/perf/seat-footprint.md`

**Interfaces:**
- Produces: a runnable probe (`node scripts/perf/seat-footprint.mjs [--json]`) whose classification rules are the reference the TS port in Task 3 must match.

- [ ] **Step 1: Write the probe script.** Standalone `.mjs` (pattern: `scripts/perf/live-baseline.mjs` — no imports from `packages/`). Core:

```js
#!/usr/bin/env node
// Seat footprint probe (Phase 0 of the seat-footprint design).
// Snapshot of: swap, free memory, MCP sidecar stacks (live/orphaned), process counts.
import { execFileSync } from 'node:child_process';

const SIDECAR_PATTERNS = [
  /packages\/mcp\/dist\/index\.js/, // musterd's own MCP server
  /\bnpm exec\b.*mcp/i,
  /\bmcp-remote\b/,
  /\bmcp-server-[\w-]+/,
  /\b[\w-]+-mcp\b/,                 // chrome-devtools-mcp, playwright-mcp, elevenlabs-mcp
  /\bmcp-pdf-server\b/,
  /flyctl mcp server/,
];
const HARNESS_PATTERNS = [/\bclaude\b/i, /Cursor/, /cursor-agent/, /\bcodex\b/i];

function ps() {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m && { pid: +m[1], ppid: +m[2], rssKb: +m[3], command: m[4] };
  }).filter(Boolean);
}

function swap() {
  const out = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
  const m = out.match(/total = ([\d.]+)M\s+used = ([\d.]+)M/);
  return m ? { totalMb: +m[1], usedMb: +m[2] } : null;
}

function freePages() {
  const out = execFileSync('vm_stat', [], { encoding: 'utf8' });
  const page = +(out.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const free = +(out.match(/Pages free:\s+(\d+)\./)?.[1] ?? 0);
  return Math.round((free * page) / 1024 / 1024); // MB
}

const procs = ps();
const byPid = new Map(procs.map((p) => [p.pid, p]));
const isSidecar = (p) => SIDECAR_PATTERNS.some((r) => r.test(p.command));
const isHarness = (p) => HARNESS_PATTERNS.some((r) => r.test(p.command));

// Classify each sidecar: orphaned (reparented to launchd), live (a harness
// ancestor), else unattributed. Live stacks group by nearest non-sidecar parent.
function classify(p) {
  if (p.ppid === 1) return 'orphaned';
  let cur = byPid.get(p.ppid);
  for (let hops = 0; cur && hops < 20; hops++) {
    if (isHarness(cur)) return 'live';
    cur = byPid.get(cur.ppid);
  }
  return 'unattributed';
}

const sidecars = procs.filter(isSidecar);
const stacks = new Map(); // key: classification==='live' ? root parent pid : 'orphaned'/'unattributed'
for (const p of sidecars) {
  const c = classify(p);
  const key = c === 'live' ? `live:${p.ppid}` : c;
  const s = stacks.get(key) ?? { key, procs: 0, rssKb: 0 };
  s.procs += 1; s.rssKb += p.rssKb;
  stacks.set(key, s);
}

const snap = {
  ts: new Date().toISOString(),
  swap: swap(), freeMemMb: freePages(),
  sidecarProcs: sidecars.length,
  stacks: [...stacks.values()].sort((a, b) => b.rssKb - a.rssKb),
  orphanedProcs: sidecars.filter((p) => classify(p) === 'orphaned').length,
};
if (process.argv.includes('--json')) console.log(JSON.stringify(snap, null, 2));
else {
  console.log(`# ${snap.ts}`);
  console.log(`swap ${snap.swap?.usedMb}/${snap.swap?.totalMb} MB · free mem ${snap.freeMemMb} MB`);
  console.log(`sidecars ${snap.sidecarProcs} procs (${snap.orphanedProcs} orphaned) in ${snap.stacks.length} stacks`);
  for (const s of snap.stacks) console.log(`  ${s.key}: ${s.procs} procs, ${Math.round(s.rssKb / 1024)} MB RSS`);
}
```

- [ ] **Step 2: Run it and sanity-check** against the hand measurements from 2026-08-05 (≈13 stacks, 100+ sidecar procs, swap ≈10 GB): `node scripts/perf/seat-footprint.mjs`. Expected: same order of magnitude; orphaned count > 0.
- [ ] **Step 3: Create the log** `docs/perf/seat-footprint.md` with a short header (what the probe measures, how to run it) and paste the baseline snapshot under `## 2026-08-05 baseline (pre-diet)`.
- [ ] **Step 4: Commit** on the lane branch: `git add scripts/perf/seat-footprint.mjs docs/perf/seat-footprint.md && git commit -m "perf: seat-footprint probe + baseline snapshot"`.

### Task 2: Phase 0 ops pass (with nick, in-session)

**Files:** none in-repo except appending snapshots to `docs/perf/seat-footprint.md`.

This task is operational; each step shows nick exactly what it will do before doing it, and re-runs the probe after.

- [ ] **Step 1: Orphan reap (manual).** Print the kill list first: pids from the probe classified `orphaned` (ppid 1 + sidecar match), with commands. On nick's go: `kill <pids>`, wait 3 s, `kill -9` survivors. Re-run probe; append snapshot `## post-orphan-reap`.
- [ ] **Step 2: MCP config diet.** Snapshot `~/.claude.json` (and the desktop app's config) to the scratchpad first. With nick: keep `musterd` global; move/remove ElevenLabs, Figma, Supabase ×2, Playwright, chrome-devtools, flyctl, pdf, cloudflare (per-project `.mcp.json` where a repo really uses one). Nick restarts sessions at his convenience.
- [ ] **Step 3: Placement + restart (nick's).** Terminal `claude` for worker seats, desktop app for 1–2 interactive seats, staggered launches; one OS restart to drain swap.
- [ ] **Step 4: The 5-seat stagger test.** After restart: launch 5 working seats staggered, run the probe every ~5 min for ~30 min, append the curve as `## post-diet 5-seat test`. Success: swap stable, UI responsive. Record the verdict (holds / honest ceiling is N).

### Task 3: `classify.ts` — the pure core (TDD)

**Files:**
- Create: `packages/server/src/footprint/classify.ts`
- Test: `packages/server/src/footprint/classify.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProcSample { pid: number; ppid: number; rssKb: number; command: string }
  export interface SidecarStack {
    key: string;                       // 'live:<parentPid>' | 'orphaned' | 'unattributed'
    classification: 'live' | 'orphaned' | 'unattributed';
    parentPid: number | null;          // set for live stacks
    procs: number; rssKb: number; pids: number[];
  }
  export function isSidecar(command: string): boolean
  export function classifyProc(p: ProcSample, byPid: Map<number, ProcSample>): 'live' | 'orphaned' | 'unattributed'
  export function buildStacks(procs: ProcSample[]): SidecarStack[]
  ```
- Consumes: nothing (pure). The regex lists are the same as Task 1's script — copy them verbatim so probe and product agree.

- [ ] **Step 1: Write failing tests** with synthetic fixtures:

```ts
import { describe, expect, it } from 'vitest';
import { buildStacks, classifyProc, isSidecar, type ProcSample } from './classify.js';

const harness = (pid: number): ProcSample => ({ pid, ppid: 1, rssKb: 100_000, command: '/Users/n/.local/bin/claude' });
const sidecar = (pid: number, ppid: number, cmd = 'npm exec chrome-devtools-mcp@1.6.0'): ProcSample =>
  ({ pid, ppid, rssKb: 20_000, command: cmd });

describe('isSidecar', () => {
  it('matches the sidecar families', () => {
    for (const cmd of [
      'node /Users/n/agents/packages/mcp/dist/index.js',
      'npm exec @playwright/mcp@latest',
      'npm exec mcp-remote https://x/mcp',
      'node .../mcp-server-supabase --access-token',
      'chrome-devtools-mcp',
      '/Users/n/.fly/bin/flyctl mcp server',
      'node .../mcp-pdf-server --stdio',
    ]) expect(isSidecar(cmd), cmd).toBe(true);
  });
  it('does not match the daemon, plain node, or the CLI', () => {
    for (const cmd of ['node packages/cli/dist/bin.js serve', 'node build.js', '/bin/zsh'])
      expect(isSidecar(cmd), cmd).toBe(false);
  });
});

describe('classifyProc / buildStacks', () => {
  it('groups sidecars under a living harness ancestor as one live stack', () => {
    const procs = [harness(10), sidecar(11, 10), sidecar(12, 10), sidecar(13, 12)]; // 13 nested under 12
    const stacks = buildStacks(procs);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]).toMatchObject({ classification: 'live', procs: 3 });
  });
  it('reparented sidecars (ppid 1) are orphaned even though launchd is everyone’s ancestor', () => {
    const procs = [sidecar(20, 1)];
    expect(buildStacks(procs)[0]!.classification).toBe('orphaned');
  });
  it('a sidecar with no harness ancestor and a living parent is unattributed, never guessed', () => {
    const shell: ProcSample = { pid: 30, ppid: 1, rssKb: 1000, command: '/bin/zsh' };
    const procs = [shell, sidecar(31, 30)];
    expect(buildStacks(procs)[0]!.classification).toBe('unattributed');
  });
  it('sums rss and collects pids per stack', () => {
    const procs = [harness(10), sidecar(11, 10), sidecar(12, 10)];
    const s = buildStacks(procs)[0]!;
    expect(s.rssKb).toBe(40_000);
    expect(s.pids.sort()).toEqual([11, 12]);
  });
});
```

- [ ] **Step 2: Run to verify failure:** `pnpm exec vitest run packages/server/src/footprint/classify.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** — port Task 1's `SIDECAR_PATTERNS`/`HARNESS_PATTERNS`/`classify` verbatim into typed exports; `buildStacks` filters `isSidecar`, classifies each, groups live procs by their *nearest non-sidecar ancestor* pid (walk ppid chain past sidecar parents so nested sidecars join their launcher's stack), aggregates orphaned and unattributed into one stack each.
- [ ] **Step 4: Run to verify pass**, then `pnpm exec prettier --write packages/server/src/footprint/classify*`.
- [ ] **Step 5: Commit** `feat(server): footprint classifier — sidecar allowlist, stacks, live/orphaned/unattributed`.

### Task 4: `scan.ts` — darwin platform wrappers

**Files:**
- Create: `packages/server/src/footprint/scan.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MachineSample { swapUsedMb: number | null; swapTotalMb: number | null; freeMemMb: number | null }
  export function scanProcesses(): ProcSample[]          // ps -axo pid=,ppid=,rss=,args=
  export function scanMachine(): MachineSample           // sysctl vm.swapusage + vm_stat
  ```
  Both throw on exec failure — callers decide what a skipped tick means. Non-darwin: both throw `new Error('footprint: unsupported platform')`; the sampler (Task 6) catches and disables itself with one log line.
- Consumes: `ProcSample` from `./classify.js`.

- [ ] **Step 1: Implement** by porting Task 1's `ps()`, `swap()`, `freePages()` bodies (execFileSync, same regexes). No unit tests for the exec wrappers themselves (they are thin and platform-bound); the parsing regexes are already exercised transitively in Task 1's live runs — keep functions small enough that this is honest.
- [ ] **Step 2: Typecheck:** `pnpm build && pnpm typecheck` (build first — phantom .d.ts trap). Expected: clean.
- [ ] **Step 3: Commit** `feat(server): darwin footprint scanners (ps, swapusage, vm_stat)`.

### Task 5: migration + `store/footprint.ts` (TDD, through-DB)

**Files:**
- Modify: `packages/server/src/db/migrations.ts` (append next free version; v33 was latest at plan time)
- Create: `packages/server/src/store/footprint.ts`
- Test: `packages/server/src/store/footprint.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FootprintStackRow {
    ts: number; classification: 'live' | 'orphaned' | 'unattributed';
    seat: string | null;               // attributed seat name, if known
    procs: number; rss_kb: number; pids: string; // pids JSON-encoded
  }
  export interface FootprintMachineRow {
    ts: number; swap_used_mb: number | null; swap_total_mb: number | null; free_mem_mb: number | null;
  }
  export function insertFootprintTick(db: Database, stacks: FootprintStackRow[], machine: FootprintMachineRow): void
  export function latestFootprint(db: Database): { ts: number; stacks: FootprintStackRow[]; machine: FootprintMachineRow } | null
  export function pruneFootprint(db: Database, cutoffTs: number): number
  ```
- Consumes: db handle from `packages/server/src/db/open.ts` (same as sibling stores).

Migration (single table keeps read/prune trivial; machine row is the `classification='machine'`-free sibling table):

```sql
CREATE TABLE footprint_stacks (
  ts INTEGER NOT NULL, classification TEXT NOT NULL, seat TEXT,
  procs INTEGER NOT NULL, rss_kb INTEGER NOT NULL, pids TEXT NOT NULL
);
CREATE INDEX idx_footprint_stacks_ts ON footprint_stacks(ts);
CREATE TABLE footprint_machine (
  ts INTEGER PRIMARY KEY, swap_used_mb INTEGER, swap_total_mb INTEGER, free_mem_mb INTEGER
);
```

- [ ] **Step 1: Write failing through-DB test** (pattern: sibling `store/*.test.ts` — open an in-memory/migrated db, no mocks):

```ts
import { describe, expect, it } from 'vitest';
import { openTestDb } from '../db/db.test-helpers.js'; // use whatever helper sibling store tests use — check store/rows.test.ts and mirror it
import { insertFootprintTick, latestFootprint, pruneFootprint } from './footprint.js';

describe('footprint store', () => {
  it('round-trips a tick and returns only the latest', () => {
    const db = openTestDb();
    insertFootprintTick(db, [{ ts: 1000, classification: 'orphaned', seat: null, procs: 41, rss_kb: 600_000, pids: '[1,2]' }],
      { ts: 1000, swap_used_mb: 9000, swap_total_mb: 11264, free_mem_mb: 120 });
    insertFootprintTick(db, [{ ts: 2000, classification: 'live', seat: 'kimi', procs: 3, rss_kb: 90_000, pids: '[7]' }],
      { ts: 2000, swap_used_mb: 8000, swap_total_mb: 11264, free_mem_mb: 300 });
    const latest = latestFootprint(db)!;
    expect(latest.ts).toBe(2000);
    expect(latest.stacks).toHaveLength(1);
    expect(latest.stacks[0]!.seat).toBe('kimi');
    expect(latest.machine.swap_used_mb).toBe(8000);
  });
  it('prunes rows older than the cutoff and reports the count', () => {
    const db = openTestDb();
    insertFootprintTick(db, [{ ts: 1000, classification: 'live', seat: null, procs: 1, rss_kb: 1, pids: '[]' }],
      { ts: 1000, swap_used_mb: null, swap_total_mb: null, free_mem_mb: null });
    expect(pruneFootprint(db, 1500)).toBeGreaterThan(0);
    expect(latestFootprint(db)).toBeNull();
  });
});
```

(If there is no shared `openTestDb` helper, mirror exactly how `store/rows.test.ts` opens its db.)

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** migration + store (prepared statements, one transaction per tick; `latestFootprint` = max(ts) over `footprint_machine`, stacks where `ts = that max`).
- [ ] **Step 4: Run to verify pass;** run the whole db suite too: `pnpm exec vitest run packages/server/src/db packages/server/src/store/footprint.test.ts`.
- [ ] **Step 5: Commit** `feat(server): footprint table + store (tick insert, latest, retention prune)`.

### Task 6: sampler + config + wiring

**Files:**
- Create: `packages/server/src/footprint/sampler.ts`
- Test: `packages/server/src/footprint/sampler.test.ts`
- Modify: `packages/server/src/config.ts` (add `footprintIntervalMs` — env `MUSTERD_FOOTPRINT_INTERVAL_MS`, default 60_000; `footprintRetentionMs` — env `MUSTERD_FOOTPRINT_RETENTION_MS`, default 7 days; follow `reaperIntervalMs` at config.ts:204 exactly)
- Modify: `packages/server/src/index.ts` (start/stop beside `startReaper` — see index.ts:165 and :206)

**Interfaces:**
- Produces: `export function startFootprintSampler(ctx: Ctx, deps?: { scanProcs?: typeof scanProcesses; scanMachine?: typeof scanMachine }): () => void` — deps injectable for tests; returns stop fn (mirror `startReaper`'s `setInterval` + `unref` + cleanup shape at reaper.ts:190-193).
- Consumes: `buildStacks` (Task 3), `scanProcesses`/`scanMachine` (Task 4), `insertFootprintTick`/`pruneFootprint` (Task 5).

Seat attribution in the tick: for each **live** stack, if any proc's command matches `packages/mcp/dist/index.js`, look up which seat: query the presence table for live sessions and match by... **nothing reliable exists in the command line.** So v1 attributes stacks to seats only when exactly one live seat exists (trivially unambiguous); otherwise `seat: null` and the stack shows unattributed-by-seat but still `live`. This is the honest floor; per-seat attribution via `lsof -a -p <pid> -d cwd` → workspace → binding is a **follow-up noted in the ADR**, not built now (lsof per tick is a cost decision that deserves its own measurement).

- [ ] **Step 1: Write failing test** — injected fake scanners, real db:

```ts
it('a tick persists stacks + machine row and prunes beyond retention', () => {
  const db = openTestDb(); const ctx = testCtx(db); // mirror reaper.test.ts's ctx construction
  const stop = startFootprintSampler(ctx, {
    scanProcs: () => [ { pid: 10, ppid: 1, rssKb: 1, command: '/Users/n/.local/bin/claude' },
                       { pid: 11, ppid: 10, rssKb: 5, command: 'npm exec chrome-devtools-mcp' } ],
    scanMachine: () => ({ swapUsedMb: 9000, swapTotalMb: 11264, freeMemMb: 100 }),
  });
  vi.advanceTimersByTime(ctx.config.footprintIntervalMs + 1);
  const latest = latestFootprint(db)!;
  expect(latest.stacks[0]).toMatchObject({ classification: 'live', procs: 1 });
  expect(latest.machine.swap_used_mb).toBe(9000);
  stop();
});
it('a scanner throw skips the tick and never throws out of the timer', () => {
  const ctx = testCtx(openTestDb());
  const stop = startFootprintSampler(ctx, { scanProcs: () => { throw new Error('no ps'); },
                                            scanMachine: () => ({ swapUsedMb: null, swapTotalMb: null, freeMemMb: null }) });
  expect(() => vi.advanceTimersByTime(ctx.config.footprintIntervalMs + 1)).not.toThrow();
  stop();
});
```

(Use `vi.useFakeTimers()` in `beforeEach` exactly as `reaper.test.ts` does — check and mirror it.)

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** sampler (try/catch whole tick → `log.info({ msg: 'footprint_skip', err })`; prune with `Date.now() - ctx.config.footprintRetentionMs` each tick) + config knobs + index.ts wiring.
- [ ] **Step 4: Run to verify pass;** then full server suite: `pnpm exec vitest run packages/server`.
- [ ] **Step 5: Commit** `feat(server): footprint sampler tick + config knobs, wired into serve`.

### Task 7: HTTP surface — `GET /footprint`, `POST /footprint/reap`

**Files:**
- Modify: `packages/server/src/transport/http.ts` (follow the existing route-registration pattern in that file — find how `GET /messages` (ADR 061) is registered and mirror auth/shape)
- Test: colocated with the existing http tests (find `http.test.ts` or the transport test file and add there)

**Interfaces:**
- Produces:
  - `GET /footprint` → `{ ts, stacks: FootprintStackRow[], machine: FootprintMachineRow } | 404` (404 when no tick yet — older daemon compatibility comes free: CLI treats any non-200 as "no data").
  - `POST /footprint/reap` body `{ pids: number[] }` → `{ killed: number[], refused: { pid: number, reason: string }[] }`. For each pid: re-read the live process table (`scanProcesses()`), refuse unless the pid **still** matches `isSidecar` AND classifies `orphaned` (reason: `not_found` | `not_sidecar` | `not_orphaned`); SIGTERM survivors → 3 s grace (`setTimeout`) → SIGKILL; then `appendAudit(db, teamId, …)` one `footprint.reaped` entry with `{ pids, rss_kb }` (see `appendAudit` at store/audit.ts:281 for the entry shape).
- Consumes: Tasks 3–5 exports.

- [ ] **Step 1: Write failing tests** — through the http layer like the file's existing tests: (a) GET with no data → 404; (b) after an `insertFootprintTick`, GET returns it; (c) POST with a pid that is not a sidecar (inject scanner returning a `/bin/zsh` row) → `refused: [{ reason: 'not_sidecar' }]`, kill fn never called; (d) POST with an injected orphaned sidecar → kill fn called with SIGTERM, audit row appended (assert via `listAudit`). Inject `scanProcs` and `kill` (default `process.kill`) through the route's construction the same way the sampler takes deps.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass** + `pnpm build && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** `feat(server): footprint http surface — read + audited allowlist-only reap`.

### Task 8: ADR + PR 1 (read-only increment)

**Files:**
- Create: `docs/adr/NNN-seat-footprint.md`
- Modify: `packages/cli/src/onboard/doctor.ts` (orphan report line)

- [ ] **Step 1: Doctor line.** In the section of `doctor.ts` that prints per-harness findings, add a best-effort daemon call: `GET /footprint`; if reachable and orphaned stack present, print `• N orphaned MCP sidecar procs (~X MB) from ended sessions — musterd reap` (bullet style matches existing `•` lines); any fetch error → print nothing. Follow how doctor already talks to the daemon (search `doctor.ts` for its http client usage; if it has none, mirror `status.ts`'s client construction).
- [ ] **Step 2: Doctor test** — mirror an existing `doctor.test.ts` case; fake the http response; assert the line renders and that failure renders nothing.
- [ ] **Step 3: Write the ADR** — decisions from the spec (allowlist-only, warn-never-block, daemon-side reap, honest `unattributed`, per-seat attribution deferred with the lsof cost note), plus the required `## Observability & Evaluation` section pointing at `scripts/perf/seat-footprint.mjs` and `docs/perf/seat-footprint.md`. Pick the number: `git fetch origin main && ls docs/adr | sort | tail` and take the next free.
- [ ] **Step 4: Gates + PR.** `pnpm build && pnpm typecheck && pnpm exec vitest run packages/server packages/cli && pnpm lint && pnpm exec prettier --write <changed>` (never `pnpm format`). Branch already carries Tasks 1–8; open PR 1 (`sampler + doctor read-only + ADR`), `gh pr merge --squash --auto --delete-branch`. Watch for the bugbot no-show trap (comment `bugbot run` if the check never registers).
- [ ] **Step 5: `lane_update`** with the merged state; note in `docs/perf/seat-footprint.md` which daemon commit the sampler first ran on (autorefresh bounces it — check `~/.musterd/autorefresh/refresh.log`; remember autorefresh does NOT `pnpm install`, so if PR 1 added a dependency, tell nick — this plan adds none).

### Task 9: `musterd reap` (PR 2)

**Files:**
- Create: `packages/cli/src/commands/reap.ts`
- Test: `packages/cli/src/commands/reap.test.ts`
- Modify: CLI command registration (find where `status`/`claim` register — likely `packages/cli/src/bin.ts` or an index — and mirror)

**Interfaces:**
- Consumes: `GET /footprint`, `POST /footprint/reap` (Task 7 shapes).
- Produces: `musterd reap [--yes]` — no data → "daemon has no footprint data yet (older daemon or sampler just started)"; orphans listed with procs/MB then `run again with --yes to kill` (no interactive prompt — matches the CLI's non-interactive convention elsewhere; check `claim.ts` for precedent and follow it); with `--yes` → POST, print killed/refused.

- [ ] **Step 1: Write failing tests** (fake http like sibling command tests): list mode prints and does not POST; `--yes` POSTs and prints `killed 41 procs (~600 MB)`; refused pids print their reasons.
- [ ] **Step 2: Run to verify failure. Step 3: Implement. Step 4: Verify + gates.**
- [ ] **Step 5: Branch from fresh main → commit `feat(cli): musterd reap — audited orphan-sidecar cleanup` → PR 2 → auto-merge.** Then run it for real on the laptop and append the before/after snapshot to `docs/perf/seat-footprint.md`.

### Task 10: status surfacing (PR 3) + eval close-out

**Files:**
- Modify: `packages/cli/src/commands/status.ts` — machine header line (`machine: swap 3.2/11 GB · free 900 MB · 2 sidecar stacks` — calm, one line, only when `GET /footprint` succeeds) and a per-seat ` · N procs / X MB` suffix on roster rows where a live stack is seat-attributed (v1: usually absent — honest until attribution lands; the surface must render cleanly with zero attributed stacks)
- Test: extend the existing status tests with a faked footprint response (present → lines render; absent/error → output byte-identical to today)

- [ ] **Step 1: Failing tests. Step 2: Verify fail. Step 3: Implement. Step 4: Verify + gates.**
- [ ] **Step 5: PR 3 → auto-merge.**
- [ ] **Step 6: Eval close-out.** Re-run the 5-seat stagger test (same protocol as Task 2 step 4) with the shipped sampler running; append curves + verdict to `docs/perf/seat-footprint.md`; `team_send status_update` with the headline numbers; `lane_submit` the lane; note follow-ups for the ADR's future-work (per-seat lsof attribution, admission control thresholds now derivable from the logged curves).

## Self-Review Notes

- Spec coverage: Phase 0 → Tasks 1–2; sampler A1 → 3/4/6; storage A2 → 5; surfaces A3 → 7/8/9/10 (/live chip correctly absent — reserved for miley, only the data ships); error handling A4 → 6 step 1b, 7 refusals; testing A5 → per-task; O&E → Tasks 1, 8, 10. Gap accepted and documented: per-seat attribution is deferred in Task 6 with the ADR carrying the decision — the spec's status chip example (`14 procs / 1.1 GB`) therefore mostly won't render per-seat in v1; the machine line and orphan totals carry the value until attribution lands.
- Types: `ProcSample`/`SidecarStack`/`FootprintStackRow`/`FootprintMachineRow` used consistently across Tasks 3–10.
- No placeholders; where a repo pattern must be mirrored, the task names the concrete file to read first.
