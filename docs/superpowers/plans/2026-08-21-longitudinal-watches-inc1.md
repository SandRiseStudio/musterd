# Longitudinal Watches — Increment 1 Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Work them in order.
> Per this repo's CLAUDE.md, do NOT dispatch writing subagents — musterd is the coordination layer.
> Implement in your own seat, or hand a task to another seat with `team_send {act:'handoff'}`.

**Goal:** Make a days-long measurement a pre-registered, owned, finite question — a *watch* — and
make the recurring unread sweep impossible to create by accident.

**Architecture:** A watch is a markdown file with YAML frontmatter in `docs/watches/`, validated by
a hand-rolled parser (`scripts/watches.ts`) and enforced by three gate rules
(`scripts/check-watches.ts`) wired into `pnpm format:check`. Rule A is a tree check (a watch cannot
outlive its date); Rules B and C are diff checks against the merge-base, reusing
`check-change-adr.ts`'s existing base resolution. No daemon, no server table, no new dependency.

**Tech Stack:** TypeScript run directly by Node (`node --disable-warning=ExperimentalWarning`),
vitest for tests, `git` shelled out for diff scoping.

**Spec:** `docs/superpowers/specs/2026-08-21-longitudinal-watches-design.md`

**Lane:** `01M0ER03RJ2WZRD377FTNQCDP5` · **ADR:** 297 (reserved, PR #965) · **Branch:**
`izzo/longitudinal-watches`

## Global Constraints

- **No new dependencies.** ADR 002 governs; its own precedent is a hand-written minimal parser for
  argument parsing. `zod` is not available to `scripts/` and must not be added. Validate by hand,
  accumulating errors, exactly as `scripts/check-controls.ts` does.
- **Gate scripts live in `scripts/`,** are run as `node --disable-warning=ExperimentalWarning
  scripts/<name>.ts`, and are wired into the `format:check` chain in the root `package.json`.
- **Rule B must never become a tree check.** `scripts/check-change-adr.ts:176` documents why:
  it "would fire on every PR touching one of those 94." There are 291 ADRs.
- **Tests are `scripts/*.test.ts`,** already picked up by `vitest.config.ts` line 23.
- **Every commit message ends with:**
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and the `Claude-Session:` trailer.
- **Dates are ISO `YYYY-MM-DD`,** validated as real calendar dates, matching `check-controls.ts`.

---

## File Structure

| file | responsibility |
| --- | --- |
| `scripts/watches.ts` | parse frontmatter, expose typed accessors, validate one watch. No git, no I/O beyond `existsSync` for `claim_ref`. |
| `scripts/watches.test.ts` | parser + validator unit tests |
| `scripts/check-watches.ts` | the three gate rules; owns all git access and process exit |
| `scripts/check-watches.test.ts` | gate rule tests, driving pure rule functions rather than the CLI |
| `scripts/check-change-adr.ts` | **modify** — export `resolveBase` and `decisionSection` for reuse |
| `docs/watches/` | the watch records themselves |
| `docs/decisions/297-*.md` | the doctrine |
| `docs/controls/registry.ts` | **modify** — add optional `watch?: string` |

Parsing is split from the gate because the parser is pure and heavily unit-tested, while the gate
owns git and `process.exit`. Keeping git out of `watches.ts` is what makes the validator testable
without a repository fixture.

---

### Task 1: The watch record — parser and validator

**Files:**
- Create: `scripts/watches.ts`
- Create: `scripts/watches.test.ts`
- Create: `docs/watches/.gitkeep`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Watch { path, fields, body }`, `parseWatch(path, text): Watch | null`,
  `scalar(w, key): string | undefined`, `list(w, key): string[]`,
  `validateWatch(w, opts: { repoRoot: string }): string[]`, and the constant
  `REQUIRED_SCALARS: readonly string[]`. Tasks 2–4 consume all of these.

- [ ] **Step 1: Write the failing parser tests**

```ts
// scripts/watches.test.ts
import { describe, expect, it } from 'vitest';
import { list, parseWatch, scalar } from './watches.ts';

const SAMPLE = `---
question:   Does X reach zero?
claim_ref:  docs/decisions/166-session-liveness-by-enumeration.md
falsifier:  "any instance of X is a finding"
population: workspaces with a live binding
void_if:
  - distinct-seat count changes by >25% within the window
  - packages/cli/src/host/** changes within the window
series:     ~/.musterd/research/adr-166-slot-sweep.jsonl
cadence:    5m
opened:     2026-08-21
opened_by:  izzo
revisit_by: 2026-09-04
status:     open
resolution:
---

Prose body.
`;

describe('parseWatch', () => {
  it('reads scalars, stripping quotes and padding', () => {
    const w = parseWatch('w.md', SAMPLE)!;
    expect(scalar(w, 'question')).toBe('Does X reach zero?');
    expect(scalar(w, 'falsifier')).toBe('any instance of X is a finding');
    expect(scalar(w, 'opened_by')).toBe('izzo');
  });

  it('reads a block list', () => {
    const w = parseWatch('w.md', SAMPLE)!;
    expect(list(w, 'void_if')).toHaveLength(2);
    expect(list(w, 'void_if')[1]).toBe('packages/cli/src/host/** changes within the window');
  });

  it('treats an empty scalar as absent, not as the empty string', () => {
    const w = parseWatch('w.md', SAMPLE)!;
    expect(scalar(w, 'resolution')).toBeUndefined();
  });

  it('keeps the prose body', () => {
    expect(parseWatch('w.md', SAMPLE)!.body.trim()).toBe('Prose body.');
  });

  it('returns null when there is no frontmatter', () => {
    expect(parseWatch('w.md', '# just a heading\n')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run scripts/watches.test.ts`
Expected: FAIL — `Failed to resolve import "./watches.ts"`.

- [ ] **Step 3: Implement the parser**

```ts
// scripts/watches.ts
/*
 * The watch record — parse and validate one pre-registered longitudinal question.
 *
 * A watch states a question, the falsifier that would settle it, the population it samples, and the
 * conditions that disqualify its own window — all BEFORE collection starts. See ADR 297 and
 * docs/superpowers/specs/2026-08-21-longitudinal-watches-design.md.
 *
 * NO YAML DEPENDENCY. ADR 002 keeps the dependency surface deliberately small and sets the
 * precedent directly: argument parsing "uses a hand-written minimal parser ... since the command
 * surface is small and fully specified". The frontmatter subset a watch uses is smaller still —
 * scalars and one block list — so it is parsed here rather than pulling in a YAML engine.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Watch {
  readonly path: string;
  readonly fields: Record<string, string | string[]>;
  readonly body: string;
}

export const REQUIRED_SCALARS = [
  'question',
  'claim_ref',
  'falsifier',
  'population',
  'series',
  'cadence',
  'opened',
  'opened_by',
  'revisit_by',
  'status',
] as const;

export const STATUSES = ['open', 'resolved', 'void'] as const;

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function unquote(value: string): string {
  const v = value.trim();
  const quoted = /^"(.*)"$/.exec(v) ?? /^'(.*)'$/.exec(v);
  return quoted ? quoted[1] : v;
}

/**
 * An empty scalar and the head of a block list look identical in this subset (`key:` with nothing
 * after it), so both become `[]` and {@link scalar} reports `[]` as absent. That collapse is what
 * lets `resolution:` sit empty on an open watch without a sentinel value.
 */
export function parseWatch(path: string, text: string): Watch | null {
  const m = FRONTMATTER.exec(text);
  if (!m) return null;

  const fields: Record<string, string | string[]> = {};
  let listKey: string | null = null;

  for (const raw of m[1].split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;

    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      (fields[listKey] as string[]).push(unquote(item[1]));
      continue;
    }

    const kv = /^([a-z_]+):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value.trim() === '') {
      fields[key] = [];
      listKey = key;
    } else {
      fields[key] = unquote(value);
      listKey = null;
    }
  }

  return { path, fields, body: m[2] };
}

export function scalar(w: Watch, key: string): string | undefined {
  const v = w.fields[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

export function list(w: Watch, key: string): string[] {
  const v = w.fields[key];
  return Array.isArray(v) ? v.filter((s) => s.trim() !== '') : [];
}
```

- [ ] **Step 4: Run the parser tests to verify they pass**

Run: `pnpm vitest run scripts/watches.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing validator tests**

Append to `scripts/watches.test.ts`:

```ts
import { validateWatch } from './watches.ts';

const ROOT = process.cwd();
const withField = (key: string, value: string) =>
  parseWatch('w.md', SAMPLE.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: ${value}`))!;

describe('validateWatch', () => {
  it('accepts the well-formed sample', () => {
    expect(validateWatch(parseWatch('w.md', SAMPLE)!, { repoRoot: ROOT })).toEqual([]);
  });

  it('rejects a missing required scalar', () => {
    const w = parseWatch('w.md', SAMPLE.replace(/^population:.*$/m, ''))!;
    expect(validateWatch(w, { repoRoot: ROOT }).join(' ')).toContain('population');
  });

  it('rejects an empty void_if — a watch with no way to be void claims its population is immutable', () => {
    const w = parseWatch('w.md', SAMPLE.replace(/void_if:\n(  - .*\n)+/, 'void_if:\n'))!;
    expect(validateWatch(w, { repoRoot: ROOT }).join(' ')).toContain('void_if');
  });

  it('rejects revisit_by on or before opened', () => {
    expect(validateWatch(withField('revisit_by', '2026-08-21'), { repoRoot: ROOT }).join(' '))
      .toContain('revisit_by');
  });

  it('rejects a claim_ref that does not exist — the post-back target must be real', () => {
    expect(validateWatch(withField('claim_ref', 'docs/decisions/999-nope.md'), { repoRoot: ROOT })
      .join(' ')).toContain('claim_ref');
  });

  it('rejects an unknown status', () => {
    expect(validateWatch(withField('status', 'paused'), { repoRoot: ROOT }).join(' '))
      .toContain('status');
  });

  it('requires a resolution once the watch is no longer open', () => {
    expect(validateWatch(withField('status', 'void'), { repoRoot: ROOT }).join(' '))
      .toContain('resolution');
  });

  it('accepts a resolved watch that carries its resolution', () => {
    const w = parseWatch(
      'w.md',
      SAMPLE.replace(/^status:.*$/m, 'status: void').replace(/^resolution:$/m, 'resolution: "population unstable"'),
    )!;
    expect(validateWatch(w, { repoRoot: ROOT })).toEqual([]);
  });

  it('rejects a malformed or impossible date', () => {
    expect(validateWatch(withField('opened', '2026-02-30'), { repoRoot: ROOT }).join(' '))
      .toContain('opened');
  });
});
```

- [ ] **Step 6: Run the validator tests to verify they fail**

Run: `pnpm vitest run scripts/watches.test.ts`
Expected: FAIL — `validateWatch is not exported`.

- [ ] **Step 7: Implement the validator**

Append to `scripts/watches.ts`:

```ts
/** ISO YYYY-MM-DD that is also a real calendar date — `2026-02-30` parses but is not a day. */
function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Every rule a watch must satisfy regardless of the calendar or the diff. Errors accumulate rather
 * than throwing, so one run reports every problem in a file — the `check-controls.ts` idiom.
 */
export function validateWatch(w: Watch, opts: { repoRoot: string }): string[] {
  const errors: string[] = [];
  const at = (msg: string) => errors.push(`${w.path} — ${msg}`);

  for (const key of REQUIRED_SCALARS) {
    if (scalar(w, key) === undefined) at(`missing required field \`${key}\`.`);
  }

  if (list(w, 'void_if').length === 0) {
    at(
      '`void_if` needs at least one condition. A watch with no way to be void is claiming its ' +
        'population cannot change, which is the assumption that made the ADR 166 series unreadable.',
    );
  }

  const status = scalar(w, 'status');
  if (status !== undefined && !STATUSES.includes(status as (typeof STATUSES)[number])) {
    at(`\`status\` must be one of ${STATUSES.join(' | ')}; found \`${status}\`.`);
  }

  const resolution = scalar(w, 'resolution');
  if (status !== undefined && status !== 'open' && resolution === undefined) {
    at(
      `\`status: ${status}\` requires a \`resolution\`. A terminal watch without a verdict is the ` +
        'silence this primitive exists to prevent.',
    );
  }
  if (status === 'open' && resolution !== undefined) {
    at('`resolution` is set while `status` is still `open`. Move the status, or drop the verdict.');
  }

  for (const key of ['opened', 'revisit_by'] as const) {
    const value = scalar(w, key);
    if (value !== undefined && !isRealDate(value)) {
      at(`\`${key}\` must be a real ISO date (YYYY-MM-DD); found \`${value}\`.`);
    }
  }

  const opened = scalar(w, 'opened');
  const revisitBy = scalar(w, 'revisit_by');
  if (opened && revisitBy && isRealDate(opened) && isRealDate(revisitBy) && revisitBy <= opened) {
    at(`\`revisit_by\` (${revisitBy}) must be after \`opened\` (${opened}).`);
  }

  const claimRef = scalar(w, 'claim_ref');
  if (claimRef !== undefined && !existsSync(join(opts.repoRoot, claimRef))) {
    at(
      `\`claim_ref\` points at \`${claimRef}\`, which does not exist. It is the post-back target — ` +
        'a resolution has to land somewhere a reader already goes.',
    );
  }

  return errors;
}
```

- [ ] **Step 8: Run the whole file to verify it passes**

Run: `pnpm vitest run scripts/watches.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 9: Commit**

```bash
mkdir -p docs/watches && touch docs/watches/.gitkeep
git add scripts/watches.ts scripts/watches.test.ts docs/watches/.gitkeep
git commit -m "Watch records parse and validate without a YAML dependency

ADR 002's own precedent: a hand-written minimal parser where the surface is
small and fully specified. A watch's frontmatter is scalars and one block
list, so an empty scalar and an empty list collapse to the same value and
\`resolution:\` can sit blank on an open watch without a sentinel.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01T39Nd5PnH6924Au1p3PLbe"
```

---

### Task 2: Rule A — a watch cannot outlive its `revisit_by`

**Files:**
- Create: `scripts/check-watches.ts`
- Create: `scripts/check-watches.test.ts`
- Modify: `package.json` (add `watch:check`, add it to the `format:check` chain)

**Interfaces:**
- Consumes: `parseWatch`, `scalar`, `validateWatch` from Task 1.
- Produces: `ruleA(watches: Watch[], today: string): string[]` and
  `ruleAImmutable(changed: ChangedWatch[]): string[]`, where
  `interface ChangedWatch { path: string; head: Watch; base: Watch | null }`. Tasks 3 and 4 consume
  `ChangedWatch` and add their own `ruleB` / `ruleC` exports to this file.

Rule A has two halves that scope differently, which is why they are separate functions: **A1** is a
tree check (any open watch, anywhere, past its date) and **A2** is a diff check (`revisit_by` moved
on a watch that already existed at the merge-base).

- [ ] **Step 1: Write the failing Rule A tests**

```ts
// scripts/check-watches.test.ts
import { describe, expect, it } from 'vitest';
import { parseWatch, type Watch } from './watches.ts';
import { ruleA, ruleAImmutable } from './check-watches.ts';

function watch(overrides: Record<string, string> = {}): Watch {
  const base: Record<string, string> = {
    question: 'Does X reach zero?',
    claim_ref: 'docs/decisions/166-session-liveness-by-enumeration.md',
    falsifier: '"any instance of X is a finding"',
    population: 'workspaces with a live binding',
    series: '~/.musterd/research/adr-166-slot-sweep.jsonl',
    cadence: '5m',
    opened: '2026-08-01',
    opened_by: 'izzo',
    revisit_by: '2026-09-04',
    status: 'open',
    ...overrides,
  };
  const body = Object.entries(base)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  return parseWatch('docs/watches/w.md', `---\n${body}\nvoid_if:\n  - the population moves\n---\n\nBody.\n`)!;
}

describe('rule A — no watch outlives its revisit_by', () => {
  it('passes a watch still inside its window', () => {
    expect(ruleA([watch()], '2026-09-01')).toEqual([]);
  });

  it('fails an open watch past its revisit_by', () => {
    const errors = ruleA([watch()], '2026-09-05');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('revisit_by');
  });

  it('names the opener, so a stranger who hits this knows who to ask', () => {
    expect(ruleA([watch()], '2026-09-05')[0]).toContain('izzo');
  });

  it('offers voiding as the legitimate one-line escape', () => {
    expect(ruleA([watch()], '2026-09-05')[0]).toContain('void');
  });

  it('passes the same overdue watch once it is resolved', () => {
    expect(ruleA([watch({ status: 'resolved', resolution: 'target zero breached' })], '2026-09-05')).toEqual([]);
  });

  it('passes the same overdue watch once it is void', () => {
    expect(ruleA([watch({ status: 'void', resolution: 'unattended' })], '2026-09-05')).toEqual([]);
  });
});

describe('rule A — revisit_by is immutable once merged', () => {
  it('fails when revisit_by moves forward on an existing watch', () => {
    const errors = ruleAImmutable([
      { path: 'docs/watches/w.md', head: watch({ revisit_by: '2026-10-01' }), base: watch() },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('renewed in place');
  });

  it('passes when revisit_by is unchanged', () => {
    expect(ruleAImmutable([{ path: 'docs/watches/w.md', head: watch(), base: watch() }])).toEqual([]);
  });

  it('passes a brand-new watch, which has no base to contradict', () => {
    expect(ruleAImmutable([{ path: 'docs/watches/w.md', head: watch(), base: null }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run scripts/check-watches.test.ts`
Expected: FAIL — `Failed to resolve import "./check-watches.ts"`.

- [ ] **Step 3: Implement Rule A**

```ts
// scripts/check-watches.ts
/*
 * The watch gate — a pre-registered longitudinal question cannot rot into an unread sweep.
 *
 * Three rules, deliberately scoped differently:
 *
 *   A. no watch outlives its `revisit_by`   — TREE check (plus a diff half for immutability)
 *   B. a frequency claim carries a watch    — DIFF check, never a tree check
 *   C. a resolution posts back              — DIFF check
 *
 * RULE A BREAKS THE BUILD ON A DATE ROLLOVER WITH NO CODE CHANGE. That is uncomfortable and it is
 * the design, inherited verbatim from `check-controls.ts`, which already does exactly this from
 * `format:check` today. Its pressure valve is the honest one: resolve the watch, or mark it
 * `void: unattended`. Voiding is not a dodge — it records that nobody looked, which is the datum
 * ADR 294 wants and the thing ADR 166's sweep hid for 25 days. Both leave a record; ignoring it
 * does not.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseWatch, scalar, validateWatch, type Watch } from './watches.ts';

export interface ChangedWatch {
  readonly path: string;
  readonly head: Watch;
  readonly base: Watch | null;
}

/** A1 — tree check. Any open watch past its date, anywhere in the repo. */
export function ruleA(watches: Watch[], today: string): string[] {
  const errors: string[] = [];
  for (const w of watches) {
    if (scalar(w, 'status') !== 'open') continue;
    const revisitBy = scalar(w, 'revisit_by');
    if (revisitBy === undefined || revisitBy >= today) continue;
    errors.push(
      `${w.path} — open past its \`revisit_by\` (${revisitBy}, today ${today}). ` +
        `Opened by ${scalar(w, 'opened_by') ?? 'an unnamed seat'}. ` +
        'Resolve it with a verdict, or mark it `status: void` with ' +
        '`resolution: "unattended — revisit_by passed with nobody reading the series. No verdict."` ' +
        'Voiding is legitimate: it records that we failed to look. What is not allowed is moving ' +
        'the date.',
    );
  }
  return errors;
}

/** A2 — diff check. `revisit_by` is immutable once a watch is on main. */
export function ruleAImmutable(changed: ChangedWatch[]): string[] {
  const errors: string[] = [];
  for (const { path, head, base } of changed) {
    if (base === null) continue;
    const was = scalar(base, 'revisit_by');
    const now = scalar(head, 'revisit_by');
    if (was !== undefined && now !== undefined && was !== now) {
      errors.push(
        `${path} — \`revisit_by\` moved ${was} → ${now}. A watch cannot be renewed in place. ` +
          'Continuing the question means a NEW watch file, with a new question, in a diff someone ' +
          'reviews — that cost is the whole mechanism preventing a sweep that renews itself for free.',
      );
    }
  }
  return errors;
}

export function readWatches(repoRoot: string): Watch[] {
  const dir = join(repoRoot, 'docs/watches');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const watches: Watch[] = [];
  for (const name of names) {
    const path = `docs/watches/${name}`;
    const w = parseWatch(path, readFileSync(join(dir, name), 'utf8'));
    if (w !== null) watches.push(w);
  }
  return watches;
}

function main(): void {
  const repoRoot = process.cwd();
  const today = new Date().toISOString().slice(0, 10);
  const watches = readWatches(repoRoot);

  const errors = [
    ...watches.flatMap((w) => validateWatch(w, { repoRoot })),
    ...ruleA(watches, today),
  ];

  if (errors.length > 0) {
    process.stderr.write(`✗ watch:check\n\n${errors.map((e) => `  ${e}\n`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `✓ watch:check — ${watches.length} watch(es), none past their revisit_by.\n`,
  );
}

// The robust form, matching check-wiki.ts:164. Do NOT use check-controls.ts's
// `import.meta.url === \`file://${process.argv[1]}\`` — it breaks on paths needing URL encoding.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
```

with `import { fileURLToPath } from 'node:url';` at the top.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run scripts/check-watches.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Wire the gate into `format:check`**

In the root `package.json`, add the script:

```json
"watch:check": "node --disable-warning=ExperimentalWarning scripts/check-watches.ts",
```

and append ` && pnpm watch:check` to the end of the existing `format:check` value, after
`pnpm controls:check`.

- [ ] **Step 6: Run the gate against the real tree**

Run: `pnpm watch:check`
Expected: `✓ watch:check — 0 watch(es), none past their revisit_by.`

- [ ] **Step 7: Commit**

```bash
git add scripts/check-watches.ts scripts/check-watches.test.ts package.json
git commit -m "Rule A: a watch cannot outlive its revisit_by, and cannot be renewed in place

Breaks the build on a date rollover with no code change, inherited verbatim
from check-controls.ts which already does this from format:check. The escape
is one line and it is honest: marking a watch void records that nobody
looked. Moving the date is the one thing disallowed — free renewal is how
ADR 166's sweep ran 5,679 times unread.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01T39Nd5PnH6924Au1p3PLbe"
```

---

### Task 3: Rule B — the frequency-adverb rule

**Files:**
- Modify: `scripts/check-change-adr.ts:50` and `:143` — export `resolveBase` and `decisionSection`
- Modify: `scripts/check-watches.ts` — add `ruleB`, call it from `main`
- Modify: `scripts/check-watches.test.ts` — add the Rule B block

**Interfaces:**
- Consumes: `resolveBase(): string` and `decisionSection(text: string): string | null`, newly
  exported from `check-change-adr.ts`.
- Produces: `ruleB(adrs: { path: string; text: string }[]): string[]` and the exported constant
  `FREQUENCY_TERMS: readonly string[]`.

- [ ] **Step 1: Write the failing Rule B tests**

Append to `scripts/check-watches.test.ts`:

```ts
import { ruleB } from './check-watches.ts';

const adr = (decision: string, header = '') =>
  `# 301 — A thing\n\n- Status: draft — 2026-08-21.\n${header}\n## Context\n\nThe reconnect is flaky under load, historically.\n\n## Decision\n\n${decision}\n\n## Consequences\n\nNone.\n`;

describe('rule B — a frequency claim in a Decision needs a watch', () => {
  it('fails an unbacked frequency claim', () => {
    const errors = ruleB([{ path: 'docs/decisions/301-a.md', text: adr('The reconnect is flaky under load, so we retry.') }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('flaky');
  });

  it('passes when a watch is cited', () => {
    expect(
      ruleB([
        {
          path: 'docs/decisions/301-a.md',
          text: adr('The reconnect is flaky under load, so we retry.', '- Snapshot-debt: docs/watches/2026-08-21-reconnect.md\n'),
        },
      ]),
    ).toEqual([]);
  });

  it('passes when the debt is explicitly waived with a reason', () => {
    expect(
      ruleB([
        {
          path: 'docs/decisions/301-a.md',
          text: adr('The reconnect is flaky under load, so we retry.', "- Snapshot-debt: none — quoting ryder's #912 measurement\n"),
        },
      ]),
    ).toEqual([]);
  });

  it('ignores the same adverb in Context — history is quoted there, not asserted', () => {
    expect(ruleB([{ path: 'docs/decisions/301-a.md', text: adr('We retry three times.') }])).toEqual([]);
  });

  it('does not fire on always/never — those are absence claims, not frequency claims', () => {
    expect(ruleB([{ path: 'docs/decisions/301-a.md', text: adr('The guard never permits a spawn.') }])).toEqual([]);
  });

  it('matches whole words only, so "rarely" does not fire on "rare-earth" prose', () => {
    expect(ruleB([{ path: 'docs/decisions/301-a.md', text: adr('We compare it to rarefied alternatives.') }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run scripts/check-watches.test.ts -t "rule B"`
Expected: FAIL — `ruleB is not exported`.

- [ ] **Step 3: Export the two helpers from `check-change-adr.ts`**

Change line 50 from `function resolveBase(): string {` to `export function resolveBase(): string {`,
and line 143 from `function decisionSection(text: string): string | null {` to
`export function decisionSection(text: string): string | null {`. Change nothing else in that file.

- [ ] **Step 4: Implement Rule B**

Append to `scripts/check-watches.ts` (and add `decisionSection` to the imports):

```ts
/**
 * Frequency of a time-varying quantity — the tell that a claim needs a window, not a moment.
 *
 * Deliberately excludes `always` / `never`: those are ADR 294 `absence`-class claims, they are
 * ubiquitous in ordinary prose, and they are the controls registry's problem, not this one.
 */
export const FREQUENCY_TERMS = [
  'flaky',
  'intermittent',
  'intermittently',
  'rare',
  'rarely',
  'usually',
  'often',
  'frequently',
  'occasionally',
  'sometimes',
  'sporadic',
  'sporadically',
  'under load',
  'most of the time',
] as const;

const SNAPSHOT_DEBT = /^-?\s*Snapshot-debt:\s*(\S.*)$/m;

/**
 * DIFF-SCOPED BY ITS CALLER, NEVER TREE-SCOPED. `check-change-adr.ts:176` records why: making that
 * gate a tree check "would fire on every PR touching one of those 94". Measured 2026-08-21: 14 of
 * 292 existing ADRs carry a frequency term in their Decision — not most, but 14 an author cannot fix.
 */
export function ruleB(adrs: { path: string; text: string }[]): string[] {
  const errors: string[] = [];
  for (const { path, text } of adrs) {
    const decision = decisionSection(text);
    if (decision === null) continue;
    if (SNAPSHOT_DEBT.test(text)) continue;

    const hit = FREQUENCY_TERMS.find((term) =>
      new RegExp(`\\b${term.replace(/ /g, '\\s+')}\\b`, 'i').test(decision),
    );
    if (hit === undefined) continue;

    errors.push(
      `${path} — \`## Decision\` asserts a frequency claim (\`${hit}\`). A frequency claim is a ` +
        'window, not a moment. Either cite a watch:\n' +
        '      Snapshot-debt: docs/watches/<date>-<slug>.md\n' +
        '    or waive it with a reason:\n' +
        '      Snapshot-debt: none — <why this is not a snapshot you are asserting>',
    );
  }
  return errors;
}
```

- [ ] **Step 5: Call Rule B from `main`, scoped to the diff**

In `main()`, before the error assembly, add:

```ts
  const base = resolveBase();
  const changedAdrs = git('diff', '--name-only', `${base}...HEAD`)
    .split('\n')
    .filter((p) => /^docs\/decisions\/\d+-.*\.md$/.test(p))
    .filter((p) => existsSync(join(repoRoot, p)))
    .map((p) => ({ path: p, text: readFileSync(join(repoRoot, p), 'utf8') }));
```

and add `...ruleB(changedAdrs),` to the `errors` array. Add the local `git` helper, copied from
`check-change-adr.ts:33`:

```ts
function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
```

with `import { execFileSync } from 'node:child_process';` and `import { existsSync } from 'node:fs';`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run scripts/check-watches.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 7: Verify the tree-check trap is actually avoided**

Run: `pnpm watch:check`
Expected: still `✓` — the 291 existing ADRs contain frequency adverbs, and the gate must not see
them because they are not in this branch's diff. **If this fails, Rule B has become a tree check and
the task is wrong.**

- [ ] **Step 8: Commit**

```bash
git add scripts/check-watches.ts scripts/check-watches.test.ts scripts/check-change-adr.ts
git commit -m "Rule B: a frequency claim in a Decision carries a Snapshot-debt

Diff-scoped against the merge-base, reusing check-change-adr's own base
resolution and Decision extractor rather than a second copy. It must never
become a tree check: that file's line 176 already records what happens when
one does. Excludes always/never — absence claims belong to the controls
registry, not here.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01T39Nd5PnH6924Au1p3PLbe"
```

---

### Task 4: Rule C — a resolution must post back

**Files:**
- Modify: `scripts/check-watches.ts` — add `ruleC`, call it from `main`
- Modify: `scripts/check-watches.test.ts` — add the Rule C block

**Interfaces:**
- Consumes: `ChangedWatch` from Task 2.
- Produces: `ruleC(changed: ChangedWatch[], changedPaths: string[]): string[]`.

- [ ] **Step 1: Write the failing Rule C tests**

Append to `scripts/check-watches.test.ts`:

```ts
import { ruleC } from './check-watches.ts';

const CLAIM_REF = 'docs/decisions/166-session-liveness-by-enumeration.md';

describe('rule C — a resolution posts back to what depended on it', () => {
  const resolving = () => ({
    path: 'docs/watches/w.md',
    head: watch({ status: 'void', resolution: 'population unstable' }),
    base: watch(),
  });

  it('fails a resolution that does not touch claim_ref', () => {
    const errors = ruleC([resolving()], ['docs/watches/w.md']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(CLAIM_REF);
  });

  it('passes when the same diff touches claim_ref', () => {
    expect(ruleC([resolving()], ['docs/watches/w.md', CLAIM_REF])).toEqual([]);
  });

  it('ignores a watch that was already terminal at the base', () => {
    const already = {
      path: 'docs/watches/w.md',
      head: watch({ status: 'void', resolution: 'population unstable' }),
      base: watch({ status: 'void', resolution: 'population unstable' }),
    };
    expect(ruleC([already], ['docs/watches/w.md'])).toEqual([]);
  });

  it('ignores a watch that is still open', () => {
    expect(ruleC([{ path: 'docs/watches/w.md', head: watch(), base: watch() }], ['docs/watches/w.md'])).toEqual([]);
  });

  it('applies to a brand-new watch that lands already resolved', () => {
    const born = { path: 'docs/watches/w.md', head: watch({ status: 'resolved', resolution: 'target zero breached' }), base: null };
    expect(ruleC([born], ['docs/watches/w.md'])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run scripts/check-watches.test.ts -t "rule C"`
Expected: FAIL — `ruleC is not exported`.

- [ ] **Step 3: Implement Rule C**

Append to `scripts/check-watches.ts`:

```ts
/**
 * A verdict that lands only in `docs/watches/` is a verdict nobody reads — which is the exact
 * failure this primitive exists to end. Resolving a watch must move the file the watch names as
 * depending on it, so the answer arrives where the decision lives.
 */
export function ruleC(changed: ChangedWatch[], changedPaths: string[]): string[] {
  const errors: string[] = [];
  const touched = new Set(changedPaths);

  for (const { path, head, base } of changed) {
    const now = scalar(head, 'status');
    if (now === undefined || now === 'open') continue;
    if (base !== null && scalar(base, 'status') === now) continue;

    const claimRef = scalar(head, 'claim_ref');
    if (claimRef === undefined || touched.has(claimRef)) continue;

    errors.push(
      `${path} — resolved to \`${now}\` without touching its \`claim_ref\` (${claimRef}). ` +
        'A resolution has to post back: record the verdict as a dated note on the decision that ' +
        'depended on it, in the same diff. Otherwise the answer lives somewhere nobody reads, ' +
        'which is the failure the watch was opened to prevent.',
    );
  }
  return errors;
}
```

- [ ] **Step 4: Assemble `ChangedWatch` in `main` and call Rule C**

In `main()`, add:

```ts
  const changedPaths = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);

  const changedWatches: ChangedWatch[] = changedPaths
    .filter((p) => /^docs\/watches\/.*\.md$/.test(p))
    .flatMap((p) => {
      const headText = existsSync(join(repoRoot, p)) ? readFileSync(join(repoRoot, p), 'utf8') : null;
      if (headText === null) return [];
      const head = parseWatch(p, headText);
      if (head === null) return [];
      // A watch absent at the base is new; `git show` exits non-zero, which is the signal.
      let baseWatch: Watch | null = null;
      try {
        baseWatch = parseWatch(p, git('show', `${base}:${p}`));
      } catch {
        baseWatch = null;
      }
      return [{ path: p, head, base: baseWatch }];
    });
```

Then extend the `errors` array with `...ruleAImmutable(changedWatches), ...ruleC(changedWatches, changedPaths),`.
Reuse the single `changedPaths` computation for Task 3's `changedAdrs` rather than shelling out twice.

- [ ] **Step 5: Run the full gate test suite**

Run: `pnpm vitest run scripts/check-watches.test.ts scripts/watches.test.ts`
Expected: PASS, 34 tests.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-watches.ts scripts/check-watches.test.ts
git commit -m "Rule C: resolving a watch must post the verdict back to claim_ref

Without this the protocol has no teeth — a verdict that lands only in
docs/watches/ is a verdict nobody reads, which is the failure being fixed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01T39Nd5PnH6924Au1p3PLbe"
```

---

### Task 5: ADR 297 and the controls-registry link

**Files:**
- Modify: `docs/decisions/297-longitudinal-watches-pre-registered-not-scheduled.md` (replace the stub)
- Modify: `docs/controls/registry.ts` (add the optional `watch` field to the `Control` interface)

**Interfaces:**
- Consumes: nothing at runtime.
- Produces: `Control.watch?: string`.

- [ ] **Step 1: Write ADR 297**

Replace the stub with the full ADR, following the house structure (`## Context`, `## Decision`,
`## Consequences`, `## Evaluation`). It must contain, argued rather than asserted:

- **The evidence**, from the spec's "problem, measured": 5,682 samples / 24.8 days / 49.5 MB
  unread; `demoted` at 109 against a pre-registered target of zero; 214 `DEMOTED` lines and an
  escalation path that fired for 25 days into a channel with no owner.
- **The rule**, mirroring the claims ledger's: *the ledger says the corrector mints, riding the act
  they are already performing; ADR 297 says the decider opens the watch, riding the act they are
  already performing — writing the decision.*
- **The falsifier-phrasing rule** — prefer a target-zero count over a rate, with ADR 166 as the
  worked case: over identical data and a population that swung 23 → 196 → 9, the count stayed
  readable and the rates did not.
- **Why a watch dies** — finite, question-scoped, no renewal in place. Cite nick's constraint from
  the 2026-08-19/20 design conversation directly: this is not licence for recurring background
  extraction.
- **`## Evaluation`**, pre-registered, since this ADR is itself subject to its own rule: *by
  2026-11-01, has any watch been opened by a seat other than izzo? Has any watch resolved with a
  verdict rather than `void: unattended`?* A gate everyone routes around is a gate that failed.

- [ ] **Step 2: Add the `watch` field to the controls registry**

In `docs/controls/registry.ts`, add to the `Control` interface:

```ts
  /**
   * The watch measuring this control's rate, when a date cannot settle its efficacy.
   *
   * `lastExercised` answers "did someone watch it work" — a moment. Some controls' efficacy is a
   * RATE, and a rate needs a window: ADR 227's infra-touch gate is the live instance, where the
   * warn→redirect rate was "unmeasurable as built". Optional, and left unset for every control
   * whose efficacy a date does settle.
   */
  watch?: string;
```

Set it on no control yet — Task 6 opens the first watches, and none of them measures a registry
control. Adding the field without a consumer is deliberate: it is the join point, and leaving it out
would mean the next person hits the same wall ADR 227 did.

- [ ] **Step 3: Verify nothing broke**

Run: `pnpm controls:check && pnpm watch:check && pnpm vitest run scripts/`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add docs/decisions/297-longitudinal-watches-pre-registered-not-scheduled.md docs/controls/registry.ts
git commit -m "ADR 297: a measurement over days is a pre-registered question

The decider opens the watch, riding the act they are already performing —
the mirror of the claims ledger's 'the corrector mints'. Carries its own
Evaluation, since an ADR about pre-registration that pre-registers nothing
would be the joke telling itself.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01T39Nd5PnH6924Au1p3PLbe"
```

---

### Task 6: Exercise the primitive on ADR 166

**Files:**
- Create: `docs/watches/2026-08-21-adr-166-demoted.md` (resolves with a verdict)
- Create: `docs/watches/2026-08-21-adr-166-disagreement-rate.md` (resolves `void`)
- Create: `docs/watches/2026-08-21-adr-166-demoted-successor.md` (the live watch)
- Modify: `docs/decisions/166-session-liveness-by-enumeration.md` (dated amendment — the post-back)

**Interfaces:**
- Consumes: everything above. This task is the acceptance test for the whole increment.

Two watches over identical data resolving to **opposite** terminal states is the demonstration.
Rule C forces both post-backs into this same commit.

- [ ] **Step 1: Re-derive the numbers rather than copying them from the spec**

Run, and paste the real output into the watches:

```bash
python3 - <<'PY'
import json, datetime, collections
p = '/Users/nick/.musterd/research/adr-166-slot-sweep.jsonl'
dem = 0; samples = 0; byday = collections.defaultdict(int); ws = collections.Counter()
pop = collections.defaultdict(list)
for line in open(p):
    try: r = json.loads(line)
    except: continue
    samples += 1
    d = datetime.datetime.fromtimestamp(r['at']/1000, datetime.UTC).date().isoformat()
    pop[d].append(len(r.get('workspaces', [])))
    if r.get('demoted', 0):
        dem += r['demoted']; byday[d] += r['demoted']
        for w in r.get('workspaces', []):
            if w.get('demoted'): ws[w['workspace']] += 1
print('samples', samples, 'demoted', dem)
print('by day', dict(byday))
print('workspaces', ws.most_common())
print('population/sweep min', min(sum(v)/len(v) for v in pop.values()),
      'max', max(sum(v)/len(v) for v in pop.values()))
PY
```

Expected shape (confirm, do not assume): ~5,682 samples, 109 demoted, 6 days,
`agents-wanderer` ×75, population per sweep ranging from single digits to ~196.

- [ ] **Step 2: Write the count watch, resolved with a verdict**

Exact shape — fill the bracketed numbers from Step 1's real output, and do not carry over any figure
you have not just re-derived:

```markdown
---
question:   Has ADR 166's `demoted` count been non-zero since the increment-2 flip?
claim_ref:  docs/decisions/166-session-liveness-by-enumeration.md
falsifier:  "Any single demoted observation is a finding. ADR 166 eval item 3 pre-registers this at target ZERO."
population: every workspace the sweep judges on each run; the count is denominator-independent by construction
void_if:
  - the sweep's demote semantics change (scripts/research/adr-166-slot-sweep.ts line 110-111)
  - the series file is truncated or rotated within the window
series:     ~/.musterd/research/adr-166-slot-sweep.jsonl
cadence:    5m
opened:     2026-08-21
opened_by:  izzo
revisit_by: 2026-09-04
status:     resolved
resolution: "BREACHED. [N] demoted observations across [N] samples on [N] days ([workspace] x[N], ...). ADR 166 eval item 3 target is ZERO and calls any instance a finding requiring inspection; none was inspected. The escalation path fired — exitCode 1 per demote, [N] DEMOTED lines in sweep.log, DEMOTED(repeat) raising into `musterd report` and firing an OS push. Inspection obligation now sits on lane 01M0JNYJ4KHAM6FMEV5BZTQ7FW."
---

Opened and resolved in the same commit, retroactively, over a series that had already run 24.8 days
without one. That is not how a watch is meant to be used and it is the point: this watch exists to
show what the sweep would have produced had anyone stated the question up front.

Its `void_if` conditions PASS. A target-zero count does not depend on the denominator, so the
population instability that voids the sibling watch
(`2026-08-21-adr-166-disagreement-rate.md`) leaves this one readable. Same data, same days,
opposite outcome — decided by conditions written down before collection rather than after.
```

`docs/watches/2026-08-21-adr-166-demoted.md`, `status: resolved`, `claim_ref` pointing at ADR 166,
`falsifier` phrased as the target-zero count ADR 166 pre-registered, `void_if` naming the population
conditions — which **pass**, because a target-zero count does not depend on the denominator. The
`resolution` states the breach with the real numbers, and names lane `01M0JNYJ4K` as where the
inspection obligation now sits.

- [ ] **Step 3: Write the rate watch, resolved void**

`docs/watches/2026-08-21-adr-166-disagreement-rate.md`, `status: void`, same `claim_ref`, same
`series`, `void_if` including *"distinct sampled workspaces change by more than 25% within the
window"* — which **fails**. The `resolution` records `population unstable — workspaces per sweep
moved 23 → 196 → 9; no rate over this window is readable`, and publishes **no percentages**. The
prose body makes the contrast with the sibling watch explicit: same data, same days, opposite
outcome, decided by conditions written down before collection.

- [ ] **Step 4: Write the successor watch, open**

`docs/watches/2026-08-21-adr-166-demoted-successor.md`, `status: open`, target-zero count over a
stated stable population, a real `revisit_by`, and `opened_by` naming an accountable seat. This is
what hands lane `01M0JNYJ4K` an instrument. Do **not** set `opened_by: izzo` by reflex — if the lane
finds a wake-path owner first, name them, and if it has not, name izzo and say so in the body.

- [ ] **Step 5: Amend ADR 166 — the post-back Rule C requires**

Add a dated amendment section to `docs/decisions/166-session-liveness-by-enumeration.md` recording
that eval item 3 is **breached and uninspected** since 2026-08-03, with the numbers and a pointer to
both watches and lane `01M0JNYJ4K`.

**Do not mint a claims-ledger entry against stanley.** ADR 166 set a target and an inspection
obligation; an unmet obligation is not a falsified claim, and the ledger is for claims. Its
*"0 demoted"* line describes a specific case at the moment of flipping, not a standing prediction.
If inspection later shows the flip is harmful, ADR 166's decision has a falsified premise and
whoever establishes that mints it then.

- [ ] **Step 6: Verify Rule C actually fired during this task**

Before committing, confirm the gate would have caught a missing post-back:

```bash
git stash push -u -m "izzo-watch-rulec-probe" && git stash list --format='%H %gs' | head -1
```

Restore ADR 166 alone, run `pnpm watch:check`, and confirm it **fails** naming
`166-session-liveness-by-enumeration.md`. Then restore with `git stash apply <sha>` and drop the
entry by tag. (Never bare `git stash pop` — the stack is shared with other worktrees and sessions.)

Expected: the gate fails without the ADR 166 edit and passes with it. If it passes both ways,
Rule C is not wired into `main` and Task 4 Step 4 is incomplete.

- [ ] **Step 7: Run every gate**

Run: `pnpm watch:check && pnpm controls:check && pnpm format:check && pnpm vitest run scripts/`
Expected: all green, and `watch:check` now reports 3 watches.

- [ ] **Step 8: Commit**

```bash
git add docs/watches docs/decisions/166-session-liveness-by-enumeration.md
git commit -m "Exercise the watch on ADR 166: one resolves, one voids, same data

ADR 166 eval item 3 pre-registers demoted at target ZERO. It is 109, across
six days, agents-wanderer x75 — and the sweep was not silent about it:
exitCode 1, 214 DEMOTED lines, OS push on repeat. The escalation fired for
25 days into a channel with no owner.

The rate watch over the same series voids: workspaces per sweep moved
23 -> 196 -> 9, so no percentage there is readable. Two watches, identical
data, opposite outcomes, decided by conditions written down before
collection. That contrast is the argument.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01T39Nd5PnH6924Au1p3PLbe"
```

---

## Done when

- `pnpm format:check` runs `watch:check` and it is green.
- Three watches exist; one `resolved`, one `void`, one `open` with a named owner and a live date.
- ADR 297 is written and carries its own pre-registered Evaluation.
- ADR 166 carries the dated amendment, and lane `01M0JNYJ4K` has an instrument rather than 49 MB of
  ambiguity.
- Rule B has been verified **not** to fire on the 291 ADRs this branch did not touch.
