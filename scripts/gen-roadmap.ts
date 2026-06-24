/*
 * Generate the item region of ROADMAP.md from the single source of truth,
 * packages/web/src/content/roadmap.data.ts (the same module the web map imports).
 *
 *   pnpm roadmap:gen     — rewrite ROADMAP.md's generated region in place
 *   pnpm roadmap:check   — fail (exit 1) if ROADMAP.md is out of date
 *
 * The intro and footer of ROADMAP.md are hand-authored and live OUTSIDE the
 * <!-- BEGIN/END GENERATED ROADMAP --> markers; only the region between them is
 * produced here. Runs on Node's native TypeScript (no build step, no deps).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORY_META,
  CATEGORY_ORDER,
  ROADMAP,
  STATUS_META,
  STATUS_ORDER,
  WEDGE,
  type Ref,
  type RoadmapItem,
  type Status,
} from '../packages/web/src/content/roadmap.data.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROADMAP_PATH = join(here, '..', 'ROADMAP.md');
const BEGIN = '<!-- BEGIN GENERATED ROADMAP';
const END = '<!-- END GENERATED ROADMAP -->';

const STATUS_HEADING: Record<Status, string> = {
  shipped: 'Shipped',
  'near-term': 'Near-term',
  reserved: 'Reserved (in v0.1, built later)',
  'out-of-scope': 'Out of scope (by principle, not timing)',
};

const titleById = new Map(ROADMAP.map((i) => [i.id, i.title]));

function renderRefs(refs: Ref[] | undefined): string {
  if (!refs || refs.length === 0) return '';
  return ` (${refs.map((r) => `[${r.label}](${r.href})`).join(', ')})`;
}

function renderItem(item: RoadmapItem): string {
  const category = CATEGORY_META[item.category].label;
  const detail = item.detail ? ` ${item.detail}` : '';
  const builds =
    item.dependsOn && item.dependsOn.length > 0
      ? ` _Builds on ${item.dependsOn.map((id) => titleById.get(id) ?? id).join(', ')}._`
      : '';
  return `- **${item.title}** · ${category} — ${item.blurb}${detail}${builds}${renderRefs(item.refs)}`;
}

function renderStatus(status: Status): string | null {
  const items = ROADMAP.filter((i) => i.status === status).sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );
  if (items.length === 0) return null;
  return [
    `## ${STATUS_HEADING[status]}`,
    '',
    `_${STATUS_META[status].tone}_`,
    '',
    ...items.map(renderItem),
  ].join('\n');
}

function renderWedge(): string {
  return [`## ${WEDGE.heading}`, '', WEDGE.body, '', `See: ${WEDGE.refs.map((r) => `[${r.label}](${r.href})`).join(', ')}.`].join(
    '\n',
  );
}

function generatedRegion(): string {
  const sections = STATUS_ORDER.map(renderStatus).filter((s): s is string => s !== null);
  sections.push(renderWedge());
  return sections.join('\n\n');
}

function build(src: string): string {
  const beginIdx = src.indexOf(BEGIN);
  const endIdx = src.indexOf(END);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error(
      `ROADMAP.md is missing the generated-region markers (${BEGIN} ... ${END}). ` +
        'Add them around the item region, then re-run.',
    );
  }
  const afterBeginLine = src.indexOf('\n', beginIdx);
  const head = src.slice(0, afterBeginLine + 1);
  const tail = src.slice(endIdx);
  return `${head}\n${generatedRegion()}\n\n${tail}`;
}

const check = process.argv.includes('--check');
const current = readFileSync(ROADMAP_PATH, 'utf8');
const next = build(current);

if (check) {
  if (current !== next) {
    process.stderr.write('ROADMAP.md is out of date with roadmap.data.ts — run `pnpm roadmap:gen`.\n');
    process.exit(1);
  }
  process.stdout.write('ROADMAP.md is in sync with roadmap.data.ts.\n');
} else if (current !== next) {
  writeFileSync(ROADMAP_PATH, next, 'utf8');
  process.stdout.write('ROADMAP.md regenerated from roadmap.data.ts.\n');
} else {
  process.stdout.write('ROADMAP.md already up to date.\n');
}
