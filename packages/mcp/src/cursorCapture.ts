import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { findBinding, saveBinding, seatWorkspaceRoot } from './binding.js';

/**
 * Cursor capture reconcile (ADR 270). The heartbeat already re-reads `model_observed` (ADR 158);
 * this is the writer that heartbeat was missing when `cursor-agent` dispatches no observe hooks.
 *
 * Package boundary: do not import CLI `session.ts`. The scan below is a copy of
 * `enumerateCursorSessions` (ADR 265 attribution rules); reconcile tests inject the enumerator so
 * the heal does not depend on the copy.
 */

/** Must match `LOCAL_SESSION_LIVE_MS` in packages/cli/src/session/liveness.ts — the package
 *  boundary forbids the import (ADR 270). Drift against that constant is a bug. */
export const CURSOR_CAPTURE_LIVE_MS = 10 * 60_000;

export interface CursorSessionFile {
  id: string;
  path: string;
  mtime: number;
  bytes: number;
}

interface ScannedTranscript extends CursorSessionFile {
  workspace: string | null;
}

const CursorWorkspaceTrustedSchema = z.object({ workspacePath: z.string().min(1) }).passthrough();

function readCursorWorkspace(projectDir: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(projectDir, '.workspace-trusted'), 'utf8'));
    const parsed = CursorWorkspaceTrustedSchema.safeParse(raw);
    return parsed.success ? seatWorkspaceRoot(parsed.data.workspacePath) : null;
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

const MEMO_MS = 1_000;
let cursorMemo: { root: string; at: number; rows: ScannedTranscript[] | undefined } | null = null;

/** Drop the scan memo — tests that need a guaranteed-fresh read. */
export function resetCursorScan(): void {
  cursorMemo = null;
}

/**
 * Read-only Cursor session scan (ADR 265 / ADR 270). Attribution is Cursor's `.workspace-trusted`
 * `workspacePath`, walked up with {@link seatWorkspaceRoot} — the same binding-file rule the hook
 * uses. Desktop sessions land as `agent-transcripts/<id>/<id>.jsonl`; a `cursor-agent` CLI session
 * lands as `agent-transcripts/<id>.txt`. `undefined` means "cannot tell", never "no sessions".
 */
export function enumerateCursorSessions(
  workspace: string,
  home = homedir(),
  now = Date.now(),
): CursorSessionFile[] | undefined {
  const root = join(home, '.cursor', 'projects');
  if (!cursorMemo || cursorMemo.root !== root || now - cursorMemo.at > MEMO_MS) {
    cursorMemo = { root, at: now, rows: scanCursorTree(root) };
  }
  if (cursorMemo.rows === undefined) return undefined;
  const target = resolve(workspace);
  return cursorMemo.rows
    .filter((row) => row.workspace !== null && resolve(row.workspace) === target)
    .map(({ id, path, mtime, bytes }) => ({ id, path, mtime, bytes }))
    .sort((a, b) => b.mtime - a.mtime);
}

function birthtimeOf(path: string): number | undefined {
  try {
    const t = statSync(path).birthtimeMs;
    // FLOORED: SessionCaptureSchema declares started_at as z.number().int(). A fractional
    // birthtimeMs wrote a binding findBinding could no longer parse (CLI session.ts, same trap).
    return Number.isFinite(t) && t > 0 ? Math.floor(t) : undefined;
  } catch {
    return undefined;
  }
}

export type CursorEnumerator = (workspace: string) => CursorSessionFile[] | undefined;

/**
 * Heal a Cursor slot whose newest live enumerated transcript disagrees, and drop the leftover
 * observation. Returns true when it wrote. Never throws — it rides the heartbeat.
 *
 * A `claude-code` / `codex` slot is never stolen. Same id keeps the observation (never-erase
 * within a session). Newest live wins — do not hop to a quieter sibling.
 */
export function reconcileCursorCapture(
  dir: string,
  enumerate: CursorEnumerator = enumerateCursorSessions,
  now = Date.now(),
): boolean {
  try {
    const binding = findBinding(dir, {});
    if (!binding) return false;
    const session = binding.session;
    if (session && session.harness !== 'cursor') return false;

    const files = enumerate(dir);
    if (!files) return false; // cannot tell — the slot stays the only witness

    const newest = files.find((f) => now - f.mtime < CURSOR_CAPTURE_LIVE_MS);
    if (!newest) return false;
    if (session?.id === newest.id) return false;

    const slot = {
      harness: 'cursor' as const,
      id: newest.id,
      transcript_path: newest.path,
      started_at: birthtimeOf(newest.path) ?? now,
    };
    const { model_observed: _dropped, ...rest } = binding;
    saveBinding(dir, { ...rest, session: slot }, { drop: { model_observed: true } });
    return true;
  } catch {
    return false;
  }
}
