/*
 * Check that new docs use the canonical work-item vocabulary (ADR 096).
 *
 *   pnpm vocab:check   — fail (exit 1) on any banned structural noun in a gated doc
 *
 * The ontology is deliberately small — Goal / Lane are the entities, `wave` a field, Phase /
 * "increment N" / "Task N" the sanctioned prose units. Banned structural nouns (epic, milestone,
 * sprint, story points) quietly re-import structure the data model rejected (ADR 048/084: "we keep
 * the words, not the tree" — this gate keeps even the words honest). feature/task-as-tiers are
 * banned by ruling but NOT linted (ordinary-English false positives; "Task N" is sanctioned in
 * plan docs).
 *
 * Mention vs. use: a banned word in backticks or a fenced code block is a mention — always legal
 * (that is how ADR 096 and the conventions table name the words). A deliberate prose use is
 * suppressed line-level with `<!-- vocab:ok -->`.
 *
 * Grandfathering (pragmatic, per the obs-evals GATE_FROM pattern): existing docs are history and
 * never retrofitted —
 *   - docs/decisions/   : ADRs numbered below GATE_FROM are skipped
 *   - docs/superpowers/plans/ : plans date-prefixed before PLANS_GATE_FROM are skipped
 *   - docs/design/      : files on the frozen DESIGN_BASELINE list are skipped (no date convention
 *                         exists there; renaming a listed doc makes it "new" — update the list)
 * Everything else (docs/architecture, AGENTS.md, README, ROADMAP, code) is out of scope.
 *
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/** First ADR number the gate enforces (ADR 096 self-hosts). Below this is pre-gate history. */
const GATE_FROM = 96;
/** First plan-doc date the gate enforces (ISO date-prefix string compare). */
const PLANS_GATE_FROM = '2026-07-06';
/** Plan docs at the gate date that predate the gate itself. */
const GRANDFATHERED_PLANS: string[] = [];
/** docs/design/ files existing when the gate landed — frozen, never grows. */
const DESIGN_BASELINE = new Set([
  'agent-ontology.md',
  'agent-primer.md',
  'brainstorm-arc-reachability-to-ontology.md',
  'brand-coordination-observability.md',
  'brand.md',
  'deployment-topology.md',
  'figma-brief-brand.md',
  'figma-brief-dashboard.md',
  'figma-brief-terminal.md',
  'human-agent-dynamics.md',
  'interrupt-line-mid-loop-reachability.md',
  'landscape.md',
  'lane-phase1-mvp-spec.md',
  'lanes-and-the-multi-agent-tax.md',
  'membership-model.md',
  'migration-bootstrap.md',
  'model-experimentation.md',
  'observability.md',
  'office-rive-character-spec.md',
  'planning-and-insights-brainstorm.md',
  'projection-reconcile.md',
  'provisioning-recipe.md',
  'research-foundation.md',
  'research-radar-plan.md',
  'seat-file-format.md',
  'seat-lifecycle-as-files.md',
  'security.md',
  'spec-v0.3-draft.md',
]);

/** Banned structural nouns (ADR 096 §1). Applied per masked line. */
const BANNED: { re: RegExp; word: string }[] = [
  { re: /\bepics?\b/i, word: 'epic' },
  { re: /\bmilestones?\b/i, word: 'milestone' },
  { re: /\bsprints?\b/i, word: 'sprint' },
  { re: /\bstory\s+points?\b/i, word: 'story points' },
];

const SUPPRESS = '<!-- vocab:ok -->';

/** The gated doc set: absolute path + repo-relative label. */
function gatedDocs(): string[] {
  const out: string[] = [];

  const adrDir = join(repoRoot, 'docs', 'decisions');
  for (const entry of readdirSync(adrDir)) {
    const m = /^(\d{3})-.*\.md$/.exec(entry);
    if (m && Number(m[1]) >= GATE_FROM) out.push(join(adrDir, entry));
  }

  const plansDir = join(repoRoot, 'docs', 'superpowers', 'plans');
  for (const entry of readdirSync(plansDir)) {
    const m = /^(\d{4}-\d{2}-\d{2})-.*\.md$/.exec(entry);
    if (!m) continue;
    if (m[1] >= PLANS_GATE_FROM && !GRANDFATHERED_PLANS.includes(entry))
      out.push(join(plansDir, entry));
  }

  const designDir = join(repoRoot, 'docs', 'design');
  for (const entry of readdirSync(designDir)) {
    if (entry.endsWith('.md') && !DESIGN_BASELINE.has(entry)) out.push(join(designDir, entry));
  }

  return out.sort();
}

/**
 * Mask mentions so only prose *use* is matched: blank out fenced code blocks (line count
 * preserved) and inline code spans; drop lines carrying the suppression comment.
 */
function maskedLines(text: string): string[] {
  let inFence = false;
  return text.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return '';
    }
    if (inFence) return '';
    if (line.includes(SUPPRESS)) return '';
    return line.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length));
  });
}

let failed = false;
let checked = 0;
for (const file of gatedDocs()) {
  const rel = relative(repoRoot, file);
  checked++;
  const lines = maskedLines(readFileSync(file, 'utf8'));
  let clean = true;
  lines.forEach((line, i) => {
    for (const { re, word } of BANNED) {
      if (re.test(line)) {
        failed = true;
        clean = false;
        process.stderr.write(
          `✗ ${rel}:${i + 1} — "${word}" is a banned structural noun (ADR 096)\n`,
        );
      }
    }
  });
  if (clean) process.stdout.write(`✓ ${rel} — vocabulary clean\n`);
}

if (failed) {
  process.stderr.write(
    `\nNew docs use the canonical work-item vocabulary (ADR 096): Goal / Lane are the entities, ` +
      `"work item" the generic, Phase/P-N the release arc, "increment N" the per-ADR cut. ` +
      `epic/milestone/sprint/story-points name structure musterd doesn't have. ` +
      `Mentioning (not using) a banned word? backtick it or append ${SUPPRESS} to the line.\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `All ${checked} gated doc(s) use the canonical vocabulary (ADRs < ${String(GATE_FROM).padStart(3, '0')}, ` +
    `plans < ${PLANS_GATE_FROM}, and ${DESIGN_BASELINE.size} baseline design docs grandfathered).\n`,
);
