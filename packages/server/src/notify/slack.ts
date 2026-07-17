import type { AskSpecies, AskTier } from '@musterd/protocol';
import { askContract, askTierHolds } from '@musterd/protocol';

/**
 * Slack delivery for the ask stream (ADR 149) — the daemon's one outbound call. A team-policy
 * incoming-webhook URL (`ask_slack_webhook`, ADR 076 blob; unset = feature off) gets one
 * fire-and-forget POST per `ask` raised: the *loud* reach beside the guaranteed reach (the durable
 * message row + admin live-push, ADR 147 §3). Best-effort by design — no retry, no queue, and the
 * caller detaches it from the send path so a slow/dead Slack can neither delay nor fail a send.
 */

/** How long we give Slack before abandoning the attempt (the send path never waits on this). */
export const SLACK_POST_TIMEOUT_MS = 5_000;

/** The species verb, phrased at the human — mirrors the CLI notifier (`notify/select.ts` askVerb). */
function speciesVerb(from: string, species: AskSpecies | undefined): string {
  if (species === 'escalate') return `${from} escalated to you`;
  if (species === 'approve') return `${from} needs your approval`;
  return `${from} asks what you think`;
}

/** The tier contract in words — the same numbers the agent's clock reads (`ASK_TIER_DEFAULTS`). */
function tierClause(tier: AskTier | undefined): string {
  if (!tier) return '';
  const minutes = Math.round(askContract(tier).timeout_ms / 60_000);
  return askTierHolds(tier)
    ? ` (${tier} — holds after ${minutes}m without an answer)`
    : ` (${tier} — proceeds with recorded risk after ${minutes}m)`;
}

/**
 * The Slack message text for a raised ask. Bodies go to Slack by intent — this is delivery to the
 * human, not telemetry (ADR 051 governs traces; the recipient's inbox always carried bodies).
 */
export function formatAskSlackText(input: {
  team: string;
  from: string;
  species?: AskSpecies | undefined;
  tier?: AskTier | undefined;
  body: string;
}): string {
  const head = `[${input.team}] ${speciesVerb(input.from, input.species)}${tierClause(input.tier)}`;
  const body = input.body.trim();
  const answer = 'Answer on /live, or: musterd send --act accept --reply-to <ask id>';
  return body ? `${head}\n> ${body}\n${answer}` : `${head}\n${answer}`;
}

/**
 * POST the text to a Slack incoming webhook. Never throws: resolves `{ ok, status? }` for the
 * `ask.surfaced` audit row (ADR 149 — attempt + outcome, never the URL, never the body).
 */
export async function postSlackWebhook(
  url: string,
  text: string,
): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(SLACK_POST_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}
