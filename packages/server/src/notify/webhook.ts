import type { DoorbellRecord } from '@musterd/protocol';

/**
 * The generic `webhook` doorbell sink (ADR 443 §3) — the agnostic escape hatch: ntfy, Pushover, an
 * iOS Shortcut, anything that takes a POST. The body is the doorbell record as-is, which by schema
 * carries no message body. One attempt, 5 s abort, never throws; the caller detaches it from the
 * send path and audits `doorbell.surfaced`.
 */

/** How long we give the endpoint before abandoning the attempt (the send path never waits on it). */
export const WEBHOOK_POST_TIMEOUT_MS = 5_000;

export async function postDoorbellWebhook(
  url: string,
  record: DoorbellRecord,
): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(WEBHOOK_POST_TIMEOUT_MS),
      // A 3xx to a private host would walk around the PUT-time public-host check (ADR 443 §5).
      redirect: 'manual',
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}
