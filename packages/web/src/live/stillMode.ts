/**
 * `?still` — MEASUREMENT MODE, read in one place.
 *
 * The contract, in one line: **the page keeps what it is showing instead of moving on.** Nothing is
 * hidden, nothing is repositioned, no content is skipped — every surface still paints exactly what
 * it would otherwise paint. What stops is the page's habit of advancing to the NEXT thing on a timer
 * of its own.
 *
 * ── Why a page-side flag at all (ADR 285) ───────────────────────────────────────────────────────
 *
 * The a11y contrast sweep settles, freezes rAF, screenshots once, and pairs every text row with the
 * pixel beneath it. Every part of that races anything the page does on a timer. contrast-sweep.mjs
 * accumulated six exclusion guards (moved, born, unsettled, invisible, clipped, covered) trying to
 * infer from OUTSIDE which rows were transient — and /office-preview still flipped red about 1 run
 * in 3. The page is the thing that knows what is transient, so the page says so. The six guards stay
 * as backstops; they are not deletions.
 *
 * ── What this must NOT become ───────────────────────────────────────────────────────────────────
 *
 * Not `?quiet`. That mode skips the choreography, so there are no speech bubbles to measure — and
 * the speech rows are exactly where the real failures on these routes have been found. A gate that
 * goes green by removing its subject is worse than a flaky one. Keep the subject, remove the motion.
 *
 * ── Who honours it, and why each one had to ─────────────────────────────────────────────────────
 *
 * Measured on /office-preview?still 2026-08-19 with an identity-keeping motion probe (lane
 * 01M0DSKEPDF4NYJ2JXM1GZGFNW). Three sources of movement, two of them permanent — and while ANY of
 * them re-arms, the page never settles and the sweep's own MEASURED MID-FLIGHT marker is lit on
 * every single run, which is how a true signal decays into noise nobody reads:
 *
 *   • The overlay reel (OfficeOverlay) auto-advanced every DWELL_MS=6000 forever. Past the 30s mark,
 *     144 of the 214 remaining DOM events were the reel's, on a flat 6s period.
 *   • The office's ambient micro-choreography (ADR 086 Phase 2) injects an idle beat every 30–70s
 *     forever. It is normally disabled under reduced motion — but /office-preview mounts the scene
 *     with `reduced: false` hardcoded, so on the one route the gate leans on hardest, it runs. A
 *     room that had been still for 115 seconds started walking again at 137s.
 *   • The asks-strip ticks a 1s interval to keep its countdowns honest.
 *
 * The script's own walks are deliberately NOT held: they drain on their own (~22s), they are the
 * subject being measured, and holding them would freeze the room half-assembled.
 *
 * Inert unless explicitly present, exactly like `?light=HH` beside it.
 */

/**
 * The pure reader — takes a search string so it is testable without a DOM (this repo's vitest
 * environment is `node`).
 *
 * `URLSearchParams.has` rather than a substring test, deliberately: `?stillwater` and `?distill`
 * must not turn a measurement mode on for a page someone is trying to watch move. Presence, not
 * value, so the gate's bare `&still` keeps working the day someone writes `&still=1`.
 */
export function isStill(search: string): boolean {
  try {
    return new URLSearchParams(search).has('still');
  } catch {
    /* A malformed search is a page that renders, not a page that white-screens — this is read on
       the mount path of every consumer. */
    return false;
  }
}

/** The same question against the live location. Safe under SSR/prerender, where there is no window. */
export function stillMode(): boolean {
  try {
    return isStill(window.location.search);
  } catch {
    return false; /* no window/search available (SSR, tests) — the page behaves normally */
  }
}
