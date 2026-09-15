# Merge-Verified Submit Implementation Plan

> **For agentic workers:** Per this machine's CLAUDE.md, do NOT use subagent-driven
> execution — implement inline in your own musterd seat/lane (lane 01M0JSKTA3YH2CTHD869X1YWCZ,
> branch `izzo/merge-verified-submit`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `lane_submit` verifies the attested merge SHA against `origin/main` seat-side and
refuses the flip to `awaiting_acceptance` on positive evidence that nothing landed; every
attestation carries a verification tier, and `review_debt` badges unattested lanes.

**Architecture:** A pure classifier module in `packages/mcp` shells out to git (injected
exec for tests); `laneSubmitHandler` calls it before `client.updateLane`. The protocol's
`merged` object gains an optional `verification` string. The server computes an `unlanded`
flag per review_debt entry; the mcp `team_next` renderer prints the badge. No server-side
enforcement, no poller.

**Tech Stack:** TypeScript, zod, vitest, node:child_process (`execFile`), better-sqlite3
(existing server store), pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-21-merge-verified-submit-design.md`

## Global Constraints

- No poller, no schedule, no background sweep (ADR 294 dec 2, ADR 297).
- Refuse only on positive evidence: `not_ancestor` (with a fresh fetch), `pr` without
  `sha`, or a malformed SHA. Everything else proceeds with a tier recorded (ADR 145).
- Field name is `verification` (NOT `verified` — `Lane.verified` already means
  "close was a counterpart acceptance", ADR 169/191; do not overload it).
- Tier values: `'ancestor' | 'unknown_object' | 'fetch_failed' | 'unattested'`.
  `not_ancestor` is a refusal outcome and never persists on a lane.
- Schema forward-compat: `verification` is `z.string().optional()` with the tier list as
  an exported const — an unknown value from a newer client must parse, not reject.
- Run `pnpm format` (never `node scripts/format.ts` bare), check exit codes without
  piping to `tail`, and `pnpm build` before `pnpm typecheck` (stale-dist guard).
- Commit trailers: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` +
  `Claude-Session: https://claude.ai/code/session_01Pz1msRhw8LPrQvDCiGyYH9`.

---

### Task 1: Protocol — `merged.verification` on Lane and UpdateLane schemas

**Files:**
- Modify: `packages/protocol/src/lanes.ts:290-297` (LaneSchema.merged) and
  `packages/protocol/src/lanes.ts:433-439` (UpdateLaneSchema.merged)
- Create: `packages/protocol/src/lanes.merged.test.ts`
- Modify: `docs/superpowers/specs/2026-08-21-merge-verified-submit-design.md`
  (rename `verified` → `verification` in the "Attestation carries its tier" section)

**Interfaces:**
- Produces: `MERGE_VERIFICATION_TIERS` const array and
  `type MergeVerification = 'ancestor' | 'unknown_object' | 'fetch_failed' | 'unattested'`,
  exported from `@musterd/protocol`; `merged.verification?: string` on Lane and UpdateLane.

- [ ] **Step 1: Write the failing test** (`packages/protocol/src/lanes.merged.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { LaneSchema, UpdateLaneSchema, MERGE_VERIFICATION_TIERS } from './lanes.js';

const base = {
  id: '01X', team: 't', project: 'p', title: 'x', surface_globs: [], depends_on: [],
  branch: null, goal_id: null, risk: [], stakes: 'normal', state: 'claimed',
  created_by: 'izzo', created_at: 1, claimed_at: null, resolved_at: null, updated_at: 1,
};

describe('merged.verification (merge-verified submit)', () => {
  it('round-trips a known tier', () => {
    const lane = LaneSchema.parse({ ...base, merged: { sha: 'abc123f', verification: 'ancestor' } });
    expect(lane.merged?.verification).toBe('ancestor');
  });
  it('parses with the field absent (older client)', () => {
    const lane = LaneSchema.parse({ ...base, merged: { sha: 'abc123f' } });
    expect(lane.merged?.verification).toBeUndefined();
  });
  it('accepts an unknown tier from a newer client rather than rejecting', () => {
    const lane = LaneSchema.parse({ ...base, merged: { verification: 'quantum_entangled' } });
    expect(lane.merged?.verification).toBe('quantum_entangled');
  });
  it('UpdateLane carries it through', () => {
    const patch = UpdateLaneSchema.parse({ merged: { pr: 7, sha: 'abc123f', verification: 'unattested' } });
    expect(patch.merged?.verification).toBe('unattested');
  });
  it('exports the tier list for renderers', () => {
    expect(MERGE_VERIFICATION_TIERS).toEqual(['ancestor', 'unknown_object', 'fetch_failed', 'unattested']);
  });
});
```

- [ ] **Step 2:** `pnpm --filter @musterd/protocol test lanes.merged` — expect FAIL
  (no `MERGE_VERIFICATION_TIERS` export, unknown key stripped is fine but import fails).
- [ ] **Step 3:** Implement. In both `merged` z.objects add:

```ts
      /**
       * Seat-side verification tier stamped by lane_submit (merge-verified submit ADR):
       * 'ancestor' (SHA reachable from origin/main — landed), 'unknown_object' (SHA not in
       * this worktree's repo — cross-repo lane), 'fetch_failed' (could not refresh
       * origin/main — abstained), 'unattested' (no SHA given). `not_ancestor` never
       * appears: it is refused at submit. A z.string, not an enum, so a newer client's
       * tier parses instead of rejecting; consumers compare against
       * MERGE_VERIFICATION_TIERS and say nothing on values they don't know.
       */
      verification: z.string().optional(),
```

Near the top-level exports add:

```ts
export const MERGE_VERIFICATION_TIERS = ['ancestor', 'unknown_object', 'fetch_failed', 'unattested'] as const;
export type MergeVerification = (typeof MERGE_VERIFICATION_TIERS)[number];
```

Also apply the spec rename (`verified:` → `verification:` in the design doc's schema line).

- [ ] **Step 4:** `pnpm --filter @musterd/protocol test lanes.merged` — expect PASS.
- [ ] **Step 5:** Commit: `feat(protocol): merged.verification tier on lane attestations`

### Task 2: `mergeVerify` classifier in packages/mcp

**Files:**
- Create: `packages/mcp/src/mergeVerify.ts`
- Create: `packages/mcp/src/mergeVerify.test.ts`

**Interfaces:**
- Consumes: `MergeVerification` type from `@musterd/protocol` (Task 1).
- Produces:
  `type VerifyOutcome = MergeVerification | 'not_ancestor'`;
  `type GitExec = (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number }>` —
  resolves with the exit code, rejects only on spawn failure/timeout;
  `SHA_FORMAT` regex `/^[0-9a-f]{7,40}$/i`;
  `verifyMerge(input: { sha?: string; cwd: string }, exec?: GitExec): Promise<VerifyOutcome>`;
  `defaultGitExec` (execFile-based).

- [ ] **Step 1: Write the failing tests:**

```ts
import { describe, expect, it } from 'vitest';
import { verifyMerge, type GitExec } from './mergeVerify.js';

/** Scripted exec: match on the git subcommand, return exit codes; 'reject' throws. */
function fake(script: Record<string, number | 'reject'>): GitExec {
  return async (args) => {
    const key = args[0] === 'merge-base' ? 'merge-base' : args[0]!; // fetch | cat-file | merge-base
    const r = script[key];
    if (r === 'reject' || r === undefined) throw new Error(`spawn failed: ${key}`);
    return { code: r };
  };
}
const cwd = '/w';

describe('verifyMerge', () => {
  it('no sha → unattested (no git calls at all)', async () => {
    const exec: GitExec = async () => { throw new Error('must not be called'); };
    expect(await verifyMerge({ cwd }, exec)).toBe('unattested');
  });
  it('fetch ok, object exists, ancestor → ancestor', async () => {
    expect(await verifyMerge({ sha: 'abc123f', cwd }, fake({ fetch: 0, 'cat-file': 0, 'merge-base': 0 })))
      .toBe('ancestor');
  });
  it('fetch ok, object exists, not an ancestor → not_ancestor (positive evidence)', async () => {
    expect(await verifyMerge({ sha: 'abc123f', cwd }, fake({ fetch: 0, 'cat-file': 0, 'merge-base': 1 })))
      .toBe('not_ancestor');
  });
  it('fetch FAILED and not an ancestor → fetch_failed, never not_ancestor on a stale ref', async () => {
    expect(await verifyMerge({ sha: 'abc123f', cwd }, fake({ fetch: 128, 'cat-file': 0, 'merge-base': 1 })))
      .toBe('fetch_failed');
  });
  it('fetch failed but STILL an ancestor → ancestor (a stale ref cannot fake landing)', async () => {
    expect(await verifyMerge({ sha: 'abc123f', cwd }, fake({ fetch: 128, 'cat-file': 0, 'merge-base': 0 })))
      .toBe('ancestor');
  });
  it('fetch ok, sha not in this repo → unknown_object (cross-repo lane)', async () => {
    expect(await verifyMerge({ sha: 'abc123f', cwd }, fake({ fetch: 0, 'cat-file': 1 })))
      .toBe('unknown_object');
  });
  it('fetch failed and sha unknown → fetch_failed (cannot distinguish, abstain)', async () => {
    expect(await verifyMerge({ sha: 'abc123f', cwd }, fake({ fetch: 128, 'cat-file': 1 })))
      .toBe('fetch_failed');
  });
  it('merge-base errors (>1: no origin/main ref) → fetch_failed', async () => {
    expect(await verifyMerge({ sha: 'abc123f', cwd }, fake({ fetch: 0, 'cat-file': 0, 'merge-base': 128 })))
      .toBe('fetch_failed');
  });
  it('git spawn rejection anywhere → fetch_failed, never a throw', async () => {
    expect(await verifyMerge({ sha: 'abc123f', cwd }, fake({ fetch: 'reject' }))).toBe('fetch_failed');
  });
});
```

- [ ] **Step 2:** Run `pnpm --filter @musterd/mcp test mergeVerify` — expect FAIL (module missing).
- [ ] **Step 3:** Implement `packages/mcp/src/mergeVerify.ts`:

```ts
import { execFile } from 'node:child_process';
import type { MergeVerification } from '@musterd/protocol';

export type VerifyOutcome = MergeVerification | 'not_ancestor';
export type GitExec = (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number }>;

/** Squash SHAs as callers actually pass them: abbreviated (≥7) or full. */
export const SHA_FORMAT = /^[0-9a-f]{7,40}$/i;

export const defaultGitExec: GitExec = (args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs }, (err) => {
      // execFile errors carry the exit code for a non-zero exit; spawn/timeout errors don't.
      if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err);
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0 });
    });
  });

/**
 * Classify a merge attestation against origin/main using only this worktree's git.
 * `not_ancestor` requires a SUCCESSFUL fetch — a stale ref can produce a false "not
 * landed", so without a fresh fetch the negative degrades to `fetch_failed` (abstain).
 * An ancestor verdict needs no fresh fetch: history only grows, so a stale ref cannot
 * fake a landing.
 */
export async function verifyMerge(
  input: { sha?: string | undefined; cwd: string },
  exec: GitExec = defaultGitExec,
): Promise<VerifyOutcome> {
  if (input.sha === undefined) return 'unattested';
  const run = async (args: string[]): Promise<number> => {
    try {
      return (await exec(args, { cwd: input.cwd, timeoutMs: 15_000 })).code;
    } catch {
      return -1; // spawn failure / timeout — treated as "could not run"
    }
  };
  const fetched = (await run(['fetch', '--quiet', 'origin', 'main'])) === 0;
  const exists = (await run(['cat-file', '-e', `${input.sha}^{commit}`])) === 0;
  if (!exists) return fetched ? 'unknown_object' : 'fetch_failed';
  const ancestry = await run(['merge-base', '--is-ancestor', input.sha, 'origin/main']);
  if (ancestry === 0) return 'ancestor';
  if (ancestry === 1 && fetched) return 'not_ancestor';
  return 'fetch_failed';
}
```

- [ ] **Step 4:** `pnpm --filter @musterd/mcp test mergeVerify` — expect PASS.
- [ ] **Step 5:** Commit: `feat(mcp): mergeVerify — classify a merge attestation against origin/main`

### Task 3: Wire verification into `lane_submit`

**Files:**
- Modify: `packages/mcp/src/tools/lanes.ts` — `registerLanes` signature (line 77) and
  `laneSubmitHandler` (lines 266–347)
- Modify: `packages/mcp/src/tools/tools.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `verifyMerge`, `SHA_FORMAT`, `GitExec` from `../mergeVerify.js` (Task 2).
- Produces: `registerLanes(server, client, verify: typeof verifyMerge = verifyMerge)` —
  third param defaulted, so `packages/mcp/src/index.ts:260` needs no change. Tests inject
  a fake `verify`.

- [ ] **Step 1: Write the failing tests** (append to `tools.test.ts`, using the existing
  `captureAll` helper; pass the fake verifier via a wrapper register fn):

```ts
describe('lane_submit merge verification (merge-verified submit)', () => {
  const submitted: any[] = [];
  const client = {
    updateLane: async (id: string, patch: any) => {
      submitted.push({ id, patch });
      return { lane: { id, title: 't', state: 'awaiting_acceptance' } as Partial<Lane>, warnings: [] };
    },
  } as Partial<MusterdClient>;
  const withVerify = (tier: string) =>
    captureAll((s, c) => registerLanes(s, c, async () => tier as any), client)['lane_submit']!;
  beforeEach(() => { submitted.length = 0; });

  it('refuses pr without sha — an open PR is not a landed artifact', async () => {
    const r = await withVerify('ancestor')({ id: 'L1', pr: 42 });
    expect(r.content[0]!.text).toMatch(/open PR|arm auto-merge/i);
    expect(submitted).toHaveLength(0);
  });
  it('refuses a malformed sha before any git call', async () => {
    const r = await withVerify('ancestor')({ id: 'L1', sha: 'not-a-sha!' });
    expect(r.content[0]!.text).toMatch(/not a git SHA/i);
    expect(submitted).toHaveLength(0);
  });
  it('refuses not_ancestor with actionable guidance and no lane mutation', async () => {
    const r = await withVerify('not_ancestor')({ id: 'L1', sha: 'abc123f' });
    expect(r.content[0]!.text).toMatch(/not on origin\/main.*arm auto-merge/is);
    expect(submitted).toHaveLength(0);
  });
  it('proceeds on ancestor and stamps the tier', async () => {
    await withVerify('ancestor')({ id: 'L1', pr: 42, sha: 'abc123f' });
    expect(submitted[0].patch.merged).toMatchObject({ pr: 42, sha: 'abc123f', verification: 'ancestor' });
  });
  it('proceeds on fetch_failed (degrade, never wedge) with the tier recorded', async () => {
    await withVerify('fetch_failed')({ id: 'L1', sha: 'abc123f' });
    expect(submitted[0].patch.merged.verification).toBe('fetch_failed');
  });
  it('artifact-less submit proceeds, stamped unattested', async () => {
    await withVerify('unattested')({ id: 'L1' });
    expect(submitted[0].patch.merged).toEqual({ verification: 'unattested' });
  });
});
```

- [ ] **Step 2:** Run `pnpm --filter @musterd/mcp test tools` — expect FAIL
  (registerLanes takes 2 args; no refusals).
- [ ] **Step 3:** Implement in `lanes.ts`. Signature:
  `export function registerLanes(server: McpServer, client: MusterdClient, verify: typeof verifyMerge = verifyMerge): void`.
  At the TOP of `laneSubmitHandler`, before building `merged`:

```ts
      // Merge-verified submit: awaiting_acceptance MEANS landed. Refuse only on positive
      // evidence of not-landed; abstentions (cross-repo, offline) proceed with a tier.
      if (args.sha !== undefined && !SHA_FORMAT.test(args.sha)) {
        return textResult(
          `"${args.sha}" is not a git SHA — pass the squash-merge SHA from origin/main ` +
            `(git log --oneline -1 after the merge lands).`,
        );
      }
      if (args.pr !== undefined && args.sha === undefined) {
        return textResult(
          `a PR number without a landed SHA is an open PR — nothing has landed, so there ` +
            `is nothing to accept yet. Arm auto-merge (gh pr merge --squash --auto ${args.pr}), ` +
            `wait for the merge, then resubmit with the squash SHA.`,
        );
      }
      const verification = await verify({ sha: args.sha, cwd: process.cwd() });
      if (verification === 'not_ancestor') {
        return textResult(
          `SHA ${args.sha} is not on origin/main — nothing landed. If the PR is still ` +
            `open, arm auto-merge and resubmit with the real squash SHA once it lands; ` +
            `if this landed somewhere else on purpose, that flow needs a design, not a workaround.`,
        );
      }
```

  Then `merged` always carries the tier (replace the existing construction):

```ts
      const merged = {
        ...(args.pr !== undefined ? { pr: args.pr } : {}),
        ...(args.sha !== undefined ? { sha: args.sha } : {}),
        ...(args.authorized_by !== undefined ? { authorized_by: args.authorized_by } : {}),
        verification,
      };
      const { lane, warnings, review } = await client.updateLane(args.id, {
        state: 'awaiting_acceptance',
        merged,
        ...(args.branch !== undefined ? { branch: args.branch } : {}),
      });
```

  Use the existing `textResult` import from `./format.js` (already imported in the file;
  if not, add it). Update the `lane_submit`/`lane_ready` tool descriptions' first line to:
  `'Your work is merged — move the lane to awaiting_acceptance (ADR 192) and attest it. ' +
  'The SHA is verified against origin/main seat-side: an unlanded submit is refused. …'`
  (keep the rest of the existing description text). The deprecated `lane_ready` alias
  calls the same `laneSubmitHandler`, so it gets the behavior for free — verify that in
  the test run, don't duplicate code.

- [ ] **Step 4:** `pnpm --filter @musterd/mcp test` — expect PASS (including existing
  lane_submit tests; if an existing test submits with `pr` and no `sha`, update it to
  include a valid sha — that behavior change is the feature).
- [ ] **Step 5:** Commit: `feat(mcp): lane_submit refuses unlanded work — awaiting_acceptance means landed`

### Task 4: Real-git integration test for `verifyMerge`

**Files:**
- Create: `packages/mcp/src/mergeVerify.integration.test.ts`

**Interfaces:**
- Consumes: `verifyMerge`, `defaultGitExec` (Task 2). No network: `origin` is a local
  bare repo, so `git fetch origin main` exercises the real path offline.

- [ ] **Step 1: Write the test:**

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { verifyMerge } from './mergeVerify.js';

const root = mkdtempSync(join(tmpdir(), 'mergeverify-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function setup() {
  const upstream = join(root, 'upstream.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', upstream]);
  const work = join(root, 'work');
  execFileSync('git', ['clone', upstream, work]);
  git(work, 'config', 'user.email', 't@t'); git(work, 'config', 'user.name', 't');
  writeFileSync(join(work, 'a.txt'), 'one');
  git(work, 'add', '.'); git(work, 'commit', '-m', 'landed'); git(work, 'push', 'origin', 'main');
  const landed = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-b', 'feature');
  writeFileSync(join(work, 'b.txt'), 'two');
  git(work, 'add', '.'); git(work, 'commit', '-m', 'unlanded');
  const unlanded = git(work, 'rev-parse', 'HEAD');
  return { work, landed, unlanded };
}

describe('verifyMerge against a real repo', () => {
  const { work, landed, unlanded } = setup();
  it('landed commit → ancestor', async () => {
    expect(await verifyMerge({ sha: landed, cwd: work })).toBe('ancestor');
  });
  it('committed but never merged → not_ancestor', async () => {
    expect(await verifyMerge({ sha: unlanded, cwd: work })).toBe('not_ancestor');
  });
  it('sha from some other repo → unknown_object', async () => {
    expect(await verifyMerge({ sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', cwd: work }))
      .toBe('unknown_object');
  });
});
```

- [ ] **Step 2:** `pnpm --filter @musterd/mcp test mergeVerify.integration` — expect PASS
  (implementation exists from Task 2; if any tier misclassifies here, the fix goes in
  `mergeVerify.ts`, not the test).
- [ ] **Step 3:** Commit: `test(mcp): verifyMerge integration against a real bare-remote repo`

### Task 5: Increment 2 — `unlanded` badge in review_debt

**Files:**
- Modify: `packages/protocol/src/lanes.ts:564-582` (review_debt entry schema)
- Modify: `packages/server/src/store/orientation.ts:230-243`
- Modify: `packages/mcp/src/tools/lanes.ts:530-536` (team_next debt renderer)
- Test: `packages/server/src/store/orientation.test.ts`, `packages/mcp/src/tools/next.render.test.ts`

**Interfaces:**
- Consumes: `Lane.merged` (Task 1). Produces: `unlanded: z.boolean().default(false)` on
  review_debt entries — true iff the lane's attestation carries no SHA
  (`merged === null || merged.sha === undefined`).

- [ ] **Step 1: Failing server test** (append to orientation.test.ts, mirroring the
  existing no_candidate test's setup — open a lane as another member, move it to
  awaiting_acceptance via `updateLane`, one WITH `merged: { sha: 'abc123f', verification: 'ancestor' }`
  and one with no merged at all):

```ts
  it('review_debt marks a lane whose attestation has no SHA as unlanded', () => {
    const db = openDb(':memory:');
    const team = ensureTeam(db, 'revive');
    const bare = openLane(db, team.id, 'revive', 'nick', { title: 'no attestation', claim: true });
    updateLane(db, team.id, 'revive', 'nick', bare.lane.id, { state: 'awaiting_acceptance' });
    const attested = openLane(db, team.id, 'revive', 'nick', { title: 'landed', claim: true });
    updateLane(db, team.id, 'revive', 'nick', attested.lane.id, {
      state: 'awaiting_acceptance', merged: { sha: 'abc123f', verification: 'ancestor' },
    });
    const brief = deriveNext(db, team.id, 'revive', 'stanley');
    const byId = Object.fromEntries((brief.review_debt ?? []).map((r) => [r.id, r]));
    expect(byId[bare.lane.id]!.unlanded).toBe(true);
    expect(byId[attested.lane.id]!.unlanded).toBe(false);
  });
```

  (Adapt `openDb`/`ensureTeam`/`deriveNext` call shapes to the file's existing first
  test — copy its setup lines verbatim rather than inventing new helpers.)

- [ ] **Step 2:** Run it — expect FAIL (`unlanded` undefined).
- [ ] **Step 3:** Implement. Protocol schema (after `no_candidate`):

```ts
        /**
         * True when the lane's merge attestation carries no SHA — under merge-verified
         * submit nothing has landed, so there is NOTHING TO ACCEPT YET: the wait is on the
         * author's merge button, not a reviewer (dolly's #961/#963, 2026-08-21). Only
         * grandfathered lanes and older clients can reach this state; new submits are
         * refused unlanded. `.default(false)` keeps older-daemon briefs parseable.
         */
        unlanded: z.boolean().default(false),
```

  Server (orientation.ts, inside the `review_debt` map):

```ts
    unlanded: lane.merged?.sha === undefined,
```

  Renderer (mcp tools/lanes.ts debt loop, after the no_candidate suffix):

```ts
          (r.unlanded ? ' — NO MERGE ATTESTATION (nothing landed — waiting on its author, not you)' : ''),
```

- [ ] **Step 4: Failing render test** (append to next.render.test.ts following its
  existing brief-fixture pattern): a brief whose `review_debt` entry has
  `unlanded: true` renders the `NO MERGE ATTESTATION` line; `unlanded: false` doesn't.
- [ ] **Step 5:** `pnpm --filter @musterd/server test orientation && pnpm --filter @musterd/mcp test next.render` — expect PASS.
- [ ] **Step 6:** Commit: `feat: review_debt badges unlanded lanes — nothing to accept yet`

### Task 6: ADR + controls-registry entry + architecture doc

**Files:**
- Create: `docs/decisions/NNN-awaiting-acceptance-means-landed.md` — get NNN by running
  `pnpm adr:next` NOW, and reserve it per ADR 223 in the same push as the stub:
  `git commit --allow-empty-message -m "reserve ADR NNN" docs/decisions/NNN-awaiting-acceptance-means-landed.md`
  (stanley is concurrently taking 299 for Sloane inc 2 — do not assume 299 is free).
- Modify: `docs/controls/registry.ts` (append one Control)
- Modify: `docs/architecture/05-mcp.md` (one line describing `mergeVerify.ts` — the
  arch-trees gate requires new files to be described)

**Interfaces:** none — documentation of Tasks 1–5.

- [ ] **Step 1:** Write the ADR. Content: Problem/Decision/Consequences distilled from the
  spec (`docs/superpowers/specs/2026-08-21-merge-verified-submit-design.md` — cite it),
  including the falsified "the daemon knew" premise with its grep falsifier, the no-poller
  constraint, tier table, refusal rules, and the not-server-enforced skew posture. End
  with the ADR 052 `## Observability & Evaluation` section in the Traces/Eval/Experiment
  FORM (prose alone fails `pnpm obs-evals:check`):
  - **Traces:** submit attestations carry `merged.verification`; refusals surface as
    lane_submit error results in tool telemetry.
  - **Eval:** dataset — `lane_submit` attestations in the act log. Baseline 2026-08-21:
    100% of submits carry no tier; the motivating shape (awaiting_acceptance with an open
    PR) occurred ≥2× in one evening (#961/#963). Target: 0 awaiting_acceptance lanes with
    an open PR; 100% of new submits carry a tier.
  - **Experiment:** after 7 days, count refusals by reason and tiers by value. A
    pr-without-sha refusal in the wild = control working; all-`ancestor` with zero
    refusals = ritual holding (also a pass); tiers absent = rollout failed.
- [ ] **Step 2:** Append to `docs/controls/registry.ts` CONTROLS:

```ts
  {
    id: 'lane-submit-refuses-unlanded',
    kind: 'guard',
    claim:
      'A lane cannot enter awaiting_acceptance claiming an artifact that has not landed: lane_submit verifies the attested SHA against origin/main seat-side and refuses a PR-without-SHA or a not-ancestor SHA.',
    where: 'packages/mcp/src/tools/lanes.ts (laneSubmitHandler) + packages/mcp/src/mergeVerify.ts; ADR NNN',
    exercise:
      'From any seat worktree: commit on a branch without merging, then lane_submit a scratch lane with that commit SHA — the submit must refuse with "not on origin/main". Or submit with pr and no sha — refused with "arm auto-merge". The integration test mergeVerify.integration.test.ts runs the same three tiers against a real repo.',
    motivatedBy:
      "2026-08-21: dolly's #961/#963 sat awaiting_acceptance with green unmerged PRs (auto-merge never armed). wanderer spent two check cycles holding for lanes with nothing to accept; the false 'landed' claim propagated into ryder's wiki page and cost a second seat a lane (#967). Lane 01M0JSKTA3.",
    counterfactual:
      "Yes — dolly submitted with a PR number and no landed SHA (none existed; the PRs were open). The pr-without-sha refusal fires on exactly that call, and the refusal text reaches the one seat that owns the missing act, at the moment it acts.",
    lastExercised: '<date you run the exercise — run it, do not backfill>',
    everTripped: false,
    staleAfterDays: 90,
    refs: ['ADR NNN', 'lane 01M0JSKTA3YH2CTHD869X1YWCZ', 'docs/superpowers/specs/2026-08-21-merge-verified-submit-design.md'],
  },
```

  Replace NNN with the reserved number and actually run the exercise (a scratch lane +
  an unmerged SHA) before filling `lastExercised`.
- [ ] **Step 3:** Add the `mergeVerify.ts` line to `docs/architecture/05-mcp.md` next to
  the other module descriptions.
- [ ] **Step 4:** `pnpm obs-evals:check` and the format/vocab gates on the ADR — expect PASS.
- [ ] **Step 5:** Commit: `docs: ADR NNN — awaiting_acceptance means landed (+ control + arch note)`

### Task 7: Gates, PR, submit

- [ ] **Step 1:** Full chain locally, checking each exit code un-piped:
  `pnpm build`, `pnpm typecheck`, `pnpm -r test`, `pnpm format` (then commit any
  reformat), `pnpm format:check`, `pnpm vocab:check`, `pnpm obs-evals:check`.
- [ ] **Step 2:** Push `izzo/merge-verified-submit`, open the PR
  (`gh pr create` — body ends with the standard generated-with footer), and **ARM
  AUTO-MERGE immediately**: `gh pr merge --squash --auto <pr>`. This feature exists
  because a seat once didn't.
- [ ] **Step 3:** After the merge lands: `git fetch origin main`, take the squash SHA,
  then `lane_submit {id: 01M0JSKTA3YH2CTHD869X1YWCZ, pr: <n>, sha: <squash sha>,
  branch: izzo/merge-verified-submit, authorized_by: nick}` — the first submit verified
  by the thing it ships. Send a status_update; leave acceptance with the routed acceptor
  (do not self-close on silence).
