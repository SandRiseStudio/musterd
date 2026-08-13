# Memory Wiki (Increment 1) Implementation Plan

> **For agentic workers:** implement this plan task-by-task, in order, **inline in this seat's lane** (`01KZVPW7J5KFJ6PCD05WC0T9BN`, ryder). Do NOT dispatch writing subagents — every commit must carry the seat's identity (ADR 109). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `docs/wiki/` — governed, attributable team knowledge with a derived index and a CI gate — and land the ADR that declares git the source of truth and every memory system a derived index.

**Architecture:** Plain markdown pages in-repo; an index _generated_ from the pages' own first lines so it cannot drift (the defect that caused a false broadcast on 2026-08-12); a `wiki:check` gate in the existing `format:check` chain enforcing index sync, dated defect-claims, and live cross-links. No server surface, no new dependencies.

**Tech Stack:** Node native TypeScript (`node --disable-warning=ExperimentalWarning scripts/*.ts`), vitest (root config covers `scripts/**/*.test.ts`), prettier.

**Spec:** `docs/superpowers/specs/2026-08-12-memory-system-reexamination-design.md`

**Scope:** Increment 1 only. The 88-file migration (inc 2), seat-memory re-scoping (inc 3), and any retrieval index (inc 4, may never be built) are out of scope.

## Global Constraints

- **The index is derived, never hand-written.** `docs/wiki/INDEX.md` carries a "generated" header; the gate fails if it does not byte-match regeneration.
- **Defect-shaped claims carry a date.** Lintable heuristic (exact regexes in Task 3); falsifier _quality_ is template + review, not lint.
- **Wiring:** `wiki:check` appends to the `format:check` chain in `package.json` (that is how every doc gate reaches CI's `gates` job) — do not add a separate CI step.
- **ADR number:** allocate at PR time via `node --disable-warning=ExperimentalWarning scripts/adr-next.ts`; reserve with a stub + draft PR FIRST (ADR 223). Write `ADR NNN` until then and replace **scoped to files this lane touches** — a repo-wide `perl -pi` corrupts three unrelated docs that use `ADR NNN` as their own placeholder (hit live 2026-08-12).
- **Git:** branch `ryder/memory-reexamination` (exists, carries the spec). Commit per task. Never `git checkout <file>` as undo. Never `pnpm format`; use `pnpm exec prettier --write <files>`.
- **Gates order:** `pnpm build` before `typecheck`; root `pnpm test` (never `pnpm -r test` as the gate); `format:check` runs the whole doc-gate chain including the new `wiki:check`.
- **ADR ≥ 060 needs `## Observability & Evaluation`** answering **Traces / Eval / Experiment**, Eval naming a dataset and a baseline — the gate checks those three words.

## File Structure

| File                                  | Responsibility                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `docs/wiki/README.md`                 | Conventions + the page template. The one page a writer must read.                      |
| `docs/wiki/wake-leases.md`            | Seed page 1 — lease semantics traps (content held from ADR 252/254 work).              |
| `docs/wiki/vitest-package-configs.md` | Seed page 2 — per-package vitest inherits nothing (#754).                              |
| `docs/wiki/temp-daemon-probe.md`      | Seed page 3 — safe probe recipe; the team-create repoint trap.                         |
| `docs/wiki/context-budgets.md`        | Seed page 4 — standing-context byte budget; re-baseline convention.                    |
| `docs/wiki/INDEX.md`                  | Generated. Never edited.                                                               |
| `scripts/wiki-index.ts`               | Walks pages → emits INDEX.md. Exports `renderIndex(dir): string` for the gate + tests. |
| `scripts/check-wiki.ts`               | The gate: index sync + dated defect-claims + live links. Exit 1 on any failure.        |
| `scripts/wiki.test.ts`                | Tests for both scripts against fixture pages in a tmpdir.                              |
| `package.json`                        | `wiki:index`, `wiki:check` scripts; `wiki:check` appended to `format:check`.           |
| `docs/decisions/NNN-*.md`             | The ADR.                                                                               |

---

### Task 1: The wiki scaffold — conventions page + four seed pages

**Files:**

- Create: `docs/wiki/README.md`, `docs/wiki/wake-leases.md`, `docs/wiki/vitest-package-configs.md`, `docs/wiki/temp-daemon-probe.md`, `docs/wiki/context-budgets.md`

**Interfaces:**

- Produces: the page shape every later task parses — H1 title on line 1, **one-line summary as the first body line** (this becomes the index entry), then sections. Tasks 2–3 depend on exactly that shape.

- [ ] **Step 1: Write `docs/wiki/README.md`**

```markdown
# Wiki — how the team's knowledge is kept

Team knowledge as governed markdown: one page per topic, written by seats, reviewed like code. A choice the team made → ADR; a fact the team learned → wiki page.

## The rules

1. **Line 1 is an H1 title. The first body line is a one-sentence summary.** `INDEX.md` is generated from these — never edit it by hand (`pnpm wiki:index` regenerates; `pnpm wiki:check` fails CI on drift).
2. **Defect claims carry a date and a falsifier.** Any claim that something is broken, missing, or never happens must name when it was observed and what would disprove it: `autorefresh never installs (2026-07-31; falsify: read needsInstall in service.ts)`. The date is CI-enforced; the falsifier is on you and your reviewer.
3. **Corrections invalidate, dated — never overwrite.** Strike the old claim, keep it visible: `~~never installs~~ FIXED 2026-08-03 by #570`. Git supplies the history; the page keeps it legible.
4. **Writes go through the front door.** A wiki edit is a normal branch + commit by a seat — attributed (ADR 109), reviewed when non-trivial.

## Template

    # <Topic>

    <One sentence: what this page knows.>

    ## <Section>

    <Dated, falsifiable facts. Link related pages with relative links.>
```

- [ ] **Step 2: Write the four seed pages**

Each follows the template. Content is held from this week's work — write from the named sources, not from memory alone; verify each dated claim against its falsifier before writing it.

`docs/wiki/wake-leases.md`:

```markdown
# Wake leases

A wake lease is discharged by the seat REPORTING the wake — not by answering it — so `lease_expired` means the wake never landed, never "nobody answered".

## The trap (2026-08-12; falsify: read the report path in packages/server/src/store/residency.ts)

Three cases want opposite responses: `expired` ⇒ the seat is unreachable, escalate immediately; `reported`-but-unanswered ⇒ they are on it, HOLD (any hold window must outlive `WAKE_LEASE_TTL_MS` = 120s); `decline` ⇒ "not me" is information, escalate immediately. Anything keying escalation on `lease_expired` alone escalates on the wrong signal and stays silent on the right one (recorded in ADR 254 Consequences for increment 2).

## Related

`claimWakeLeases` already reasons per-act (`isExhausted` keyed on act_id) — an act-scoped gate mirrors `liveLease` keyed on `act_id` instead of `member_id`. A live seat is never woken (`hasLivePresence` guard), so "wake only if none live" is free.
```

`docs/wiki/vitest-package-configs.md`:

```markdown
# Per-package vitest configs

A package-local vitest run inherits NOTHING from the root config — each standalone package must re-declare whatever the root was giving it.

## The two ways this bit (fixed 2026-08-12 by #754; falsify: pnpm -r test)

telemetry had a `test` script and no config → fell back to the root config, whose include globs are root-relative (`packages/**/*.test.ts`), matched nothing from the package cwd, and reported "No test files found" for six real tests. cli had a config carrying only env vars → missing the ADR 190 machine-state isolation (`tests/setup/isolate-machine-state.ts`), so ~100 service tests died on the guard doing its job. The guard failing closed is correct — the missing piece is the isolation it demands.

## The rule

New package with tests ⇒ copy the 6-line config from packages/protocol; if the suite touches machine paths, mirror the root's `setupFiles` + `MUSTERD_CONFIG`/`MUSTERD_HOST_REGISTRY` pins.
```

`docs/wiki/temp-daemon-probe.md`:

```markdown
# Probing with a temp daemon

Run probes against a throwaway daemon on its own DB and port — never against the shared daemon on :4849, and never via `musterd team create` from an unguarded shell.

## The recipe (verified 2026-08-12; falsify: run it)

Point `MUSTERD_DB`, `MUSTERD_CONFIG`, `MUSTERD_HOST_REGISTRY` at a scratch dir, then `node packages/cli/dist/bin.js serve --port 4877`. Seed CLI identities under config key `knownIdentities` (NOT `vault`) as `[{team,name,key,surface}]`. Kill by PID when done — `pkill -f "bin.js serve"` kills the operator's shared daemon too.

## The repoint trap (2026-08-12, unowned lane 01KZVKF3H0R81XEA818G2QBRZC; falsify: read team.ts)

`musterd team create` writes `server` + `current` into the machine-global `~/.musterd/config.json`, silently repointing every CLI on the box; the damage presents as infrastructure being down (an hour lost 2026-08-12). Folders WITH a binding are immune, which is why the creating session never notices.
```

`docs/wiki/context-budgets.md`:

```markdown
# Standing-context byte budgets

Every byte in the MCP tools/list render is paid by every seat on every turn — `pnpm context:check` gates it, and it is NOT in the usual local gate list, so run it before pushing any tool-surface change.

## How it bites (2026-08-12; falsify: pnpm context:check on a branch adding tool description text)

Budgets live in docs/perf/context-budgets.json as measured + 5% with a dated justification; the headroom gets silently consumed by accretion, so an innocent description edit can be the one that trips the gate (ADR 254's did, +390 B, discovered only in CI). Raising a budget requires replacing its justification; measure main first — the overage may not be yours.
```

- [ ] **Step 3: Prettier + commit**

```bash
pnpm exec prettier --write docs/wiki/*.md
git add docs/wiki
git commit -m "Wiki scaffold: conventions + four seed pages (memory inc 1)"
```

---

### Task 2: The derived index

**Files:**

- Create: `scripts/wiki-index.ts`
- Test: `scripts/wiki.test.ts`
- Generated: `docs/wiki/INDEX.md`

**Interfaces:**

- Produces: `renderIndex(dir: string): string` and `WIKI_DIR` (repo-relative `docs/wiki`), imported by Task 3's gate. Index entry per page (excluding `README.md`, `INDEX.md`), sorted by filename: `- [<H1 text>](<file>) — <first body line>`.

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/wiki.test.ts
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderIndex } from './wiki-index.ts';

const dirs: string[] = [];
function fixture(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-test-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(pages)) writeFileSync(join(dir, name), body);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('renderIndex', () => {
  it('derives one entry per page from H1 + first body line, sorted, excluding README and INDEX', () => {
    const dir = fixture({
      'b-topic.md': '# Topic B\n\nSummary of B.\n\n## More\n',
      'a-topic.md': '# Topic A\n\nSummary of A.\n',
      'README.md': '# Wiki\n\nConventions.\n',
      'INDEX.md': 'stale\n',
    });
    const out = renderIndex(dir);
    expect(out).toContain('generated by `pnpm wiki:index` — do not edit');
    const lines = out.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual([
      '- [Topic A](a-topic.md) — Summary of A.',
      '- [Topic B](b-topic.md) — Summary of B.',
    ]);
  });

  it('throws, naming the file, when a page lacks an H1 or a summary line', () => {
    const dir = fixture({ 'bad.md': 'no heading here\n' });
    expect(() => renderIndex(dir)).toThrow(/bad\.md/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run scripts/wiki.test.ts`
Expected: FAIL — cannot resolve `./wiki-index.ts`.

- [ ] **Step 3: Implement `scripts/wiki-index.ts`**

```ts
/*
 * Derive docs/wiki/INDEX.md from the pages themselves — H1 + first body line per page.
 *
 * The index is GENERATED because a hand-written one goes stale against its own detail, and the
 * index is what gets read: on 2026-08-12 a stale one-line summary contradicted its own topic file
 * and a seat broadcast the stale claim to seven seats. A summary generated from the detail cannot
 * drift from it. (Memory reexamination spec, finding 2.)
 *
 *   pnpm wiki:index   — regenerate docs/wiki/INDEX.md
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WIKI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'wiki');
const EXCLUDED = new Set(['README.md', 'INDEX.md']);

export function renderIndex(dir: string): string {
  const entries: string[] = [];
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !EXCLUDED.has(f))
    .sort()) {
    const lines = readFileSync(join(dir, name), 'utf8').split('\n');
    const h1 = lines[0]?.match(/^#\s+(.+)$/)?.[1];
    const summary = lines
      .slice(1)
      .find((l) => l.trim() !== '' && !l.startsWith('#'))
      ?.trim();
    if (!h1 || !summary)
      throw new Error(
        `${name}: needs an H1 on line 1 and a one-line summary as the first body line`,
      );
    entries.push(`- [${h1}](${name}) — ${summary}`);
  }
  return [
    '# Wiki index',
    '',
    '<!-- generated by `pnpm wiki:index` — do not edit; `pnpm wiki:check` enforces sync -->',
    '',
    ...entries,
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(join(WIKI_DIR, 'INDEX.md'), renderIndex(WIKI_DIR));
  process.stdout.write('docs/wiki/INDEX.md regenerated\n');
}
```

- [ ] **Step 4: Run tests to verify pass, then generate the real index**

```bash
pnpm exec vitest run scripts/wiki.test.ts
node --disable-warning=ExperimentalWarning scripts/wiki-index.ts
```

Expected: tests PASS; INDEX.md lists the four seed pages.

- [ ] **Step 5: Commit**

```bash
git add scripts/wiki-index.ts scripts/wiki.test.ts docs/wiki/INDEX.md
git commit -m "Wiki index is derived from the pages, never written (memory inc 1)"
```

---

### Task 3: The gate — `wiki:check`

**Files:**

- Create: `scripts/check-wiki.ts`
- Modify: `scripts/wiki.test.ts` (append gate tests), `package.json` (two scripts + the `format:check` chain)

**Interfaces:**

- Consumes: `renderIndex`, `WIKI_DIR` from Task 2.
- Produces: exit 1 with per-failure lines on stderr; exit 0 silent-ish. Checks: (a) INDEX.md byte-matches regeneration; (b) defect-shaped claims dated; (c) intra-wiki links resolve.

- [ ] **Step 1: Append failing gate tests**

````ts
// append to scripts/wiki.test.ts
import { checkWiki } from './check-wiki.ts';

describe('checkWiki', () => {
  const good = {
    'a.md':
      '# A\n\nFine page.\n\nThe daemon never installs deps (2026-07-31; falsify: read service.ts). See [B](b.md).\n',
    'b.md': '# B\n\nAlso fine.\n',
  };
  const withIndex = (pages: Record<string, string>) => {
    const dir = fixture(pages);
    writeFileSync(join(dir, 'INDEX.md'), renderIndex(dir));
    return dir;
  };

  it('passes a synced index, dated claims, live links', () => {
    expect(checkWiki(withIndex(good))).toEqual([]);
  });

  it('fails when INDEX.md drifts from the pages', () => {
    const dir = withIndex(good);
    writeFileSync(join(dir, 'a.md'), '# A retitled\n\nFine page.\n');
    expect(checkWiki(dir).join('\n')).toMatch(/INDEX\.md.*wiki:index/);
  });

  it('fails an undated defect-shaped claim, naming file and line', () => {
    const dir = withIndex({ 'a.md': '# A\n\nSummary.\n\nautorefresh never installs deps.\n' });
    expect(checkWiki(dir).join('\n')).toMatch(/a\.md:5.*date/);
  });

  it('ignores defect-shaped phrases inside fenced code blocks', () => {
    const dir = withIndex({ 'a.md': '# A\n\nSummary.\n\n```\nthis never runs\n```\n' });
    expect(checkWiki(dir)).toEqual([]);
  });

  it('fails a dead intra-wiki link', () => {
    const dir = withIndex({ 'a.md': '# A\n\nSee [gone](missing.md).\n' });
    expect(checkWiki(dir).join('\n')).toMatch(/a\.md.*missing\.md/);
  });
});
````

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run scripts/wiki.test.ts`
Expected: FAIL — cannot resolve `./check-wiki.ts`.

- [ ] **Step 3: Implement `scripts/check-wiki.ts`**

````ts
/*
 * Gate the wiki (memory reexamination spec): the derived index is in sync, defect-shaped claims
 * carry a date, intra-wiki links resolve. Chained from `format:check` like every doc gate.
 *
 *   pnpm wiki:check   — exit 1 on any failure, one line each on stderr
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderIndex, WIKI_DIR } from './wiki-index.ts';

/** The dangerous shape: an assertion that something is broken/absent. Deliberately narrow — a
 *  looser net lints ordinary prose; widen only with a failing example in hand. */
const DEFECT_RE =
  /\b(?:is broken|is missing|never (?:fires|runs|installs|happens|works|comes)|does not (?:work|exist|fire|run|install)|cannot (?:be|reach|see|tell)|no way to)\b/i;
const DATED_RE = /\(20\d\d-\d\d(?:-\d\d)?/;
const LINK_RE = /\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g;

export function checkWiki(dir: string): string[] {
  const failures: string[] = [];
  const pages = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'INDEX.md');

  const indexPath = join(dir, 'INDEX.md');
  if (!existsSync(indexPath) || readFileSync(indexPath, 'utf8') !== renderIndex(dir)) {
    failures.push('INDEX.md is out of sync with the pages — run `pnpm wiki:index`');
  }

  for (const name of pages) {
    const lines = readFileSync(join(dir, name), 'utf8').split('\n');
    let fenced = false;
    lines.forEach((line, i) => {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      if (DEFECT_RE.test(line) && !DATED_RE.test(line)) {
        failures.push(
          `${name}:${i + 1} — defect-shaped claim needs a date (and a falsifier): "${line.trim().slice(0, 80)}"`,
        );
      }
      for (const m of line.matchAll(LINK_RE)) {
        if (!m[1]!.includes('/') && !existsSync(join(dir, m[1]!))) {
          failures.push(`${name}:${i + 1} — dead wiki link: ${m[1]}`);
        }
      }
    });
  }
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = checkWiki(WIKI_DIR);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`✗ ${f}\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ wiki clean — index in sync, claims dated, links live\n`);
}
````

- [ ] **Step 4: Wire `package.json`**

Add beside the sibling gates, and append `&& pnpm wiki:check` to the END of the `format:check` chain:

```json
"wiki:index": "node --disable-warning=ExperimentalWarning scripts/wiki-index.ts",
"wiki:check": "node --disable-warning=ExperimentalWarning scripts/check-wiki.ts",
```

- [ ] **Step 5: Verify green, then verify the gate actually FIRES**

A gate whose failure path was never observed is this week's defect class. Break it on purpose, watch it fail, restore:

```bash
pnpm exec vitest run scripts/wiki.test.ts && pnpm wiki:check
printf 'stale\n' >> docs/wiki/INDEX.md && pnpm wiki:check; echo "exit=$? (expect 1)"
node --disable-warning=ExperimentalWarning scripts/wiki-index.ts && pnpm wiki:check
```

Expected: PASS · exit=1 with the INDEX line · PASS again.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-wiki.ts scripts/wiki.test.ts package.json
git commit -m "wiki:check — index sync, dated defect-claims, live links (memory inc 1)"
```

---

### Task 4: The ADR

**Files:**

- Create: `docs/decisions/NNN-memory-git-truth-derived-indexes.md` (number from `adr-next`)
- Modify: the spec's Status line; any `ADR NNN` placeholders **in this lane's files only**

- [ ] **Step 1: Allocate + reserve the number (ADR 223)**

```bash
node --disable-warning=ExperimentalWarning scripts/adr-next.ts
# take the printed number NNN, then:
printf '# NNN — Memory: git as truth, derived indexes as caches\n\n- **Status:** proposed (reserving the number, ADR 223)\n' > docs/decisions/NNN-memory-git-truth-derived-indexes.md
git add docs/decisions && git commit -m "reserve ADR NNN — memory: git as truth" && git push -u origin ryder/memory-reexamination
gh pr create --draft --title "ADR NNN: memory — git as truth, derived indexes as caches" --body "Reserving ADR NNN (ADR 223). Full text + increment 1 landing on this branch. Spec: docs/superpowers/specs/2026-08-12-memory-system-reexamination-design.md. Lane: 01KZVPW7J5KFJ6PCD05WC0T9BN."
```

(File/H1 must agree — `adr-numbers:check` enforces.)

- [ ] **Step 2: Write the ADR**

Sections: `## Context` (the three stores + four findings, compressed from the spec with the measured numbers), `## Decision` (the four-layer table; the wiki rules; stores' dispositions — Cognee declared a cache, seat memory re-asserted to ADR 093's text, harness memory migration named as inc 2), `## Consequences` (increments 2–4 with inc 4 explicitly may-never-build; the nick-only CLAUDE.md rollout item), and `## Observability & Evaluation` in the gate's required shape:

- **Traces:** wiki writes are attributed commits (ADR 109); `wiki:check` failures are CI events; `seat_memory` sizes queryable server-side.
- **Eval:** dataset = the live corpus + live blobs; baseline = 2026-08-12 measurements (88 files / 608 KB un-governed; blob spread 242–5798 B; 1 stale-claim broadcast). Measures 1–4 verbatim from the spec, measure 4 gating increment 4.
- **Experiment:** none for the migration (governance change, small corpus); the retrieval increment, if measure 4 ever fires, runs grep vs Cognee-over-wiki vs temporal-KG on real lookup failures before adopting anything.

- [ ] **Step 3: Replace `ADR NNN` in THIS lane's files only, then run the doc gates**

```bash
grep -rln "ADR NNN" docs/wiki docs/decisions/NNN-* docs/superpowers/specs/2026-08-12-memory-system-reexamination-design.md scripts/wiki-index.ts scripts/check-wiki.ts 2>/dev/null
# fix each named file by hand or scoped perl; then:
pnpm exec prettier --write docs/decisions/*memory-git-truth* docs/wiki/*.md docs/superpowers/specs/2026-08-12-memory-system-reexamination-design.md
pnpm adr-numbers:check && pnpm obs-evals:check && pnpm vocab:check
```

- [ ] **Step 4: Commit**

```bash
git add docs/decisions docs/wiki docs/superpowers/specs
git commit -m "ADR NNN: memory — git as truth, derived indexes as caches"
```

---

### Task 5: Full gates, PR, lane close-out

- [ ] **Step 1: The full gate run**

```bash
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm format:check && pnpm context:check
```

All green. `format:check` now includes `wiki:check`; root `pnpm test` picks up `scripts/wiki.test.ts`. `context:check` should be untouched (no tool-surface change) — if it fails, someone else consumed the headroom; measure main before touching budgets.

- [ ] **Step 2: Push, un-draft, auto-merge**

```bash
git push && gh pr ready && gh pr merge --squash --auto --delete-branch
```

Update the PR body: the four-layer bet, the derived index as the structural fix for the false-broadcast incident, the gate's verified failure path, increments 2–4 deferred (4 may never be built).

- [ ] **Step 3: After merge — lane + team**

`lane_submit` on `01KZVPW7J5KFJ6PCD05WC0T9BN` with pr/sha/`authorized_by: nick`, then one `team_send status_update`: the wiki exists, the conventions in one line, migration is inc 2 as its own lane, and seats should trim their memory blobs to continuity at next wrap-up (inc 3) — with the pointer to `docs/wiki/README.md`.

---

## Self-Review

**Spec coverage:** wiki + template (T1); derived index (T2); gate + chain wiring (T3); ADR with the four-layer decision, store dispositions, obs-evals in gate shape (T4); increments 2–4 correctly absent as work but present in the ADR text (T4); verified-failure-path step for the new instrument (T3.5). Gap check: nick's CLAUDE.md rollout item is inc 3 — named in the ADR, deliberately not a task here.

**Placeholders:** `NNN` appears only in the allocate-at-PR-time flow, which is the repo's ritual, not a plan hole.

**Type consistency:** `renderIndex(dir: string): string` and `WIKI_DIR` defined in T2, consumed with the same names in T3; `checkWiki(dir: string): string[]` defined and tested with the same signature.
