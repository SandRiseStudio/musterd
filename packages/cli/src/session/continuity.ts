import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ContinuityRegistrySchema,
  pruneRegistry,
  type ContinuityRegistry,
  type SessionCapture,
} from '@musterd/protocol';
import { RESUME_GC_HORIZON_MS } from './liveness.js';

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

export interface PruneOnDiskOptions {
  now: number;
  /**
   * Threads the CALLER knows have resolved. The host cannot derive this on its own — thread
   * resolution is daemon knowledge — so it is passed in by whoever happens to hold it, and omitted
   * otherwise. A resolved thread whose binding lingers is only wasted space: the wake that would
   * have used it is never issued, because the daemon stops marking a resolved thread eligible.
   */
  resolvedThreads?: ReadonlySet<string>;
}

/**
 * Prune the on-disk registry, rewriting it only when something actually dropped.
 *
 * Pruning is not housekeeping. An unusable binding that survives is a resume attempt that will fail
 * and spend a fallback, so the two conditions the host CAN check itself — the transcript is gone,
 * or the binding is past the harness GC horizon where a resume would fail anyway — are checked here
 * against the real filesystem. {@link RESUME_GC_HORIZON_MS} is reused deliberately rather than
 * inventing a second horizon: one number, one meaning.
 */
export function pruneOnDisk(
  dir: string,
  owner: RegistryOwner,
  { now, resolvedThreads = new Set<string>() }: PruneOnDiskOptions,
): ContinuityRegistry {
  const registry = readRegistry(dir, owner);
  if (registry.bindings.length === 0) return registry;
  const pruned = pruneRegistry(registry, {
    now,
    maxAgeMs: RESUME_GC_HORIZON_MS,
    transcriptExists: (p) => existsSync(p),
    resolvedThreads,
  });
  if (pruned.bindings.length !== registry.bindings.length) writeRegistry(dir, pruned);
  return pruned;
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

  // Prune as a side effect of binding: without it the file only ever grows, and every dead entry
  // is a resume that would fail. Binding is the natural moment — it is the one write that happens
  // on the same cadence as the dialogue itself.
  const registry = pruneOnDisk(dir, opts, { now: opts.now });
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
