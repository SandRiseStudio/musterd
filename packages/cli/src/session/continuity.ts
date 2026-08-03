import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ContinuityRegistrySchema,
  type ContinuityRegistry,
  type SessionCapture,
} from '@musterd/protocol';

const BINDING_DIR = '.musterd';
const CONTINUITY_FILE = 'continuity.json';

/** `<dir>/.musterd/continuity.json` — gitignored and 0600, beside `binding.json`. */
export function continuityPath(dir: string): string {
  return join(dir, BINDING_DIR, CONTINUITY_FILE);
}

export interface RegistryOwner {
  team: string;
  seat: string;
}

function empty(owner: RegistryOwner): ContinuityRegistry {
  return { version: 1, team: owner.team, seat: owner.seat, bindings: [] };
}

/**
 * Read this workspace's continuity registry (ADR 210), or an empty one.
 *
 * Every failure path returns empty rather than throwing, and that is the design: this file is a
 * cache, so losing it costs one fresh wake and nothing else. A corrupt, foreign, or unknown-shaped
 * registry is DISCARDED, never partially trusted — a registry found under another seat or team is
 * exactly the ADR 143 leak posture, where adopting someone else's local state is the failure.
 */
export function readRegistry(dir: string, owner: RegistryOwner): ContinuityRegistry {
  let raw: string;
  try {
    raw = readFileSync(continuityPath(dir), 'utf8');
  } catch {
    return empty(owner);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty(owner);
  }
  const result = ContinuityRegistrySchema.safeParse(parsed);
  if (!result.success) return empty(owner);
  if (result.data.team !== owner.team || result.data.seat !== owner.seat) return empty(owner);
  return result.data;
}

/**
 * Persist the registry atomically at 0600 — the same temp-then-rename shape `saveBinding` uses, for
 * the same reason: it holds local session identity, and a concurrent reader must never see a torn
 * file or a world-readable one.
 */
export function writeRegistry(dir: string, registry: ContinuityRegistry): string {
  const bindingDir = join(dir, BINDING_DIR);
  mkdirSync(bindingDir, { recursive: true });
  const p = continuityPath(dir);
  const safe = ContinuityRegistrySchema.parse(registry);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(safe, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort on platforms without chmod semantics
  }
  renameSync(tmp, p);
  return p;
}

export interface BindThreadOptions extends RegistryOwner {
  thread_id: string;
  /** The workspace's current session capture (`binding.session`). Absent ⇒ nothing to bind. */
  capture: SessionCapture | undefined;
  now: number;
}

/**
 * Bind a thread to the workspace's current session capture. Returns whether anything was bound.
 *
 * It never invents a resume target: with no capture, or a capture with no transcript path, there is
 * nothing that could later prove an exact match, so the bind is a no-op and every wake on that
 * thread stays fresh. That is the correct failure direction — and it is the whole story for a
 * harness with no hook path (a Codex seat writes no capture at all today), which is why such a seat
 * silently gets fresh wakes rather than a broken resume.
 */
export function bindThread(dir: string, opts: BindThreadOptions): boolean {
  const { capture } = opts;
  if (!capture || capture.transcript_path === undefined) return false;

  const registry = readRegistry(dir, opts);
  const next = {
    thread_id: opts.thread_id,
    harness: capture.harness,
    session_id: capture.id,
    transcript_path: capture.transcript_path,
    bound_at: opts.now,
    captured_at: capture.started_at,
  };
  const bindings = registry.bindings.filter(
    (b) => !(b.thread_id === next.thread_id && b.harness === next.harness),
  );
  bindings.push(next);
  writeRegistry(dir, { ...registry, bindings });
  return true;
}
