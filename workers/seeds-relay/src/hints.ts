/**
 * Why a signature check failed, in the words of the mistake most likely to have caused it.
 *
 * **These are ADVISORY ONLY and must never gate.** By the time a hint is built, verification has
 * already decided to reject; all a hint does is choose the sentence printed alongside the 401.
 * Keeping them out of the accept/reject path is the load-bearing property: a wrong guess here costs
 * a misleading message, never a refused valid request — so the format claims below can be wrong
 * about a future Twilio or Slack without ever becoming a security or availability defect.
 *
 * That constraint is a precondition on every consumer of this module, not an implementation note
 * ([ADR 247](../../../docs/decisions/247-documented-discard-is-a-precondition.md)): a caller that
 * branches on a hint has converted a guess into a decision, which is precisely the thing these were
 * written to avoid. There are two callers, both in `index.ts`, and both only concatenate.
 *
 * Why they exist at all: the Twilio console page is titled "API keys & auth tokens", and only its
 * API keys tab has a button — so reaching for an API key when you want the Auth Token is the
 * *default* mistake, not an exotic one. It was made here on 2026-08-06 during the first deploy. The
 * resulting failure is a bare 401 that reads like a bad token rather than the wrong SPECIES of
 * token, which sends the reader to the network path instead of the console.
 */

/**
 * A Twilio **Auth Token** is 32 lowercase hex characters, and it is the HMAC-SHA1 key for the
 * `x-twilio-signature` header on inbound webhooks. An **API key secret** (the companion to an `SK…`
 * key) is 32 mixed-case alphanumerics and authenticates *outbound* REST calls — which this Worker
 * never makes. So a configured value that is not 32 hex characters cannot be an Auth Token.
 */
export function twilioTokenHint(token: string): string {
  if (!/^[0-9a-f]{32}$/.test(token)) {
    return (
      ' — the configured TWILIO_AUTH_TOKEN is not 32 hex characters, so it cannot be an Auth Token. ' +
      'If it came from the API keys tab it is an API key secret, which signs outbound REST calls, not ' +
      'inbound webhooks. Use Console → Account Info → Auth Token (no SK prefix).'
    );
  }
  return (
    ' — the token is correctly shaped, so suspect the URL instead: Twilio signs the FULL url it ' +
    'posted to, so a trailing slash, a query string, or http-vs-https will mismatch a correct token. ' +
    'The webhook must be exactly https://<worker>/ingest/twilio.'
  );
}

/**
 * A Slack **signing secret** is 32 hex characters. A bot/user token is `xoxb-`/`xoxp-`-prefixed and
 * is a bearer credential, not a signing key — the same species confusion as Twilio's, one vendor over.
 */
export function slackSecretHint(secret: string): string {
  if (/^xox[a-z]-/.test(secret)) {
    return (
      ' — the configured SLACK_SIGNING_SECRET looks like a bot token (xox…), not a signing secret. ' +
      'The signing secret is on Basic Information → App Credentials, not on OAuth & Permissions.'
    );
  }
  return (
    ' — the secret is correctly shaped, so suspect the request URL or a replayed body: Slack signs ' +
    'the exact raw body with the timestamp, so any proxy that rewrites the body will mismatch.'
  );
}
