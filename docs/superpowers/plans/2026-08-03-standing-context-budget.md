# Standing-Context Budget Implementation Plan

> **For agentic workers:** Execute task-by-task in the owner's own seat/lane (musterd house rule —
> no writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, budget, and CI-gate every byte musterd injects into a seat's context (tool
schemas, primer, hook nudges), then trim the worst offenders with the budgets lowered afterward.

**Architecture:** A static measurement script (`pnpm context:check`) in the ADR 151 `perf:check`
mold reads three sources of truth — the in-memory `tools/list` render per role, the rendered
primer, and the hook nudge strings — and compares against `docs/perf/context-budgets.json`. A
report-only companion executes the hooks for dynamic output. Increment 2 trims, gated by existing
suites plus one in-memory ritual probe test.

**Tech Stack:** Node native TypeScript scripts (no new deps), vitest, the in-memory MCP
client/server pair already used by `scopeSurface.test.ts`.

**Spec:** `docs/superpowers/specs/2026-08-03-standing-context-budget-design.md`

## Global Constraints

- Increment 1 (Tasks 1–6) and increment 2 (Tasks 7–8) are **separate PRs**; increment 2 does not
  start until increment 1's baseline is committed.
- The `claudeCode.ts` refactor must be behavior-neutral: installed hook command strings
  byte-identical before/after (existing hook tests are the proof).
- Budgets get ~5% headroom over measured baseline; raising one requires a justification string in
  the budgets file; a missing/unrenderable line item **fails**, never skips.
- Est-tokens formula is `Math.round(bytes / 4)` everywhere (matches `SurfaceRender.est_tokens`).
- `pnpm lint` is a separate gate from `format:check` — run both before push. Never run
  `pnpm format` (use `pnpm exec prettier --write <files>`). ROADMAP.md is edited last and never
  prettier'd.
- Vitest runs from repo root only.
- New ADR number is picked off **origin/main at PR time** (collision trap); ADR needs an
  `## Observability & Evaluation` section and H1 matching its filename.

---

### Task 1: Export the hook nudge texts as named constants

**Files:**
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts` (functions
  `sessionStartHookCommand()` ~line 193 and `promptSubmitHookCommand()` ~line 233)
- Test: `packages/cli/src/onboard/harnesses/claudeCode.hooks.test.ts`

**Interfaces:**
- Produces: `export const HOOK_NUDGE_TEXTS: Readonly<Record<string, string>>` from
  `claudeCode.ts`, keys `orientation_joined`, `orientation_wire_fix`, `orientation_init_fix`,
  `prompt_submit_ritual` — the exact single-quoted text each `echo` prints (no shell plumbing).
  Task 3's script imports this from the built `packages/cli/dist`.

- [ ] **Step 1: Write the failing test** — in `claudeCode.hooks.test.ts` add:

```ts
import { HOOK_NUDGE_TEXTS } from './claudeCode.js';

it('every budgeted nudge text appears verbatim inside its installed hook command', () => {
  // The constants are the budget's source of truth (standing-context spec); if a command stops
  // embedding one, the budget silently measures dead text — so pin the embedding.
  const commands = [sessionStartHookCommand(), promptSubmitHookCommand()].join('\n');
  for (const [key, text] of Object.entries(HOOK_NUDGE_TEXTS)) {
    expect(commands, key).toContain(text);
  }
});
```

(If `sessionStartHookCommand`/`promptSubmitHookCommand` are not exported, export them — they are
pure string builders; check first whether the test file already reaches them via an existing
exported wrapper and use that instead.)

- [ ] **Step 2: Run it** — `pnpm vitest run packages/cli/src/onboard/harnesses/claudeCode.hooks.test.ts`
  from repo root. Expected: FAIL (`HOOK_NUDGE_TEXTS` not exported).

- [ ] **Step 3: Implement** — in `claudeCode.ts`, lift the four echo texts out of the two command
builders into module-level constants, and interpolate them back in so the built strings are
byte-identical:

```ts
/** The model-readable nudge texts, budgeted by the standing-context gate (spec 2026-08-03).
 * Keep each in sync with exactly one echo below — the hooks test pins the embedding. */
export const HOOK_NUDGE_TEXTS = {
  orientation_joined:
    'You are on a musterd team (your seat auto-claims on your first team_* tool call). Run ' +
    'team_inbox_check now to join and see anything waiting. Only call team_join if a tool says you ' +
    'are not joined.',
  orientation_wire_fix:
    'musterd: this repo has a committed musterd launch spec but the MCP server is NOT ' +
    'registered on this machine — run `musterd wire` in this folder (no prompts), then reload this ' +
    'session to pick up the team_* tools.',
  orientation_init_fix:
    'musterd: this folder has the musterd:start primer but the musterd MCP server is NOT ' +
    'registered here — the team_* tools are unavailable. Run `musterd init` in this folder (or ' +
    '`musterd init --check` to confirm), then reload this session.',
  prompt_submit_ritual:
    'musterd: if you finished a unit of work since your last update, post a one-line ' +
    'team_send status_update (flips you to working: on the roster); then team_inbox_check for ' +
    'replies.',
} as const;
```

Then in `sessionStartHookCommand()` replace each inline text with
`"echo '" + HOOK_NUDGE_TEXTS.orientation_wire_fix + "'; else "` etc., and in
`promptSubmitHookCommand()` use `HOOK_NUDGE_TEXTS.prompt_submit_ritual`. **Copy the existing
strings exactly** (watch the embedded backticks and the trailing `'; ` shell punctuation staying
outside the constant).

- [ ] **Step 4: Verify** — same vitest command: new test PASSES and **every pre-existing test in
  `claudeCode.hooks.test.ts`, `refreshHooks.test.ts`, `onboard.test.ts` passes unchanged** (they
  pin the installed command strings — that is the byte-identical proof).

- [ ] **Step 5: Commit** — `git commit -m "cli: export hook nudge texts as constants for the standing-context budget"`

---

### Task 2: `measureToolSurface` — extract the in-memory listing measurement

**Files:**
- Create: `packages/mcp/src/surfaceMeasure.ts`
- Modify: `packages/mcp/src/index.ts` (add export), `packages/mcp/src/scopeSurface.test.ts`
  (consume the helper instead of its private `listToolsFor`)
- Test: `packages/mcp/src/surfaceMeasure.test.ts`

**Interfaces:**
- Consumes: `buildMcpServer` (`./index.js`), `InMemoryTransport` (`@modelcontextprotocol/server`),
  `Client` (`@modelcontextprotocol/client`), `SurfaceRender` (`@musterd/protocol`).
- Produces: `export async function measureToolSurface(capabilities?: Capabilities):
  Promise<SurfaceRender>` — builds an unconnected server with a stub client/config (lifted from
  `scopeSurface.test.ts`), lists tools over a linked in-memory pair, returns the same shape
  `computeSurface` emits (`tools`, `bytes`, `est_tokens`, `breakdown`). Re-exported from
  `@musterd/mcp` index.

- [ ] **Step 1: Write the failing test** — `surfaceMeasure.test.ts`:

```ts
import { GENERALIST_CAPABILITIES } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { measureToolSurface } from './surfaceMeasure.js';

describe('measureToolSurface', () => {
  it('returns the full-surface weight with a per-tool breakdown', async () => {
    const s = await measureToolSurface(GENERALIST_CAPABILITIES);
    expect(s.tools).toBeGreaterThan(15);
    expect(s.bytes).toBeGreaterThan(5_000);
    expect(s.est_tokens).toBe(Math.round(s.bytes / 4));
    expect(s.breakdown?.length).toBe(s.tools);
    for (const t of s.breakdown ?? []) expect(t.bytes).toBeGreaterThanOrEqual(t.description_bytes);
  });

  it('a muted seat weighs less than a generalist', async () => {
    const [full, muted] = await Promise.all([
      measureToolSurface(GENERALIST_CAPABILITIES),
      measureToolSurface({ ...GENERALIST_CAPABILITIES, can_message: 'none' }),
    ]);
    expect(muted.bytes).toBeLessThan(full.bytes);
  });
});
```

- [ ] **Step 2: Run** — `pnpm vitest run packages/mcp/src/surfaceMeasure.test.ts`. Expected: FAIL
  (module not found).

- [ ] **Step 3: Implement `surfaceMeasure.ts`** — move `fakeClient`, `configWith`, and the
list-over-linked-pair body out of `scopeSurface.test.ts` into the new module; compute the
breakdown with `computeSurface`'s exact formula:

```ts
const breakdown = tools.map((t) => ({
  tool: t.name.slice(0, 64),
  bytes: Buffer.byteLength(JSON.stringify(t), 'utf8'),
  description_bytes: Buffer.byteLength(t.description ?? '', 'utf8'),
}));
const bytes = breakdown.reduce((n, b) => n + b.bytes, 0);
return { tools: tools.length, bytes, est_tokens: Math.round(bytes / 4), breakdown };
```

Add `export { measureToolSurface } from './surfaceMeasure.js';` to `index.ts`. Rewrite
`scopeSurface.test.ts`'s `listToolsFor` as a thin wrapper over the helper (its name/byte
assertions keep passing untouched).

- [ ] **Step 4: Verify** — `pnpm vitest run packages/mcp/src/surfaceMeasure.test.ts
  packages/mcp/src/scopeSurface.test.ts`. Expected: all PASS.

- [ ] **Step 5: Commit** — `git commit -m "mcp: measureToolSurface helper shared by scope test and the context budget"`

---

### Task 3: `context:check` — the budget gate script

**Files:**
- Create: `scripts/context/check-budgets.ts`, `docs/perf/context-budgets.json`
- Modify: `package.json` (add `"context:check": "node --disable-warning=ExperimentalWarning
  scripts/context/check-budgets.ts"`)

**Interfaces:**
- Consumes: `measureToolSurface` + `GENERALIST_CAPABILITIES` from built `packages/mcp/dist` /
  `packages/protocol/dist`, `renderPrimer` from `packages/protocol/dist`, `HOOK_NUDGE_TEXTS` from
  `packages/cli/dist` (import via the workspace package names — they resolve to `./dist`, so the
  script **needs `pnpm build` first**, same trap as `perf:check`; print the same hint on import
  failure).
- Produces: exit 0/1; a per-line-item table on stdout. Budget file shape below is what Task 5's
  baseline doc and Task 8's lowering edit rely on.

- [ ] **Step 1: Write `docs/perf/context-budgets.json`** with placeholder-high budgets (real
numbers land in Step 3):

```json
{
  "note": "Standing-context byte budgets (spec 2026-08-03). Raising any value requires replacing that item's `justification`. bytes are UTF-8 of the model-readable text; estTokens = bytes/4.",
  "items": {
    "toolsListDefaultBytes": { "budget": 99999, "justification": "initial baseline" },
    "toolsListMutedBytes": { "budget": 99999, "justification": "initial baseline" },
    "primerBytes": { "budget": 99999, "justification": "initial baseline" },
    "sessionStartNudgesBytes": { "budget": 99999, "justification": "initial baseline" },
    "promptSubmitNudgeBytes": { "budget": 99999, "justification": "initial baseline" },
    "perTurnTotalBytes": { "budget": 99999, "justification": "initial baseline" },
    "perSessionTotalBytes": { "budget": 99999, "justification": "initial baseline" }
  }
}
```

- [ ] **Step 2: Write the script.** Structure mirrors `scripts/perf/check-budgets.ts` (header
comment, typed budgets interface, `fail()` collecting breaches, exit 1 with a measured-vs-budget
diff per breach). Measurements:

```ts
import { measureToolSurface } from '@musterd/mcp';
import { GENERALIST_CAPABILITIES, renderPrimer } from '@musterd/protocol';
import { HOOK_NUDGE_TEXTS } from '@musterd/cli/dist/onboard/harnesses/claudeCode.js';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const toolsDefault = (await measureToolSurface(GENERALIST_CAPABILITIES)).bytes;
const toolsMuted = (
  await measureToolSurface({ ...GENERALIST_CAPABILITIES, can_message: 'none' })
).bytes;
const primer = bytes(renderPrimer({ member: 'seat', team: 'team' }));
const sessionStart =
  bytes(HOOK_NUDGE_TEXTS.orientation_joined) +
  bytes(HOOK_NUDGE_TEXTS.orientation_wire_fix) +
  bytes(HOOK_NUDGE_TEXTS.orientation_init_fix);
const promptSubmit = bytes(HOOK_NUDGE_TEXTS.prompt_submit_ritual);
const perTurn = toolsDefault + promptSubmit; // the headline: what multiplies per turn
const perSession = toolsDefault + primer + sessionStart + promptSubmit;
```

(Adjust the `@musterd/cli` deep-import path to whatever the built dist layout actually is — verify
with `ls packages/cli/dist/onboard/harnesses/` after `pnpm build`; if the package's `exports` map
blocks deep imports, add a `./context-surface` export entry to `packages/cli/package.json` that
re-exports `HOOK_NUDGE_TEXTS`, and import that.) Any import/render failure → `process.exit(1)`
with the "run `pnpm build` first" hint. Print a table of item / measured / budget / headroom,
est-tokens alongside.

- [ ] **Step 3: Run and bake real budgets** — `pnpm build && pnpm context:check`. Take each
measured value, set its budget to `Math.ceil(measured * 1.05)`, justification
`"baseline 2026-08-0X + 5% headroom"`. Re-run: PASS. Manually break one budget (set below
measured), re-run: exit 1 naming the item; restore.

- [ ] **Step 4: Commit** — `git commit -m "scripts: context:check standing-context budget gate (spec 2026-08-03)"`

---

### Task 4: Wire `context:check` into CI

**Files:**
- Modify: `.github/workflows/ci.yml` (after the `Perf budgets` step, ~line 54)

- [ ] **Step 1: Add the step**:

```yaml
      # Standing-context byte budgets (spec 2026-08-03) — every byte musterd injects into a seat's
      # context (tools/list, primer, hook nudges) can only grow deliberately. Needs Build first.
      - name: Context budgets
        run: pnpm context:check
```

- [ ] **Step 2: Verify locally** — `pnpm build && pnpm context:check && pnpm lint && pnpm format:check`.
  All green (the new .ts script must satisfy lint/prettier).

- [ ] **Step 3: Commit** — `git commit -m "ci: gate the standing-context budgets"`

---

### Task 5: Report-only dynamic measurement + baseline doc

**Files:**
- Create: `scripts/context/report.mjs`, `docs/perf/standing-context-baseline.md`

**Interfaces:**
- Consumes: `HOOK_NUDGE_TEXTS` import (same as Task 3) for the static half; a temp fixture folder
  for the dynamic half.
- Produces: stdout report only — **never** a nonzero exit for size; the baseline doc's "dynamic"
  table cites it.

- [ ] **Step 1: Write `report.mjs`** — creates a temp dir (inside `os.tmpdir()`) containing an
`AGENTS.md` with the `musterd:start` marker, then runs the two installed hook commands the way the
harness would (`bash -c <command>` with `CLAUDE_PROJECT_DIR` set to the fixture), capturing stdout;
reports byte counts of what each hook actually printed alongside the static constants, flagging the
delta (init-check text, label-nudge output) as the dynamic share. Guard: if `musterd`/`claude`
aren't on PATH the dynamic clauses self-skip (the commands already `|| true`) — report whatever
printed. Read the installed commands from `~/.claude/settings.json`'s hook entries when present,
else rebuild them by importing the two builders from `packages/cli/dist` (same import note as
Task 3).

- [ ] **Step 2: Run it** — `node scripts/context/report.mjs`; sanity-check output.

- [ ] **Step 3: Write `docs/perf/standing-context-baseline.md`** mirroring
`docs/perf/web-live-baseline.md`'s log style: date, method (one line per surface: in-memory
tools/list · rendered primer · exported constants · executed-hook report), a static table (the
seven budget items: measured bytes + est tokens), a dynamic table (per-hook executed output bytes),
and the headline per-turn + per-session totals. Note the known prior art figures (inc-1 baseline
≈3,195 tok/seat; muted −77%) for continuity.

- [ ] **Step 4: Commit** — `git commit -m "docs: standing-context baseline + report-only dynamic measurement"`

---

### Task 6: ADR + ROADMAP correction, then PR 1

**Files:**
- Create: `docs/decisions/NNN-standing-context-budget.md` (NNN = next free off origin/main,
  checked at this step, H1 must match filename per `adr-numbers:check`)
- Modify: `ROADMAP.md` (one line), `content/roadmap.data.ts` if the same sentence lives there
  (grep `increment 4` to check)

- [ ] **Step 1: Write the ADR** — condense the spec: context (four injection points, one
measured), decision (static budget gate + report-only dynamic + trim increment; per-turn total as
headline), the budget raise protocol, and a **`## Observability & Evaluation`** section (the gate
itself is the instrument; baseline doc is the log; trim's before/after lands there). Link ADR 144,
151, 085/171, 175 and the spec. Cite Deep Agents v0.7 as the prompt.

- [ ] **Step 2: ROADMAP fix (last, never prettier'd)** — in the `mcp-tool-surface` entry, change
the "Only increment 4 (schemas/tool shape) remains…" sentence to state increment 4 closed
2026-07-24/#575 as "no split, no merge" with standing instruments holding the line (match the ADR
144 text). Mirror in `content/roadmap.data.ts` if present there.

- [ ] **Step 3: Full gates** — `pnpm build && pnpm typecheck && pnpm lint && pnpm coverage &&
  pnpm format:check && pnpm perf:check && pnpm context:check`.

- [ ] **Step 4: PR** — push; `gh pr create` (body ends with the standard generated-with footer);
  `gh pr merge --squash --auto --delete-branch`. If the bugbot check never registers, comment
  `bugbot run`. After merge: `lane_update` noting increment 1 landed.

---

### Task 7 (PR 2): The ritual probe test

**Files:**
- Create: `packages/mcp/src/ritualProbe.test.ts`

**Interfaces:**
- Consumes: the through-DB integration pattern from `packages/mcp/src/mcp.test.ts` (`createServer`
  + `openDb(':memory:')` from `@musterd/server`, in-memory MCP pair from Task 2's helper module).

- [ ] **Step 1: Write the test** — one describe block, modeled directly on `mcp.test.ts`'s
setup (steal its server/client/seat fixture): (a) first tool call triggers autojoin — call
`team_status` via the harness client, then assert the seat appears in `team_members`; (b) a
directed act sent to the seat surfaces in `team_inbox_check`'s result text; (c) `team_send` with
`act: 'status_update'` returns an id and flips the roster state. Assert on **behavior** (results),
not on any guidance text — this is the trim's safety net: the ritual must survive any wording.

- [ ] **Step 2: Run** — `pnpm vitest run packages/mcp/src/ritualProbe.test.ts`. Expected: PASS
  against the untrimmed text (it's a pin, not TDD red — note that in the commit message).

- [ ] **Step 3: Commit** — `git commit -m "mcp: ritual probe pins join/inbox/status behavior ahead of the guidance trim"`

---

### Task 8 (PR 2): The trim, budgets lowered

**Files:**
- Modify: `packages/cli/src/onboard/harnesses/claudeCode.ts` (`HOOK_NUDGE_TEXTS`),
  `packages/protocol/src/primer.ts`, possibly `packages/mcp/src/tools/*.ts` descriptions,
  `docs/perf/context-budgets.json` (lower), `docs/perf/standing-context-baseline.md` (after
  section)

- [ ] **Step 1: Pick targets from the Task 5 baseline** — rank items by per-turn cost. Planned
candidates (confirm against numbers): (a) compress `prompt_submit_ritual` — it's paid every turn;
(b) de-duplicate the join/inbox ritual between `orientation_joined` and the primer's loop section —
the primer keeps the full loop (it's the committed, always-present copy), the orientation shrinks
to pointing at it; (c) any tool description sentence restating primer guidance (use the
`description_bytes` breakdown from `measureToolSurface` to find the heavy ones).

- [ ] **Step 2: Trim** — edit the texts. `FEATURE_EPOCH` bump in the protocol if the hook text
change is client-visible per the ADR 148 ritual (check its criteria; a hook rewrite re-installed by
`init` likely qualifies — the epoch stamp is what lets installed hooks drift-check).

- [ ] **Step 3: Gate** — `pnpm build && pnpm coverage && pnpm guidance:check` — everything green,
  including Task 1's embedding test (update its constant expectations — the *constants* changed,
  the *embedding* must hold), Task 7's probe untouched and green, and the existing hook-string
  pins in `claudeCode.hooks.test.ts` updated to the new strings.

- [ ] **Step 4: Lower the budgets** — run `pnpm context:check`, set each trimmed item's budget to
  `Math.ceil(newMeasured * 1.05)`, justification `"post-trim 2026-08-0X"`. Re-run: PASS.

- [ ] **Step 5: Update the baseline doc** — add the before/after table (bytes + est tokens per
  item, per-turn total delta headline).

- [ ] **Step 6: Full gates + PR** — same gate list and PR ritual as Task 6 Step 3–4. After merge:
  `lane_submit` and resolve per outcome; save a seat memory at wrap-up (ADR 093).
