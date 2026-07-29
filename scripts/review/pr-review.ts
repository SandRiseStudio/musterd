/*
 * Single-pass PR review on a cheap model, for the slice of PRs that touch the parts of the system
 * tests don't cover: seat/lane ownership, presence, delivery, SQLite transaction boundaries.
 *
 *   pnpm review:pr [--base <ref>] [--dry-run]
 *
 * Replaces Cursor Bugbot (ADR 180). Deliberately modest:
 *
 *   - **Single pass.** One API call: the review rules plus the diff. No repo exploration, no tool
 *     loop. At a ~320-line median PR the exploration bought little and cost ~5× more.
 *   - **Cheap model.** `claude-haiku-4-5` at $1/$5 per Mtok. Override with `$REVIEW_MODEL`.
 *   - **Advisory.** Prints findings; the workflow posts them as a PR comment. It is NOT a required
 *     check — a reviewer that can hang on an API outage must never be able to wedge the merge queue,
 *     which is exactly how Bugbot's exhausted quota blocked every PR.
 *
 * Dependency-free on purpose: raw `fetch` against the Messages API, so adding the reviewer does not
 * itself trip the new-runtime-dependency ADR gate.
 *
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/** Paths worth a model's attention — the concurrency/state core. Everything else is CI's job. */
const REVIEWABLE = [/^packages\/protocol\/src\//, /^packages\/server\/src\//];

/** Keep one review bounded. A diff past this is truncated rather than silently costing 10×. */
const MAX_DIFF_CHARS = 120_000;

/**
 * Total budget for the full post-change bodies of the changed files (see below). ~200k chars is
 * ~50k tokens — about $0.05 on Haiku, an order of magnitude under what a required frontier reviewer
 * cost per PR. Files are included whole, largest-last, until the budget runs out.
 */
const MAX_BODY_CHARS = 200_000;

const MODEL = process.env.REVIEW_MODEL ?? 'claude-haiku-4-5';

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** File content at a ref, or null when the path does not exist there (deleted in this change). */
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
    process.env.REVIEW_BASE ??
    'origin/main';
  return git('merge-base', 'HEAD', requested).trim();
}

const base = resolveBase();

const changedFiles = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
const inScope = changedFiles.filter((f) => REVIEWABLE.some((re) => re.test(f)));

if (inScope.length === 0) {
  process.stdout.write(
    'No changes under packages/protocol/src or packages/server/src — skipping review.\n',
  );
  process.exit(0);
}

let diff = git('diff', `-U15`, `${base}...HEAD`, '--', ...inScope);
let truncated = false;
if (diff.length > MAX_DIFF_CHARS) {
  diff = diff.slice(0, MAX_DIFF_CHARS);
  truncated = true;
}

/**
 * The diff alone is not enough, and the first smoke test proved it: a `-U15` window around a new
 * `LaneState` cut off two lines into `LANE_CONTENDING_STATES`, so the model saw the set open but
 * never saw that the new state was missing from it — and reported no findings on a real bug.
 *
 * Most of what this reviewer is for is *omission* ("a new state that doesn't contend", "a field
 * parsed here but not there"), and an omission is invisible in a keyhole: you cannot see what isn't
 * in the hunk. So send each changed file's full post-change body alongside the diff. Smallest first,
 * so one large file can't starve the rest of the budget.
 */
const bodies: { path: string; text: string }[] = [];
let bodyBudget = MAX_BODY_CHARS;
const omittedBodies: string[] = [];
for (const path of [...inScope].sort(
  (a, b) => (fileAt('HEAD', a)?.length ?? 0) - (fileAt('HEAD', b)?.length ?? 0),
)) {
  const text = fileAt('HEAD', path);
  if (text === null) continue; // deleted in this change — the diff already shows the removal
  if (text.length > bodyBudget) {
    omittedBodies.push(path);
    continue;
  }
  bodyBudget -= text.length;
  bodies.push({ path, text });
}

const rules = readFileSync(join(repoRoot, '.github', 'REVIEW-RULES.md'), 'utf8');

const system = [
  'You are reviewing a pull request for musterd, a coordination layer for teams of AI agents and',
  'humans. Apply the review rules below exactly. They tell you what is already enforced by CI',
  '(never report those) and what only a reader can catch (spend your attention there).',
  '',
  'Report at most 5 findings, highest severity first. For each: the file and line, one sentence on',
  'what breaks, and a concrete failure scenario (specific inputs or interleaving that produce the',
  'wrong result). If you are not confident a finding is real, leave it out — a short accurate review',
  'is worth more than a long speculative one. If the diff is clean against the rules, reply with',
  'exactly: "No findings." and nothing else.',
  '',
  'Format findings as markdown bullets. Do not summarize the diff, do not praise it, do not restate',
  'these instructions.',
  '',
  '--- REVIEW RULES ---',
  rules,
].join('\n');

const userContent = [
  truncated
    ? `NOTE: this diff was truncated at ${MAX_DIFF_CHARS} characters. Review what is present; do not speculate about the rest.`
    : null,
  omittedBodies.length > 0
    ? `NOTE: too large to include in full, so you have only their diff hunks: ${omittedBodies.join(', ')}.`
    : null,
  `Files under review (${inScope.length}):`,
  ...inScope.map((f) => `  ${f}`),
  '',
  'What changed — unified diff:',
  '```diff',
  diff,
  '```',
  '',
  'Full contents of each changed file AFTER the change. Read these, not just the diff: most bugs',
  'worth reporting here are omissions — a value added in one place and not the matching place —',
  'and an omission is invisible in a diff hunk. Check that every change is reflected everywhere it',
  'has to be.',
  ...bodies.flatMap(({ path, text }) => ['', `--- ${path} ---`, '```ts', text, '```']),
]
  .filter((l) => l !== null)
  .join('\n');

if (process.argv.includes('--dry-run')) {
  const bodyChars = bodies.reduce((n, b) => n + b.text.length, 0);
  process.stdout.write(
    `[dry run] model=${MODEL} files=${inScope.length} diff=${diff.length} chars` +
      `${truncated ? ' (truncated)' : ''}\n` +
      `[dry run] full bodies: ${bodies.length}/${inScope.length} file(s), ${bodyChars} chars` +
      `${omittedBodies.length > 0 ? ` (omitted: ${omittedBodies.join(', ')})` : ''}\n` +
      `[dry run] system ${system.length} + user ${userContent.length} chars` +
      ` ≈ ${Math.round((system.length + userContent.length) / 4)} tokens; no API call made.\n`,
  );
  process.exit(0);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  process.stderr.write('✗ ANTHROPIC_API_KEY is not set — cannot run the review.\n');
  process.exit(1);
}

const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: userContent }],
  }),
});

if (!response.ok) {
  const body = await response.text();
  process.stderr.write(`✗ Messages API returned ${response.status}: ${body.slice(0, 500)}\n`);
  process.exit(1);
}

const result = (await response.json()) as {
  content: { type: string; text?: string }[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
};

// A refusal or a non-text stop leaves nothing useful to post — say so rather than emitting a blank
// review that reads as "looks good to me".
if (result.stop_reason === 'refusal') {
  process.stderr.write('✗ the model declined to review this diff.\n');
  process.exit(1);
}

const text = result.content
  .filter((b) => b.type === 'text' && b.text)
  .map((b) => b.text)
  .join('\n')
  .trim();

const { input_tokens: inTok, output_tokens: outTok } = result.usage;
// Haiku 4.5 list price, for the run log only — so the cost of this gate stays visible in CI.
const cost = (inTok / 1_000_000) * 1 + (outTok / 1_000_000) * 5;
process.stderr.write(
  `review: ${MODEL}, ${inScope.length} file(s), ${inTok} in / ${outTok} out ≈ $${cost.toFixed(4)}\n`,
);

if (!text || /^no findings\.?$/i.test(text)) {
  process.stdout.write('');
  process.exit(0);
}

process.stdout.write(text + '\n');
