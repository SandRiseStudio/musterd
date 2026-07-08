/*
 * Steward seat (ADR 112) — shared discovery helpers.
 *
 * The steward's "eyes": read reality (git history, ADR statuses) and the declared record (the roadmap,
 * derived via the same module the site + roadmap-truth:check use), so the finders in scan.ts diff one
 * against the other. Deterministic + offline; the LLM/judgment layer (if any) sits ABOVE these facts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROADMAP,
  ROADMAP_RAW,
  type RawItem,
  type RoadmapItem,
} from '../../packages/web/src/content/roadmap.data.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..');
const adrDir = join(repoRoot, 'docs', 'decisions');

export { ROADMAP, ROADMAP_RAW };
export type { RawItem, RoadmapItem };

/**
 * The PR at which the `shipped: { prs }` anchor convention began (roadmap-truth, PR #174). Features
 * merged at or before this are covered by `legacy`-anchored items and carry no PR anchor by design, so
 * the unmarked-feature finder ignores them — only *post-convention* features are expected to declare one.
 */
export const ANCHOR_EPOCH_PR = 174;

export function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

export const isShallow = (() => {
  try {
    return git(['rev-parse', '--is-shallow-repository']).trim() === 'true';
  } catch {
    return true;
  }
})();

export interface MergedPR {
  pr: number;
  subject: string;
  sha: string;
  /** ADR numbers cited in the squash subject (e.g. "… (ADR 111)"). */
  adrs: number[];
  /** The conventional-commit type prefix, lowercased (feat, fix, docs, test, chore, …) or ''. */
  type: string;
}

/**
 * Squash-merged PRs reachable from HEAD (subject ends with "(#N)"), newest first. `since` is any
 * git date/ref expression passed to `--since` (e.g. "14 days ago"); omit to scan all history.
 */
export function mergedPRs(since?: string): MergedPR[] {
  const args = ['log', '--format=%H%x09%s'];
  if (since) args.push(`--since=${since}`);
  const out = git(args);
  const prs: MergedPR[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    const sha = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    const prm = subject.match(/\(#(\d+)\)\s*$/);
    if (!prm) continue;
    const adrs = [...subject.matchAll(/ADR\s+0*(\d+)/gi)].map((m) => Number(m[1]));
    const typeM = subject.match(/^([a-z]+)(?:\([^)]*\))?!?:/i);
    prs.push({ pr: Number(prm[1]!), subject, sha, adrs, type: (typeM?.[1] ?? '').toLowerCase() });
  }
  return prs;
}

export interface Adr {
  n: number;
  file: string;
  statusWord: string | null;
  statusLine: string | null;
}

/** An ADR by number — its file, the raw `- Status:` line, and its first status word (lowercased). */
export function adrByNumber(n: number): Adr | null {
  const prefix = String(n).padStart(3, '0') + '-';
  const file = readdirSync(adrDir).find((f) => f.startsWith(prefix) && f.endsWith('.md'));
  if (!file) return null;
  const text = readFileSync(join(adrDir, file), 'utf8');
  const statusLine = text.split('\n').find((l) => /^-\s*Status:/.test(l)) ?? null;
  const m = statusLine?.match(/^-\s*Status:\s*([A-Za-z-]+)/);
  return { n, file, statusWord: m ? m[1]!.toLowerCase() : null, statusLine };
}

export const adrAccepted = (n: number): boolean => adrByNumber(n)?.statusWord === 'accepted';

/** Every PR number an item claims as its shipped anchor. */
export function anchoredPRs(): Set<number> {
  const s = new Set<number>();
  for (const it of ROADMAP_RAW) {
    if (it.shipped && 'prs' in it.shipped) it.shipped.prs.forEach((p) => s.add(p));
  }
  return s;
}

/**
 * ADR numbers a **shipped** item already stands for — its `frozenBy` plus any "ADR NNN" in its `refs`
 * labels. A merged feature citing one of these is part of an already-declared shipped arc (e.g. a
 * follow-up PR on an ADR whose item shipped), so the unmarked-feature finder treats it as covered —
 * which keeps a multi-PR arc from re-flagging every increment.
 */
export function shippedArcAdrs(): Set<number> {
  const s = new Set<number>();
  for (const it of ROADMAP) {
    if (it.status !== 'shipped') continue;
    if (it.frozenBy !== undefined) s.add(it.frozenBy);
    for (const r of it.refs ?? []) {
      const m = r.label.match(/ADR\s+0*(\d+)/i);
      if (m) s.add(Number(m[1]));
    }
  }
  return s;
}
