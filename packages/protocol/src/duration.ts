/**
 * The one way musterd says "how long" in a rendered line — `45s`, `12m`, `3h`, `5d`.
 *
 * It lives here because the alternative was measured, twice, in the same week:
 *
 * - #856 moved the incident banner's WORDS into `@musterd/protocol` so two surfaces could not
 *   drift, and brought a private `shortFor` along with them. That copy had no day bucket, so the
 *   MCP banner silently went from `open 5d` to `open 120h`. Under 24h the two agree exactly, and
 *   every fixture was minutes and hours, so nothing failed.
 * - The `waitedFor` it replaced existed twice already — byte-identical in `mcp/tools/lanes.ts` and
 *   `cli/commands/next.ts` — which is two more chances at the same silence.
 *
 * That is ADR 084's failure mode arriving one level down: a shared derivation whose *rendering*
 * forks. ADR 278 answered it for the banner's sentences; a duration is a sentence too. So there is
 * one function, exported, and a surface gets it by importing rather than by remembering.
 *
 * Semantics are the union of the two copies, because each had one thing right:
 * - the day bucket, from `waitedFor` — the incident you most need to read at a glance is the one
 *   open longest, and hours stop being legible about a day in;
 * - the clamp at zero, from `shortFor` — a duration is two clocks subtracted, and a daemon's
 *   `opened_at` against a seat's `Date.now()` can land backwards. `-3s` reads as a bug in the thing
 *   being described rather than in the arithmetic.
 *
 * Deliberately coarse: one unit, no `1h 5m`. These appear inside dense one-line summaries where the
 * magnitude is the message and the precision is not.
 */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}d`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h`;
  if (s >= 60) return `${Math.floor(s / 60)}m`;
  return `${s}s`;
}
