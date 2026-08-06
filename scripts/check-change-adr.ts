/*
 * Check that changes the docs call ADR-gated actually carry an ADR — and that accepted ADRs are not
 * rewritten in place.
 *
 *   pnpm change-adr:check [--base <ref>]   — fail (exit 1) on an ADR-gated change with no ADR
 *
 * Three rules, all from AGENTS.md "Hard rules" / 07-conventions.md:
 *
 *   1. **Protocol schemas** (hard rule 1) — a change under `packages/protocol/src/` needs an ADR in
 *      the same change. Other implementations depend on the wire contract; changing it silently is
 *      how a protocol forks.
 *   2. **New runtime dependency** (hard rule 6) — a new key in any package's `dependencies` needs an
 *      ADR noting why and the alternative considered. `devDependencies` are not gated.
 *   3. **ADR immutability** (07-conventions) — an accepted ADR's `## Decision` is a historical
 *      record. Supersede it with a new ADR; never edit the decision itself. (Every other section —
 *      Context, Consequences, Observability — stays editable, so typo fixes and follow-up notes are
 *      fine.)
 *
 * Unlike the tree-based gates (`vocab:check`, `arch-trees:check`, …) this one reads a **diff**, so it
 * needs a base ref: `--base <ref>`, else `$CHANGE_ADR_BASE`, else `origin/main`. It compares against
 * the merge-base, so it judges what the branch changed — not what main moved on to.
 *
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAcceptedAdr } from './adr-status.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** File content at a ref, or null when the path does not exist there (added/deleted). */
function fileAt(ref: string, path: string): string | null {
  try {
    return git('show', `${ref}:${path}`);
  } catch {
    return null;
  }
}

function resolveBase(): string {
  const flagIdx = process.argv.indexOf('--base');
  const requested =
    (flagIdx !== -1 ? process.argv[flagIdx + 1] : undefined) ??
    process.env.CHANGE_ADR_BASE ??
    'origin/main';
  try {
    // The merge-base is the honest comparison point: it ignores commits main gained after we branched.
    return git('merge-base', 'HEAD', requested).trim();
  } catch {
    process.stderr.write(
      `✗ cannot resolve base ref \`${requested}\` — fetch it first (CI uses fetch-depth: 0), ` +
        `or pass --base <ref>.\n`,
    );
    process.exit(1);
  }
}

const base = resolveBase();
const changed = git('diff', '--name-status', `${base}...HEAD`)
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status: status ?? '', path: rest[rest.length - 1] ?? '' };
  })
  .filter((c) => c.path);

if (changed.length === 0) {
  process.stdout.write('No changes against the base ref — nothing to gate.\n');
  process.exit(0);
}

/** An ADR added or modified in this change satisfies rules 1 and 2. */
const adrsInChange = changed
  .filter((c) => /^docs\/decisions\/\d{3}-.*\.md$/.test(c.path) && c.status !== 'D')
  .map((c) => c.path);
const hasAdr = adrsInChange.length > 0;

let failed = false;

// ─── Rule 1: protocol schema changes need an ADR ───────────────────────────────────────────────
const protocolChanges = changed
  .filter((c) => c.path.startsWith('packages/protocol/src/') && c.path.endsWith('.ts'))
  .filter((c) => !c.path.endsWith('.test.ts'))
  .map((c) => c.path);

if (protocolChanges.length > 0 && !hasAdr) {
  failed = true;
  process.stderr.write(
    `✗ this change edits the protocol contract but adds no ADR:\n` +
      protocolChanges.map((p) => `    ${p}\n`).join('') +
      `  Other implementations depend on these schemas (AGENTS.md hard rule 1). Add\n` +
      `  docs/decisions/NNN-<slug>.md recording the change, or move the edit out of\n` +
      `  packages/protocol/src/ if it is not contract-facing.\n\n`,
  );
}

// ─── Rule 2: new runtime dependencies need an ADR ──────────────────────────────────────────────
function runtimeDeps(ref: string, path: string): Set<string> {
  const raw = fileAt(ref, path);
  if (raw === null) return new Set();
  try {
    const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> };
    return new Set(Object.keys(parsed.dependencies ?? {}));
  } catch {
    return new Set(); // an unparseable package.json is not this gate's failure to report
  }
}

const addedDeps: { path: string; dep: string }[] = [];
for (const { path, status } of changed) {
  if (!path.endsWith('package.json') || status === 'D') continue;
  if (path.includes('node_modules/')) continue;
  const before = runtimeDeps(base, path);
  for (const dep of runtimeDeps('HEAD', path)) {
    if (!before.has(dep)) addedDeps.push({ path, dep });
  }
}

if (addedDeps.length > 0 && !hasAdr) {
  failed = true;
  process.stderr.write(
    `✗ this change adds a runtime dependency but no ADR:\n` +
      addedDeps.map(({ path, dep }) => `    ${dep}  (${path})\n`).join('') +
      `  A new runtime dep needs an ADR noting why and the alternative considered\n` +
      `  (AGENTS.md hard rule 6). devDependencies are not gated — if this is tooling,\n` +
      `  move it there.\n\n`,
  );
}

// ─── Rule 3: an accepted ADR's Decision is immutable ───────────────────────────────────────────
/** The body of the `## Decision` section, or null when the ADR has no such heading. */
function decisionSection(text: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Decision\s*$/i.test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

// The status parser lives in `adr-status.ts` — its own module so a test can import it without
// running this script. Only the DETECTOR was widened there; what counts as frozen is unchanged:
// `## Decision` and nothing else.

/**
 * Is this Decision text one this file has held before on `main`? Then the edit is a RESTORATION,
 * not a rewrite, and it passes.
 *
 * WHY THIS EXISTS. #739 turned rule 3 on for 94 ADRs that had been unprotected for months, so
 * `main` already contains Decision edits that slipped through. Removing one is itself a Decision
 * edit — the gate diffs against the merge-base, and the merge-base now HAS the violating text. So
 * the fix froze the violations it revealed: the 94 became protected and simultaneously unfixable.
 * Raised as a challenge by dolly with a live reproduction (PR #737, the exact remedy this gate's own
 * message prescribes, failing this gate), and upheld.
 *
 * The trigger is the prescribed workflow, which is what makes it certain rather than occasional: her
 * branch PASSED while its merge-base predated the bad edit, and rebasing onto main — ADR 106 says
 * rebase, never merge — moved the base past it and armed the gate.
 *
 * A revert is not a rewrite. Mechanical, no flag, no human judgement, and a genuine edit still fails
 * by construction because new text has never existed before.
 *
 * REJECTED ALTERNATIVES, both for reasons worth keeping:
 *   - "compare against the ADR's last ACCEPTED form" (dolly's own first preference) converts this
 *     from a diff check into a TREE check, so it would fire on every PR touching one of those 94
 *     ADRs — including PRs that only edit Consequences — accusing whoever shows up next of drift
 *     they did not cause. With ~40% of the corpus carrying unknown drift, week one is near-all false
 *     positives: exactly the warn-rail-with-a-bad-rate failure ADR 239's verdict retired.
 *   - an env override / opt-out flag: an escape that only says "trust me" gets used for the case it
 *     was not meant for. Same shape as the ADR 239 override.
 *
 * THE RESIDUAL, stated rather than discovered: this also permits restoring to a state that was
 * ITSELF the product of a violation, because nothing here can tell an original Decision from a
 * well-aged bad one. Accepted deliberately — every prior state is one the ADR actually had, and the
 * alternative is the tree check above.
 */
function wasEverOnMain(path: string, decision: string): boolean {
  // Bounded by construction: only ADRs actually changed in this diff reach here (typically one),
  // and `--follow` keeps the walk to that file's own history rather than the corpus.
  let revs: string[];
  try {
    // FROM THE BASE, NEVER FROM HEAD. `git log` defaults to HEAD, which on a PR branch INCLUDES the
    // PR's own commits — so the new text this change introduces would trivially count as "previously
    // held" and rule 3 would pass everything. Measured while building this: with the default ref,
    // replaying #733 (a genuine Decision rewrite) exited 0. The escape silently disabled the gate it
    // was patching, which is the exact defect class this gate exists to catch.
    revs = git('log', '--format=%H', '--follow', base, '--', path).split('\n').filter(Boolean);
  } catch {
    return false; // no history to appeal to — treat as a rewrite
  }
  for (const rev of revs) {
    const text = fileAt(rev, path);
    if (text === null) continue;
    if (decisionSection(text) === decision) return true;
  }
  return false;
}

for (const { path, status } of changed) {
  if (status !== 'M') continue; // only in-place edits; a new ADR is the sanctioned path
  if (!/^docs\/decisions\/\d{3}-.*\.md$/.test(path)) continue;

  const before = fileAt(base, path);
  const after = fileAt('HEAD', path);
  if (before === null || after === null) continue;
  if (!isAcceptedAdr(before)) continue; // a proposed ADR is still being drafted — editable

  const wasDecision = decisionSection(before);
  const nowDecision = decisionSection(after);
  if (wasDecision === null || wasDecision === nowDecision) continue;
  // A restoration passes: this exact Decision text is one the file has held before (see
  // `wasEverOnMain`). Undoing an edit that slipped through the blind years must not be blocked by
  // the gate that just started watching.
  if (nowDecision !== null && wasEverOnMain(path, nowDecision)) {
    process.stdout.write(
      `• ${path} — \`## Decision\` restored to a form this file previously held; allowed.\n`,
    );
    continue;
  }

  failed = true;
  process.stderr.write(
    `✗ ${path} — the \`## Decision\` of an accepted ADR was edited.\n` +
      `  Accepted decisions are immutable: they are the dated record of what was decided and why.\n` +
      `  USUALLY WHAT YOU WANT: move the new text into \`## Consequences\` as a dated note. That is\n` +
      `  the amendment mechanism 07-conventions prescribes — Context / Consequences / Observability\n` +
      `  are all editable, and only Decision is frozen. A paragraph move, not a new document.\n` +
      `  Write a superseding ADR only when the DECISION ITSELF is being reversed.\n\n`,
  );
}

if (failed) {
  process.exit(1);
}

const checked = [
  protocolChanges.length > 0 ? `${protocolChanges.length} protocol file(s)` : null,
  addedDeps.length > 0 ? `${addedDeps.length} new dep(s)` : null,
].filter(Boolean);
process.stdout.write(
  checked.length > 0
    ? `ADR-gated changes (${checked.join(', ')}) are covered by ${adrsInChange.join(', ')}.\n`
    : `No ADR-gated changes in this diff (${changed.length} file(s) against ${base.slice(0, 8)}).\n`,
);
