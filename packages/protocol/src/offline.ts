import { z } from 'zod';

/**
 * Why a seat reads offline on the roster (ADR 141, deliberate-exit split per the 2026-08-19
 * presence-honesty spec §2.3). Projected only when not live; `null` when live. `reconnecting` wins
 * during reclaim grace; the sticky stamps persist on the member row: `disconnected` (presence ended
 * without a goodbye), `left_team` (team_leave / soft-remove), `seat_released` (explicit unbind),
 * `session_ended` (clean session exit). `signed_off` is legacy: accepted on read, never newly
 * stamped, resolved as `seat_released`. `off_hours` is explicit availability; `unknown` is the
 * honest default (e.g. never connected).
 */
export const OFFLINE_REASONS = [
  'reconnecting',
  'disconnected',
  'left_team',
  'seat_released',
  'session_ended',
  'signed_off',
  'off_hours',
  'unknown',
] as const;
export type OfflineReason = (typeof OFFLINE_REASONS)[number];
export const OfflineReasonSchema = z.enum(OFFLINE_REASONS);

export interface OfflineReasonInput {
  /** False when the seat has no live attachment. */
  live: boolean;
  reclaimable?: boolean;
  availability?: { status: 'available' | 'away' | 'dnd' | 'off_hours' } | null;
  /** Sticky reason stamped when presence ended (`disconnected` or a deliberate-exit stamp). */
  lastOfflineReason?: OfflineReason | null;
}

/**
 * The sticky reasons a member row may carry into resolution. `signed_off` is accepted here so
 * legacy rows still resolve (normalized to `seat_released`), but nothing newly stamps it.
 */
export const STICKY_OFFLINE_REASONS: ReadonlySet<string> = new Set([
  'disconnected',
  'left_team',
  'seat_released',
  'session_ended',
  'signed_off',
]);

/** Resolve offline_reason. Returns null while live. */
export function resolveOfflineReason(input: OfflineReasonInput): OfflineReason | null {
  if (input.live) return null;
  if (input.reclaimable) return 'reconnecting';
  if (input.availability?.status === 'off_hours') return 'off_hours';
  const sticky = input.lastOfflineReason;
  if (sticky === 'signed_off') return 'seat_released'; // legacy rows, never newly stamped
  if (sticky && STICKY_OFFLINE_REASONS.has(sticky)) return sticky;
  return 'unknown';
}
