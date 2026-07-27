import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Session enumeration (ADR 166, increment 1). The harness already keeps one file per session, named
 * after that session, in a directory derivable from the workspace path alone — so liveness can be
 * *asked* rather than kept in a slot.
 *
 * This is the Claude Code implementation of that capability. Everything here is read-only and
 * best-effort: an unreadable directory returns nothing, which the caller must read as **"cannot
 * tell"** and never as "no sessions". The distinction is load-bearing — the wake guard's safe
 * answer when unsure is *live* (refuse to spawn), and a missing directory must not be laundered
 * into permission.
 */

/** One session the harness has on disk for a workspace. */
export interface SessionFile {
  /** The harness session id (`claude --resume <id>`) — the transcript's basename. */
  id: string;
  path: string;
  /** Last write. This is the liveness signal: the harness appends on every message/tool event. */
  mtime: number;
  bytes: number;
}

/**
 * Claude Code slugifies the absolute workspace path into a single directory name under
 * `~/.claude/projects`: every `/` becomes `-`, so `/Users/nick/agents-miley` becomes
 * `-Users-nick-agents-miley`. Verified against the live tree for `agents-miley`, `agents-stanley`
 * and `agents` — the leading `-` is the leading slash, not a separator.
 */
export function claudeProjectDir(workspace: string, home = homedir()): string {
  const abs = isAbsolute(workspace) ? workspace : resolve(workspace);
  return join(home, '.claude', 'projects', abs.replace(/\//g, '-'));
}

/**
 * Every session Claude Code has on disk for this workspace, newest write first.
 *
 * Returns `undefined` for **"cannot tell"** (no such directory, unreadable) and `[]` only for a
 * directory that genuinely holds no transcripts. Callers must keep those apart: `undefined` is the
 * pre-enumeration world and has to degrade to the incumbent judgement, while `[]` is real evidence.
 *
 * Never throws — this feeds a wake decision and a hook-adjacent read path.
 */
export function enumerateClaudeSessions(
  workspace: string,
  home = homedir(),
): SessionFile[] | undefined {
  const dir = claudeProjectDir(workspace, home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined; // cannot tell — NOT "none"
  }
  const out: SessionFile[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      out.push({ id: name.slice(0, -'.jsonl'.length), path, mtime: st.mtimeMs, bytes: st.size });
    } catch {
      // a transcript that vanished between readdir and stat — skip it, tell no lie about it
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
