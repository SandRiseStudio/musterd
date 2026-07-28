import { randomBytes } from 'node:crypto';

/**
 * The sign-in handoff relay (ADR 170) — how `musterd board` walks a human into the browser without
 * either of them touching a credential.
 *
 * The CLI already holds the member's `mscr_`; the browser needs it. Rather than putting that secret
 * in a URL (permanently valuable, lands in history, survives being texted to a phone), the CLI stages
 * it here and gets back a **nonce**: an opaque handle to a one-time relay, expiring in a minute,
 * deleted on first read. The nonce is what rides the fragment. After redemption — or after the TTL,
 * whichever comes first — the string in the address bar is worth nothing.
 *
 * Memory-only on purpose. A handoff older than {@link HANDOFF_TTL_MS} is void, so there is nothing
 * about one worth surviving a daemon restart; keeping it out of the schema also keeps the credential
 * out of a second place on disk.
 */

/** How long a staged handoff lives. Long enough for a browser to launch, short enough to be inert. */
export const HANDOFF_TTL_MS = 60_000;

/** Upper bound on pending handoffs — a staging loop can never grow the map without limit. */
const MAX_PENDING = 64;

interface Pending {
  team: string;
  member: string;
  credential: string;
  expires_at: number;
}

const pending = new Map<string, Pending>();

/** Drop everything expired. Called on every write, so the map self-limits without a timer. */
function sweep(now: number): void {
  for (const [nonce, entry] of pending) {
    if (entry.expires_at <= now) pending.delete(nonce);
  }
}

/**
 * Stage a credential for one browser pickup. The caller must already have proven it holds this
 * member's credential — this relay grants no authority, it only moves one the caller had.
 */
export function stageHandoff(input: { team: string; member: string; credential: string }): {
  nonce: string;
  expires_in_ms: number;
} {
  const now = Date.now();
  sweep(now);
  // Cap by age, oldest first, so a burst of staging can't evict a handoff someone is mid-redeeming.
  if (pending.size >= MAX_PENDING) {
    const oldest = [...pending.entries()].sort((a, b) => a[1].expires_at - b[1].expires_at)[0];
    if (oldest) pending.delete(oldest[0]);
  }
  const nonce = randomBytes(24).toString('base64url');
  pending.set(nonce, { ...input, expires_at: now + HANDOFF_TTL_MS });
  return { nonce, expires_in_ms: HANDOFF_TTL_MS };
}

/**
 * Redeem a nonce exactly once. Deletes before returning, so a double-open (or a retry) gets the same
 * answer a stranger would: nothing. Team-scoped — a nonce is only valid on the team it was staged
 * for, and a wrong-team attempt does not burn it.
 */
export function redeemHandoff(
  team: string,
  nonce: string,
): { as: string; credential: string } | null {
  const entry = pending.get(nonce);
  if (!entry || entry.team !== team) return null;
  pending.delete(nonce);
  if (entry.expires_at <= Date.now()) return null;
  return { as: entry.member, credential: entry.credential };
}

/** Test seam: drop all pending handoffs (the relay is module state by design). */
export function __resetHandoffs(): void {
  pending.clear();
}
