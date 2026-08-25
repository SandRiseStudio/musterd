import { spawnSync } from 'node:child_process';
import { openSync, readdirSync, readFileSync, readSync, closeSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { findWorkspaceDir } from '../commands/helpers.js';

/**
 * Session enumeration (ADR 166). The harness already keeps one file per session — so liveness can be
 * *asked* rather than kept in a slot.
 *
 * **How a transcript is attributed to a workspace, and why not by directory name.** The first
 * implementation decoded Claude Code's `~/.claude/projects/<slug>` directory name back into a path
 * (slashes → dashes). The ADR 166 fleet sweep killed that on its first run: a live session under
 * `/Users/nick/agents` was invisible, because it ran in a `.claude-worktrees/` subdirectory whose
 * slug is `-Users-nick-agents--claude-worktrees-…` — the dot replaced — while `.claude` and `.pnpm`
 * elsewhere in the very same tree **keep** their dots. The encoding is undocumented and not
 * self-consistent, so decoding it is a guess, and a guess that failed would have demoted a live
 * session — reproducing the exact defect this ADR exists to fix.
 *
 * So attribution uses what the harness *records* rather than how it *names*: every transcript entry
 * carries a `cwd`, and a transcript belongs to the workspace that {@link findWorkspaceDir} resolves
 * from that `cwd` — musterd's own walk-up rule, the same one that decided which binding the
 * `SessionStart` hook wrote to. A session in a subdirectory of a workspace therefore belongs to that
 * workspace, which is exactly what the slot already believed.
 *
 * Measured on the live tree: 689 transcripts, 664 attributable, ~256 ms for a full scan. Wake
 * decisions run 1–3 times a day, so this is not a hot path; the 1-second memo below exists so a
 * fleet sweep is one scan rather than one per workspace.
 *
 * Everything here is read-only and best-effort. `undefined` means **"cannot tell"** and must never be
 * read as "no sessions" — the wake guard's safe answer when unsure is *live* (refuse to spawn), and a
 * missing projects tree must not be laundered into permission.
 */

/** A transcript untouched for this long means no live local session (the guard threshold): long
 *  enough to protect a human who is thinking, well under the 30-minute batched-wake cooldown.
 *  Lives here (not liveness.ts, which re-exports it) so the scanners can judge warmth without an
 *  import cycle. */
export const LOCAL_SESSION_LIVE_MS = 10 * 60_000;

/** One session the harness has on disk for a workspace. */
export interface SessionFile {
  /** The harness session id (`claude --resume <id>`) — the transcript's basename. */
  id: string;
  path: string;
  /** Last write. This is the liveness signal: the harness appends on every message/tool event. */
  mtime: number;
  bytes: number;
}

interface ScannedTranscript extends SessionFile {
  /** The workspace this transcript's recorded `cwd` walks up to, or null when unattributable. */
  workspace: string | null;
}

/** How far into a transcript to look for `cwd`. Entry 1 has none; entry 2 does. 64 KiB covered
 *  664 of 689 live transcripts — the remainder are empty or aborted and stay unattributed. */
const CWD_PROBE_BYTES = 65_536;

/** A transcript with no recorded `cwd` is *unattributable*, never "belongs to the workspace I asked
 *  about". Guessing here is how a stale transcript would get counted as somebody's live session. */
function readCwd(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(CWD_PROBE_BYTES);
    const got = readSync(fd, buf, 0, CWD_PROBE_BYTES, 0);
    return /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.subarray(0, got).toString('utf8'))?.[1];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

function scanTree(root: string): ScannedTranscript[] | undefined {
  let top: string[];
  try {
    top = readdirSync(root);
  } catch {
    return undefined; // no projects tree — cannot tell
  }
  const out: ScannedTranscript[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.name.endsWith('.jsonl')) continue;
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        const cwd = readCwd(p);
        out.push({
          id: e.name.slice(0, -'.jsonl'.length),
          path: p,
          mtime: st.mtimeMs,
          bytes: st.size,
          workspace: cwd ? findWorkspaceDir(cwd) : null,
        });
      } catch {
        // vanished between readdir and stat — skip it, tell no lie about it
      }
    }
  };
  for (const name of top) walk(join(root, name));
  return out;
}

/** One scan serves a burst of judgements (a fleet sweep asks per workspace). Short enough that a
 *  wake decision never acts on a stale picture of the filesystem. */
const MEMO_MS = 1_000;
let memo: { root: string; at: number; rows: ScannedTranscript[] | undefined } | null = null;
let codexMemo: { root: string; at: number; rows: ScannedTranscript[] | undefined } | null = null;
let cursorMemo: { root: string; at: number; rows: ScannedTranscript[] | undefined } | null = null;
let opencodeMemo: { at: number; rows: ScannedTranscript[] | undefined } | null = null;

/** Drop the scan memo — tests and long-lived processes that need a guaranteed-fresh read. */
export function resetSessionScan(): void {
  memo = null;
  codexMemo = null;
  cursorMemo = null;
  opencodeMemo = null;
}

/**
 * Every session the harness has on disk for this workspace, newest write first.
 *
 * Returns `undefined` for **"cannot tell"** (no projects tree) and `[]` only when the tree exists
 * and genuinely holds nothing for this workspace. Callers must keep those apart.
 *
 * Never throws — this feeds a wake decision and a hook-adjacent read path.
 */
export function enumerateClaudeSessions(
  workspace: string,
  home = homedir(),
  now = Date.now(),
): SessionFile[] | undefined {
  const root = join(home, '.claude', 'projects');
  if (!memo || memo.root !== root || now - memo.at > MEMO_MS) {
    memo = { root, at: now, rows: scanTree(root) };
  }
  if (memo.rows === undefined) return undefined;
  const target = resolve(workspace);
  return memo.rows
    .filter((r) => r.workspace !== null && resolve(r.workspace) === target)
    .map(({ id, path, mtime, bytes }) => ({ id, path, mtime, bytes }))
    .sort((a, b) => b.mtime - a.mtime);
}

/** The only Codex rollout record that establishes both a resume identity and workspace ownership.
 *  Everything else in the transcript is deliberately irrelevant to residency and is never parsed. */
const CodexSessionMetaSchema = z.object({
  type: z.literal('session_meta'),
  payload: z.object({ session_id: z.string().min(1), cwd: z.string().min(1) }).passthrough(),
});

/** Read the bounded rollout prefix looking for the harness-recorded identity and cwd. Missing or
 * malformed evidence is unattributable, never a filename-derived guess. */
function readCodexSessionMeta(path: string): { id: string; cwd: string } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(CWD_PROBE_BYTES);
    const got = readSync(fd, buf, 0, CWD_PROBE_BYTES, 0);
    for (const line of buf.subarray(0, got).toString('utf8').split('\n')) {
      if (!line) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = CodexSessionMetaSchema.safeParse(raw);
      if (parsed.success) {
        return { id: parsed.data.payload.session_id, cwd: parsed.data.payload.cwd };
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

function scanCodexTree(root: string): ScannedTranscript[] | undefined {
  let top: string[];
  try {
    top = readdirSync(root);
  } catch {
    return undefined;
  }
  const out: ScannedTranscript[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl'))
        continue;
      try {
        const stat = statSync(path);
        const meta = readCodexSessionMeta(path);
        out.push({
          id: meta?.id ?? '',
          path,
          mtime: stat.mtimeMs,
          bytes: stat.size,
          workspace: meta ? findWorkspaceDir(meta.cwd) : null,
        });
      } catch {
        // vanished during a read — it supplies no evidence
      }
    }
  };
  for (const name of top) walk(join(root, name));
  return out;
}

/**
 * Read-only Codex rollout enumeration (ADR 216). Codex's session_meta record supplies the exact
 * `codex exec resume` identity and cwd; the rollout filename and session-index display data are not
 * identity evidence. As for Claude, `undefined` means "cannot tell", never "no sessions".
 */
export function enumerateCodexSessions(
  workspace: string,
  home = homedir(),
  now = Date.now(),
): SessionFile[] | undefined {
  const root = join(home, '.codex', 'sessions');
  if (!codexMemo || codexMemo.root !== root || now - codexMemo.at > MEMO_MS) {
    codexMemo = { root, at: now, rows: scanCodexTree(root) };
  }
  if (codexMemo.rows === undefined) return undefined;
  const target = resolve(workspace);
  return codexMemo.rows
    .filter((row) => row.workspace !== null && resolve(row.workspace) === target)
    .map(({ id, path, mtime, bytes }) => ({ id, path, mtime, bytes }))
    .sort((a, b) => b.mtime - a.mtime);
}

/** Cursor's own recorded workspace path for a `~/.cursor/projects/<id>` folder (ADR 265).
 *  Never decode the folder name — that is the ADR 166 slug trap. A missing or unparseable
 *  `.workspace-trusted` leaves the project unattributed. */
const CursorWorkspaceTrustedSchema = z.object({ workspacePath: z.string().min(1) }).passthrough();

function readCursorWorkspace(projectDir: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(projectDir, '.workspace-trusted'), 'utf8'));
    const parsed = CursorWorkspaceTrustedSchema.safeParse(raw);
    return parsed.success ? findWorkspaceDir(parsed.data.workspacePath) : null;
  } catch {
    return null;
  }
}

function scanCursorTree(root: string): ScannedTranscript[] | undefined {
  let top: string[];
  try {
    top = readdirSync(root);
  } catch {
    return undefined;
  }
  const out: ScannedTranscript[] = [];
  const walkTranscripts = (dir: string, workspace: string | null): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkTranscripts(path, workspace);
        continue;
      }
      if (!entry.isFile()) continue;
      const jsonl = entry.name.endsWith('.jsonl');
      const txt = entry.name.endsWith('.txt');
      if (!jsonl && !txt) continue;
      try {
        const stat = statSync(path);
        const id = entry.name.slice(0, jsonl ? -'.jsonl'.length : -'.txt'.length);
        if (!id) continue;
        out.push({ id, path, mtime: stat.mtimeMs, bytes: stat.size, workspace });
      } catch {
        // vanished between readdir and stat
      }
    }
  };
  for (const name of top) {
    const project = join(root, name);
    walkTranscripts(join(project, 'agent-transcripts'), readCursorWorkspace(project));
  }
  return out;
}

/**
 * Read-only Cursor session scan (ADR 265). Attribution is Cursor's `.workspace-trusted`
 * `workspacePath`, walked up with {@link findWorkspaceDir} — the same rule the hook uses.
 * Desktop sessions land as `agent-transcripts/<id>/<id>.jsonl`; a `cursor-agent` CLI session
 * lands as `agent-transcripts/<id>.txt` (measured 2026-08-13 on wanderer). `undefined` means
 * "cannot tell", never "no sessions".
 */
export function enumerateCursorSessions(
  workspace: string,
  home = homedir(),
  now = Date.now(),
): SessionFile[] | undefined {
  const root = join(home, '.cursor', 'projects');
  if (!cursorMemo || cursorMemo.root !== root || now - cursorMemo.at > MEMO_MS) {
    cursorMemo = { root, at: now, rows: scanCursorTree(root) };
  }
  if (cursorMemo.rows === undefined) return undefined;
  // ADR 265 amendment (2026-08-21): a transcript being written RIGHT NOW in a project Cursor has
  // not yet stamped with `.workspace-trusted` is a live session nobody can place — possibly this
  // workspace's. Answering "no sessions here" would launder cannot-tell into permission: the ADR
  // 166 inspection measured agents-kimi's live desktop session demoted for the 74 minutes before
  // the trust file appeared, and most projects on the measured machine never get the file at all.
  // A warm orphan therefore blinds the whole scan; cold orphans stay uncounted as before (they
  // cannot affect the live judgement, and claiming them would be the slug-decoding trap).
  if (cursorMemo.rows.some((r) => r.workspace === null && now - r.mtime < LOCAL_SESSION_LIVE_MS)) {
    return undefined;
  }
  const target = resolve(workspace);
  return cursorMemo.rows
    .filter((row) => row.workspace !== null && resolve(row.workspace) === target)
    .map(({ id, path, mtime, bytes }) => ({ id, path, mtime, bytes }))
    .sort((a, b) => b.mtime - a.mtime);
}

/** The only OpenCode CLI row fields that establish resume identity, liveness, and workspace
 *  ownership (ADR 321 §6). `title`/`projectId`/`created` are display data and never parsed. */
const OpencodeSessionSchema = z
  .object({
    id: z.string().min(1),
    updated: z.number(),
    directory: z.string().min(1),
  })
  .passthrough();

/**
 * Read-only OpenCode session enumeration (ADR 321 §6): the harness's own CLI JSON surface,
 * `opencode session list --format json`, parsed at the boundary like every other external input.
 * The CLI — not the private storage database — is the evidence boundary (the ADR 216 rule): the
 * schema is stable public contract, the sqlite file is neither. Attribution needs no slug
 * decoding: each row carries its working directory outright, walked up with
 * {@link findWorkspaceDir} like every sibling. A missing binary, a non-zero exit, or unparseable
 * output is "cannot tell" (`undefined`), never "no sessions".
 */
export function enumerateOpencodeSessions(
  workspace: string,
  now = Date.now(),
): SessionFile[] | undefined {
  if (!opencodeMemo || now - opencodeMemo.at > MEMO_MS) {
    let rows: ScannedTranscript[] | undefined;
    try {
      const res = spawnSync(
        process.env['OPENCODE_BIN'] ?? 'opencode',
        ['session', 'list', '--format', 'json'],
        {
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      const raw: unknown = res.status === 0 && !res.error ? JSON.parse(res.stdout) : undefined;
      if (Array.isArray(raw)) {
        rows = [];
        for (const item of raw) {
          const parsed = OpencodeSessionSchema.safeParse(item);
          if (!parsed.success) continue;
          rows.push({
            id: parsed.data.id,
            // The CLI JSON names no transcript file; liveness reads `updated` (the same signal
            // opencode's own UI sorts by), and nothing downstream stats an opencode path.
            path: '',
            mtime: parsed.data.updated,
            bytes: 0,
            workspace: findWorkspaceDir(parsed.data.directory),
          });
        }
      }
    } catch {
      rows = undefined; // binary absent, spawn failed, output unparseable — cannot tell
    }
    opencodeMemo = { at: now, rows };
  }
  if (opencodeMemo.rows === undefined) return undefined;
  const target = resolve(workspace);
  return opencodeMemo.rows
    .filter((row) => row.workspace !== null && resolve(row.workspace) === target)
    .map(({ id, path, mtime, bytes }) => ({ id, path, mtime, bytes }))
    .sort((a, b) => b.mtime - a.mtime);
}
