/**
 * The pretty, colorized help — the warm, scannable replacement for a flat command dump. Three views,
 * one catalog (help/catalog.ts): the grouped overview, per-command detail, and a JSON dump for agents.
 *
 * The overview reads like a floor plan: a short "start here", then commands grouped into labelled
 * rooms, with depth (flags, examples) one `musterd help <command>` away. That is what fixes the
 * "35-command wall" — the top view stays scannable; you descend only when you need to.
 */
import {
  ACTS,
  CATALOG,
  type CommandEntry,
  GLOBAL_FLAGS,
  GROUPS,
  START_HERE,
} from '../help/catalog.js';
import { renderBanner } from './rows.js';
import { theme } from './theme.js';
import { defList, dim, heading, rule, sym, termWidth, wrapText } from './ui.js';

function entry(name: string): CommandEntry | undefined {
  return CATALOG.find((c) => c.name === name);
}

/** The grouped overview shown by `musterd help`. `full` includes non-primary commands inline. */
export function renderHelp(opts: { full?: boolean; width?: number } = {}): string {
  const width = opts.width ?? termWidth();
  const out: string[] = [renderBanner(), ''];
  out.push(
    dim(`the coordination layer for your team · ${sym.arrow} musterd help <command> for detail`),
  );

  // Start here — the four commands a fresh session reaches for first.
  out.push('', heading('start here'));
  const startRows = START_HERE.map((n) => entry(n))
    .filter((c): c is CommandEntry => !!c)
    .map((c) => ({ term: c.name, desc: c.summary }));
  out.push(defList(startRows, { width }));

  // The rooms.
  for (const group of GROUPS) {
    const inGroup = CATALOG.filter((c) => c.group === group.id);
    const shown = opts.full ? inGroup : inGroup.filter((c) => c.primary);
    const rows = (shown.length ? shown : inGroup).map((c) => ({ term: c.name, desc: c.summary }));
    out.push('', `${heading(group.title)}  ${dim(group.blurb)}`);
    out.push(defList(rows, { width }));
    const hidden = inGroup.length - rows.length;
    if (hidden > 0) {
      out.push(dim(`  ${sym.more} +${hidden} more — musterd help ${group.id}`));
    }
  }

  // Footer.
  out.push('', rule(Math.min(width, 72)));
  out.push(theme.meta('global flags') + '  ' + GLOBAL_FLAGS.map((f) => f.flag).join('  '));
  out.push(theme.meta('acts') + '  ' + ACTS.join(' '));
  out.push(dim(`more   musterd help <command>  ${sym.dot}  musterd help --json`));
  return out.join('\n');
}

/** One group's full command list (`musterd help <group-id>`), or null if the id is unknown. */
export function renderGroupHelp(id: string): string | null {
  const group = GROUPS.find((g) => g.id === id);
  if (!group) return null;
  const width = termWidth();
  const rows = CATALOG.filter((c) => c.group === group.id).map((c) => ({
    term: c.name,
    desc: c.summary,
  }));
  return [
    `${heading(group.title)}  ${dim(group.blurb)}`,
    defList(rows, { width }),
    '',
    dim(`musterd help <command> for detail  ${sym.dot}  musterd help  for the full map`),
  ].join('\n');
}

/** Detail for one command (`musterd help <name>`), or null if the name is unknown. */
export function renderCommandHelp(name: string): string | null {
  const cmd = entry(name);
  if (!cmd) return null;
  const width = termWidth();
  const out: string[] = [];

  const sig = cmd.signature ? ` ${theme.meta(cmd.signature)}` : '';
  out.push(`${theme.accent('musterd ' + cmd.name)}${sig}`);
  out.push('  ' + cmd.summary);

  if (cmd.detail) {
    out.push('');
    for (const para of cmd.detail.split('\n')) {
      // Preserve the intentional indented sub-command blocks; wrap only free-flowing prose.
      if (/^\s{2,}/.test(para)) out.push(theme.meta(para));
      else for (const line of wrapText(para, width - 2)) out.push('  ' + line);
    }
  }

  if (cmd.examples?.length) {
    out.push('', heading('examples'));
    for (const ex of cmd.examples) out.push(`  ${theme.meta('$')} ${ex}`);
  }

  const group = GROUPS.find((g) => g.id === cmd.group);
  out.push('', dim(`in: ${group?.title ?? cmd.group}  ${sym.dot}  musterd help  for the full map`));
  return out.join('\n');
}

/** The whole catalog as JSON — a stable machine surface for agents and agentic workflows. */
export function renderHelpJson(): string {
  return JSON.stringify({
    groups: GROUPS,
    start_here: START_HERE,
    commands: CATALOG,
    global_flags: GLOBAL_FLAGS,
    acts: ACTS,
  });
}

/**
 * A "did you mean" nearest-name suggestion for an unknown command word — the warm alternative to a bare
 * "unknown command". Returns the closest catalog name within a small edit distance, or null.
 */
export function nearestCommand(input: string): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of CATALOG) {
    const d = editDistance(input, c.name);
    if (d < bestDist) {
      bestDist = d;
      best = c.name;
    }
  }
  // Only suggest when it's genuinely close (≤2 edits, or a clear prefix typo).
  return best && bestDist <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}
