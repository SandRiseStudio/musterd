import { z } from 'zod';
import type { Activity } from './acts.js';

/**
 * Roster posture (ADR 138) — the composed “what kind of present/absent?” read for chips and roll
 * calls. Derived server-side from `activity` ∩ `availability` (availability outranks, ADR 044); clients
 * render the wire token, they do not invent synonyms.
 *
 * `idle` is the live-but-no-task state (activity `idle`, ADR 140); `away` folds explicit `away`/`dnd`
 * availability. Offline *reasons* ride `offline_reason` (ADR 141).
 */
export const POSTURES = ['working', 'idle', 'away', 'offline'] as const;
export type Posture = (typeof POSTURES)[number];
export const PostureSchema = z.enum(POSTURES);

export interface PostureInput {
  activity: Activity;
  /** Explicit availability (Axis 2). Absent/`available` never overrides activity. */
  availability?: { status: 'available' | 'away' | 'dnd' | 'off_hours' } | null;
}

/**
 * Resolve roster posture. Order matches the CLI status grouping (ADR 044):
 * offline → away/dnd/off_hours → working → idle.
 */
export function resolvePosture(input: PostureInput): Posture {
  if (input.activity === 'offline') return 'offline';
  const avail = input.availability?.status;
  if (avail === 'away' || avail === 'dnd' || avail === 'off_hours') return 'away';
  if (input.activity === 'working') return 'working';
  return 'idle';
}
