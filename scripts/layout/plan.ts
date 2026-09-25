/*
 * Pure planning for the ADR 447 layout migration — team outermost:
 *
 *   ~/musterd/<repo>/<member>   → ~/musterd/<team>/<repo>/<member>   (every bound member Workspace)
 *   ~/musterd/<team>/.musterd/binding.json                            (deleted: the team root is a roof)
 *
 * Everything here is a function of strings so `plan.test.ts` can pin the mapping, the boundary rule
 * (`/Users/nick/musterd/agents` must never match inside `/Users/nick/musterd/agents-x`), the Claude
 * Code project slug, and the JSON rewrites without touching a real home. `migrate.ts` is the only
 * file that reads or writes the machine.
 *
 * The 2026-09-24 move from `~/agents*` onto `~/musterd/<repo>/<member>` (reach spec lane 3) used an
 * earlier shape of this file; it is in git history, and its inventory is the wiki's.
 */
import { basename, join } from 'node:path';

/** A bindings-registry entry (ADR 020) as far as the move needs it. */
export interface BoundFolder {
  team: string;
  seat?: string;
}

/** The roof every team's tree hangs off: `~/musterd`. */
export function roofOf(home: string): string {
  return join(home, 'musterd');
}

/** Path segments beneath the roof, or null when `dir` is not under it. */
export function underRoof(home: string, dir: string): string[] | null {
  const roof = roofOf(home);
  if (!dir.startsWith(roof + '/')) return null;
  return dir.slice(roof.length + 1).split('/');
}

/**
 * old → new for every bound member Workspace still on the repo-first layout (exactly two levels
 * beneath the roof). A folder already three deep is on the team-first layout and stays; anything
 * outside `~/musterd` (a `--path` seat, a review checkout) is not the layout's business.
 */
export function memberMoves(
  home: string,
  bindings: Readonly<Record<string, BoundFolder>>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const [folder, ref] of Object.entries(bindings)) {
    const seg = underRoof(home, folder);
    if (!seg || seg.length !== 2) continue;
    const [repo, member] = seg as [string, string];
    m.set(folder, join(roofOf(home), ref.team, repo, member));
  }
  return m;
}

/** The team roots whose own binding must go: `~/musterd/<team>` for every team that has a member moving or already placed. */
export function teamRoots(home: string, bindings: Readonly<Record<string, BoundFolder>>): string[] {
  const teams = new Set<string>();
  for (const [folder, ref] of Object.entries(bindings)) {
    const seg = underRoof(home, folder);
    if (seg && (seg.length === 2 || seg.length === 3)) teams.add(ref.team);
  }
  return [...teams].sort().map((t) => join(roofOf(home), t));
}

/** A path character: what may follow a mapped prefix without ending the path segment. */
const SEGMENT_CHAR = /[A-Za-z0-9_.-]/;

/**
 * Map one absolute path (or a descendant of a mapped folder) to its new location; unchanged when no
 * mapping applies. Longest key first, and the match must end at a segment boundary, so
 * `/Users/nick/musterd/agents/dolly` never rewrites the inside of `/Users/nick/musterd/agents/dolly-x`.
 */
export function mapPath(p: string, mapping: ReadonlyMap<string, string>): string {
  for (const [from, to] of [...mapping.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (p === from) return to;
    if (p.startsWith(from + '/')) return to + p.slice(from.length);
  }
  return p;
}

/** Rewrite every mapped path inside free text (plists, shell scripts, JSON serialised as text). */
export function rewritePaths(text: string, mapping: ReadonlyMap<string, string>): string {
  const keys = [...mapping.keys()].sort((a, b) => b.length - a.length);
  let out = '';
  let i = 0;
  while (i < text.length) {
    let hit: string | undefined;
    for (const k of keys) {
      if (text.startsWith(k, i)) {
        const next = text[i + k.length];
        if (next === undefined || !SEGMENT_CHAR.test(next)) {
          hit = k;
          break;
        }
      }
    }
    if (hit) {
      out += mapping.get(hit);
      i += hit.length;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** Deep-rewrite every string value AND every object key of a parsed JSON document. */
export function rewriteJson<T>(value: T, mapping: ReadonlyMap<string, string>): T {
  if (typeof value === 'string') return rewritePaths(value, mapping) as T;
  if (Array.isArray(value)) return value.map((v) => rewriteJson(v, mapping)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[rewritePaths(k, mapping)] = rewriteJson(v, mapping);
    }
    return out as T;
  }
  return value;
}

/**
 * Claude Code keys `~/.claude/projects/<slug>` by the project path with every non-alphanumeric
 * character replaced by `-` (`/private/tmp/claude-501/-Users-nick-x` → `-private-tmp-claude-501--Users-nick-x`).
 */
export function claudeProjectSlug(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * The ADR 020 bindings registry after the move: member entries re-keyed; the team roots' entries
 * dropped, because a root is a roof (ADR 447) — nothing at `~/musterd/<team>` acts as anyone. The
 * recorded `teamHome` (where the human stands, ADR 176) follows the human's binding off the root.
 */
export function rewriteRegistry<
  T extends { bindings?: Record<string, BoundFolder>; teamHome?: Record<string, string> },
>(config: T, home: string, mapping: ReadonlyMap<string, string>): T {
  const roots = new Set(teamRoots(home, config.bindings ?? {}));
  const bindings: Record<string, BoundFolder> = {};
  for (const [folder, ref] of Object.entries(config.bindings ?? {})) {
    if (roots.has(folder)) continue;
    bindings[mapPath(folder, mapping)] = ref;
  }
  const teamHome: Record<string, string> = {};
  for (const [team, dir] of Object.entries(config.teamHome ?? {})) {
    if (!roots.has(dir)) {
      teamHome[team] = mapPath(dir, mapping);
      continue;
    }
    // The human stood on the root; their floor is now their member Workspace of that team.
    const human = (config.bindings ?? {})[dir]?.seat;
    const floor = Object.entries(bindings).find(
      ([, ref]) => ref.team === team && ref.seat === human,
    )?.[0];
    if (floor) teamHome[team] = floor;
  }
  return { ...rewriteJson(config, mapping), bindings, teamHome };
}

/**
 * Where a `~/.claude/projects/<slug>` transcript folder goes when its project folder moved. Null
 * when the folder is not one that moves.
 */
export function claudeProjectMove(
  slugDir: string,
  mapping: ReadonlyMap<string, string>,
): string | null {
  const slug = basename(slugDir);
  for (const [from, to] of mapping) {
    if (slug === claudeProjectSlug(from)) return join(slugDir, '..', claudeProjectSlug(to));
  }
  return null;
}
