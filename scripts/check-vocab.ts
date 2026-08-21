/*
 * Check that new docs use the canonical vocabulary (ADR 098 + ADR 296).
 *
 *   pnpm vocab:check   — fail (exit 1) on any banned word in a gated file
 *
 * Two tables, one gate (ADR 296 §2: do not build a second checker):
 *
 *   1. ADR 098 work-item nouns (epic / milestone / sprint / story points) — ADRs ≥ 098,
 *      plans ≥ 2026-07-06, new design docs. Unchanged.
 *   2. ADR 296 terminology Not-column (profile / kit / template / worktree) — ADRs ≥ 299
 *      (296 is the decision; 296–298 landed before this enforcement PR, the same split as
 *      obs-evals' ADR 052 vs GATE_FROM 60), plus new user-facing files (CLI help/render,
 *      web copy, README/ROADMAP/AGENTS.md). Existing user-facing files are a frozen
 *      baseline: the tier-1 burn-down, not a silent exemption.
 *
 * Mention vs. use: backticks, double-quoted spans, --flags, and fenced code are mentions.
 * Deliberate prose use is suppressed line-level with `<!-- vocab:ok -->`.
 *
 * Runs on Node's native TypeScript (no build step, no deps).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLOSSARY, terminologyBans } from '../docs/glossary/terms.ts';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..');

/** First ADR number the work-item table enforces (ADR 098 self-hosts). */
export const GATE_FROM = 98;
/**
 * First ADR number the terminology table enforces. 296 is the decision; 296–298 shipped
 * before this gate existed (spec PR then enforcement PR).
 */
export const TERMINOLOGY_GATE_FROM = 299;
export const PLANS_GATE_FROM = '2026-07-06';
export const GRANDFATHERED_PLANS: string[] = [];
export const DESIGN_BASELINE = new Set([
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

const WORK_ITEM_BANNED: { re: RegExp; word: string }[] = [
  { re: /\bepics?\b/i, word: 'epic' },
  { re: /\bmilestones?\b/i, word: 'milestone' },
  { re: /\bsprints?\b/i, word: 'sprint' },
  { re: /\bstory\s+points?\b/i, word: 'story points' },
];

const TERMINOLOGY_BANNED = terminologyBans();

const SUPPRESS = '<!-- vocab:ok -->';

const USER_FACING_ROOTS = ['README.md', 'ROADMAP.md', 'AGENTS.md', 'PRODUCT.md', 'PRIVACY.md'];

/** Frozen at gate landing — the tier-1 burn-down. New files under the same globs are gated. */
export const USER_FACING_BASELINE = new Set([
  'AGENTS.md',
  'PRIVACY.md',
  'PRODUCT.md',
  'README.md',
  'ROADMAP.md',
  'packages/cli/src/help/catalog.ts',
  'packages/cli/src/help/plain.ts',
  'packages/cli/src/render/credentials.ts',
  'packages/cli/src/render/help.ts',
  'packages/cli/src/render/rows.ts',
  'packages/cli/src/render/theme.ts',
  'packages/cli/src/render/title.ts',
  'packages/cli/src/render/ui.ts',
  'packages/web/src/brand/MusterdWord.tsx',
  'packages/web/src/brand/siteMeta.ts',
  'packages/web/src/components/Footer.tsx',
  'packages/web/src/components/GetStarted.tsx',
  'packages/web/src/components/Hero/Hero.tsx',
  'packages/web/src/components/LiquidGlass/LiquidGlass.tsx',
  'packages/web/src/content/site.ts',
  'packages/web/src/live/ApprovalCard.tsx',
  'packages/web/src/live/ApprovalQueue.tsx',
  'packages/web/src/live/AsksReel.tsx',
  'packages/web/src/live/AsksStrip.tsx',
  'packages/web/src/live/AuditLog.tsx',
  'packages/web/src/live/Board.tsx',
  'packages/web/src/live/BoardOverlay.tsx',
  'packages/web/src/live/Clock.tsx',
  'packages/web/src/live/GoalGridView.tsx',
  'packages/web/src/live/InsightRail.tsx',
  'packages/web/src/live/MemberSignIn.tsx',
  'packages/web/src/live/OfficeOverlay.tsx',
  'packages/web/src/live/OfficeScene.tsx',
  'packages/web/src/live/PanelChrome.tsx',
  'packages/web/src/live/ReceptionScene.tsx',
  'packages/web/src/live/RecordShelf.tsx',
  'packages/web/src/live/RosterPanel.tsx',
  'packages/web/src/live/Stream.tsx',
  'packages/web/src/live/WorkStack.tsx',
  'packages/web/src/router.tsx',
  'packages/web/src/routes/__root.tsx',
  'packages/web/src/routes/approvals.tsx',
  'packages/web/src/routes/audit.tsx',
  'packages/web/src/routes/board.tsx',
  'packages/web/src/routes/broadcast.tsx',
  'packages/web/src/routes/character-sheet.tsx',
  'packages/web/src/routes/index.tsx',
  'packages/web/src/routes/live.tsx',
  'packages/web/src/routes/office-preview.tsx',
]);

export interface VocabCheckOptions {
  /** Override the frozen user-facing baseline (tests). */
  userFacingBaseline?: string[];
}

export interface VocabCheckResult {
  ok: boolean;
  errors: string[];
  checked: number;
}

function listDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

type Table = 'work-item' | 'terminology';

interface GatedFile {
  abs: string;
  rel: string;
  tables: Table[];
}

function gatedFiles(root: string, baseline: Set<string>): GatedFile[] {
  const out: GatedFile[] = [];

  const adrDir = join(root, 'docs', 'decisions');
  for (const entry of listDir(adrDir)) {
    const m = /^(\d{3})-.*\.md$/.exec(entry);
    if (!m) continue;
    const n = Number(m[1]);
    const tables: Table[] = [];
    if (n >= GATE_FROM) tables.push('work-item');
    if (n >= TERMINOLOGY_GATE_FROM) tables.push('terminology');
    if (tables.length)
      out.push({ abs: join(adrDir, entry), rel: `docs/decisions/${entry}`, tables });
  }

  const plansDir = join(root, 'docs', 'superpowers', 'plans');
  for (const entry of listDir(plansDir)) {
    const m = /^(\d{4}-\d{2}-\d{2})-.*\.md$/.exec(entry);
    if (!m?.[1]) continue;
    if (m[1] >= PLANS_GATE_FROM && !GRANDFATHERED_PLANS.includes(entry))
      out.push({
        abs: join(plansDir, entry),
        rel: `docs/superpowers/plans/${entry}`,
        tables: ['work-item'],
      });
  }

  const designDir = join(root, 'docs', 'design');
  for (const entry of listDir(designDir)) {
    if (entry.endsWith('.md') && !DESIGN_BASELINE.has(entry))
      out.push({
        abs: join(designDir, entry),
        rel: `docs/design/${entry}`,
        tables: ['work-item'],
      });
  }

  const userFacingDirs = [
    join(root, 'packages/cli/src/help'),
    join(root, 'packages/cli/src/render'),
    join(root, 'packages/web/src'),
  ];
  const userFacing: string[] = [];
  for (const name of USER_FACING_ROOTS) {
    const abs = join(root, name);
    if (existsSync(abs)) userFacing.push(abs);
  }
  for (const dir of userFacingDirs) {
    for (const abs of walkFiles(dir)) {
      if (/\.(ts|tsx)$/.test(abs) && !/\.test\.ts$/.test(abs) && !abs.endsWith('routeTree.gen.ts'))
        userFacing.push(abs);
    }
  }
  for (const abs of userFacing) {
    const rel = relative(root, abs).replaceAll('\\', '/');
    if (baseline.has(rel)) continue;
    // Root markdown and help/render are always terminology-gated when new.
    // Web: only tsx + the two copy modules, matching the baseline's shape.
    const isCopy =
      USER_FACING_ROOTS.includes(rel) ||
      rel.startsWith('packages/cli/src/help/') ||
      rel.startsWith('packages/cli/src/render/') ||
      rel.startsWith('packages/web/src/');
    if (!isCopy) continue;
    if (
      rel.startsWith('packages/web/src/') &&
      !/\.tsx$/.test(rel) &&
      !/\/(site|siteMeta)\.ts$/.test(rel)
    )
      continue;
    out.push({ abs, rel, tables: ['terminology'] });
  }

  return out;
}

/**
 * Mask mentions so only prose *use* is matched: blank out fenced code blocks (line count
 * preserved), inline code spans, double-quoted spans, and --flags; drop suppress lines.
 */
export function maskedLines(text: string, kind: 'md' | 'code' = 'md'): string[] {
  let inFence = false;
  return text.split('\n').map((line) => {
    if (kind === 'md' && /^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return '';
    }
    if (inFence) return '';
    if (line.includes(SUPPRESS)) return '';
    if (kind === 'code') return line;
    return line
      .replace(/`[^`]*`/g, (s) => ' '.repeat(s.length))
      .replace(/"[^"]*"/g, (s) => ' '.repeat(s.length))
      .replace(/--[a-z][\w-]*/gi, (s) => ' '.repeat(s.length));
  });
}

function scanFile(
  file: GatedFile,
  tables: { name: Table; bans: { re: RegExp; word: string }[]; label: string }[],
): string[] {
  const errors: string[] = [];
  const kind = /\.(ts|tsx)$/.test(file.rel) ? 'code' : 'md';
  const lines = maskedLines(readFileSync(file.abs, 'utf8'), kind);
  lines.forEach((line, i) => {
    for (const table of tables) {
      if (!file.tables.includes(table.name)) continue;
      for (const { re, word } of table.bans) {
        if (re.test(line)) {
          errors.push(`✗ ${file.rel}:${i + 1} — "${word}" is a banned ${table.label}`);
        }
      }
    }
  });
  return errors;
}

function glossaryDrift(root: string): string[] {
  const brand = join(root, 'docs/design/brand.md');
  if (!existsSync(brand)) return [];
  const text = readFileSync(brand, 'utf8');
  const section = text.split(/^## 5\. /m)[1]?.split(/^## /m)[0];
  if (!section) return ['✗ docs/design/brand.md — missing §5 glossary (ADR 296)'];
  const errors: string[] = [];
  for (const t of GLOSSARY.filter((g) => g.status === 'canonical')) {
    const needle = `**${t.term[0]!.toUpperCase()}${t.term.slice(1)}**`;
    if (!section.toLowerCase().includes(needle.toLowerCase())) {
      errors.push(
        `✗ docs/design/brand.md §5 — canonical term "${t.term}" is missing (source: docs/glossary/terms.ts)`,
      );
    }
  }
  return errors;
}

export function checkVocab(root: string, opts: VocabCheckOptions = {}): VocabCheckResult {
  const baseline = new Set(opts.userFacingBaseline ?? USER_FACING_BASELINE);
  const files = gatedFiles(root, baseline);
  const tables = [
    { name: 'work-item' as const, bans: WORK_ITEM_BANNED, label: 'structural noun (ADR 098)' },
    {
      name: 'terminology' as const,
      bans: TERMINOLOGY_BANNED,
      label: 'terminology synonym (ADR 296)',
    },
  ];
  const errors: string[] = [];
  for (const file of files) errors.push(...scanFile(file, tables));
  errors.push(...glossaryDrift(root));
  return { ok: errors.length === 0, errors, checked: files.length };
}

/* c8 ignore start — entrypoint; the logic above is what the tests drive. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = checkVocab(REPO_ROOT);
  for (const e of r.errors) process.stderr.write(`${e}\n`);
  if (!r.ok) {
    process.stderr.write(
      `\nCanonical vocabulary: ADR 098 (Goal/Lane; no epic/milestone/sprint) and ADR 296 ` +
        `(toolkit not profile/kit/template; workspace not worktree). ` +
        `Mentioning (not using) a banned word? backtick it, quote it, or append ${SUPPRESS} to the line.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `All ${r.checked} gated file(s) use the canonical vocabulary ` +
      `(work-item ADRs < ${String(GATE_FROM).padStart(3, '0')}, terminology ADRs < ${String(TERMINOLOGY_GATE_FROM).padStart(3, '0')}, ` +
      `plans < ${PLANS_GATE_FROM}, ${DESIGN_BASELINE.size} baseline design docs and ` +
      `${USER_FACING_BASELINE.size} user-facing files grandfathered).\n`,
  );
}
/* c8 ignore stop */
