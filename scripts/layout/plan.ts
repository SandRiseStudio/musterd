/*
 * Pure planning for the reach-spec lane 3 layout migration (spec §6, ADR 442):
 *
 *   ~/agents           → ~/.musterd/runtime          (the daemon's/host's build; UNBOUND)
 *   ~/agents-live      → ~/.musterd/runtime-live     (the /live build-publisher's worktree; a sibling
 *                                                     of the runtime, which is how `service --live`
 *                                                     derives it)
 *   ~/agents-<seat>    → ~/musterd/agents/<seat>      (member Workspaces, grouped by repo)
 *
 * Everything here is a function of strings so `plan.test.ts` can pin the mapping, the boundary rule
 * (`/Users/nick/agents` must never match inside `/Users/nick/agents-dolly`), the Claude Code project
 * slug, and the JSON rewrites without touching a real home. `migrate.ts` is the only file that reads
 * or writes the machine.
 */
import { basename, join } from 'node:path';

export interface Layout {
  home: string;
  /** The old main checkout, bound as the human until now. */
  oldMain: string;
  /** Where the daemon's and host's build lives after the move — conferring nobody. */
  runtime: string;
  /** The `/live` publisher's worktree, before and after. */
  oldLive: string;
  live: string;
  /** `~/musterd/<repo>` — the group every member Workspace of this repo sits in. */
  group: string;
  /** Prefix of a legacy seat Workspace: `~/agents-<seat>`. */
  seatPrefix: string;
}

export function defaultLayout(home: string, repo = 'agents'): Layout {
  return {
    home,
    oldMain: join(home, repo),
    runtime: join(home, '.musterd', 'runtime'),
    oldLive: join(home, `${repo}-live`),
    live: join(home, '.musterd', 'runtime-live'),
    group: join(home, 'musterd', repo),
    seatPrefix: join(home, `${repo}-`),
  };
}

/** The seat name a legacy Workspace path carries, or null when the path is not one. */
export function legacySeat(layout: Layout, dir: string): string | null {
  if (!dir.startsWith(layout.seatPrefix)) return null;
  const seat = dir.slice(layout.seatPrefix.length);
  if (!seat || seat.includes('/') || dir === layout.oldLive) return null;
  return seat;
}

/**
 * old → new for every top-level folder that moves. `seatDirs` are the legacy seat Workspaces that
 * exist on this machine (the caller lists `~/agents-*`); anything else under `~` stays where it is.
 */
export function pathMapping(layout: Layout, seatDirs: readonly string[]): Map<string, string> {
  const m = new Map<string, string>();
  m.set(layout.oldMain, layout.runtime);
  m.set(layout.oldLive, layout.live);
  for (const dir of seatDirs) {
    const seat = legacySeat(layout, dir);
    if (seat) m.set(dir, join(layout.group, seat));
  }
  return m;
}

/** A path character: what may follow a mapped prefix without ending the path segment. */
const SEGMENT_CHAR = /[A-Za-z0-9_.-]/;

/**
 * Map one absolute path (or a descendant of a mapped folder) to its new location; unchanged when no
 * mapping applies. Longest key first, and the match must end at a segment boundary, so
 * `/Users/nick/agents` never rewrites the inside of `/Users/nick/agents-dolly`.
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
 * The ADR 020 bindings registry after the move: seat entries re-keyed; the old main's entry dropped,
 * because the runtime is unbound (spec §6) — nothing under `~/.musterd/runtime` acts as anyone.
 */
export function rewriteRegistry<T extends { bindings?: Record<string, unknown> }>(
  config: T,
  layout: Layout,
  mapping: ReadonlyMap<string, string>,
): T {
  const bindings: Record<string, unknown> = {};
  for (const [folder, ref] of Object.entries(config.bindings ?? {})) {
    if (folder === layout.oldMain) continue;
    bindings[mapPath(folder, mapping)] = ref;
  }
  return { ...rewriteJson(config, mapping), bindings };
}

/**
 * Where a `~/.claude/projects/<slug>` transcript folder goes. The old main's sessions were the
 * human's, so they follow the human to `~/musterd/<repo>/<human>` (merged if that folder already has
 * sessions); a seat's follow the seat. Null when the folder is not one that moves.
 */
export function claudeProjectMove(
  slugDir: string,
  layout: Layout,
  mapping: ReadonlyMap<string, string>,
  humanHome: string,
): string | null {
  const slug = basename(slugDir);
  for (const [from, to] of mapping) {
    if (slug === claudeProjectSlug(from)) {
      const target = from === layout.oldMain ? humanHome : to;
      return join(slugDir, '..', claudeProjectSlug(target));
    }
  }
  return null;
}
