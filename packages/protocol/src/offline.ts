import { z } from 'zod';

/**
 * Why a seat reads offline on the roster (ADR 141). Projected only when not live; `null` when live.
 * `reconnecting` wins during reclaim grace; sticky `disconnected`/`signed_off` persist on the member
 * row; `off_hours` is explicit availability; `unknown` is the honest default (e.g. never connected).
 */
export const OFFLINE_REASONS = [
  'reconnecting',
  'disconnected',
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
  /** Sticky reason stamped when presence ended (`disconnected` | `signed_off`). */
  lastOfflineReason?: OfflineReason | null;
}

/** Resolve offline_reason. Returns null while live. */
export function resolveOfflineReason(input: OfflineReasonInput): OfflineReason | null {
  if (input.live) return null;
  if (input.reclaimable) return 'reconnecting';
  if (input.availability?.status === 'off_hours') return 'off_hours';
  const sticky = input.lastOfflineReason;
  if (sticky === 'disconnected' || sticky === 'signed_off') return sticky;
  return 'unknown';
}
