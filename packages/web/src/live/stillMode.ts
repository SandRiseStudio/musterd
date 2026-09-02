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
 * Both flags below are presence tests over the query string, and they share this reader for a
 * reason beyond tidiness: they ship in /live's EAGER graph, where the budget is measured in
 * hundreds of bytes (ADR 183). Two hand-rolled copies of the same try/catch is a duplication the
 * viewer pays for.
 *
 * `URLSearchParams.has` rather than a substring test, deliberately: `?stillwater` and `?distill`
 * must not turn a measurement mode on for a page someone is trying to watch move. Presence, not
 * value, so the gate's bare `&still` keeps working the day someone writes `&still=1`.
 *
 * A malformed search is a page that renders, not a page that white-screens — this is read on the
 * mount path of every consumer.
 */
function hasFlag(search: string, name: string): boolean {
  try {
    return new URLSearchParams(search).has(name);
  } catch {
    return false;
  }
}

/**
 * The same question against the live location, for either flag. Safe under SSR/prerender, where
 * there is no window.
 */
function flagHere(name: string): boolean {
  try {
    return hasFlag(window.location.search, name);
  } catch {
    return false; /* no window/search available (SSR, tests) — the page behaves normally */
  }
}

/** The pure reader — takes a search string so it is testable without a DOM (vitest runs `node`). */
export const isStill = (search: string): boolean => hasFlag(search, 'still');

export const stillMode = (): boolean => flagHere('still');

/**
 * `?asks-open` — MEASUREMENT MODE for a surface that is closed by default.
 *
 * Same bargain as `?still` above and the same reason for existing page-side: the sweep can only
 * measure what is RENDERED, and it skips anything at `visibility: hidden` or `opacity: 0`
 * (contrast-sweep.mjs:570). The asks sheet is both while closed, so **every card in it has always
 * gone unmeasured** — the lapsed note this flag was added for, and equally the deferred note and
 * the answer buttons that predate it. A gate that has never seen a surface is not a gate that
 * approved it.
 *
 * The alternative was to have the sweep click the "see all" button. Rejected on the ADR 285
 * argument, which applies here unchanged: driving a page from outside means inferring when it has
 * finished opening, and the sweep already carries six guards' worth of that inference. The page
 * knows whether its sheet is open. It can simply say so, and land in the DOM open on the first
 * paint with no transition to race.
 *
 * Scope: it sets the sheet's INITIAL state only. The reader can still close it, and nothing else
 * about the strip changes — same cards, same copy, same inks.
 */
export const isAsksOpen = (search: string): boolean => hasFlag(search, 'asks-open');

export const asksOpenMode = (): boolean => flagHere('asks-open');

/**
 * `?plates-open` — MEASUREMENT MODE for ink that only exists inside a control nobody clicked.
 *
 * Third of the same bargain as `?still` and `?asks-open` above, and the gap it closes is the widest
 * of the three. The nameplate's harness segment carries its own per-harness ink
 * (`--lc-hz-{codex,cursor,grok,opencode}-ink`, Live.css) and lives in the plate's expanded DETAIL —
 * a `0fr` grid track whose segments are `opacity: 0` until a viewer clicks the plate open. The sweep
 * skips both zero-opacity and clipped rows, so all four inks have shipped since ADR 352 **without
 * the contrast gate ever once measuring them**. On /broadcast the detail is permanently open but
 * `plateDetailParts` is filtered to the model crumb there, so that route never renders the segment
 * either. There was no state, on any route, in which a harness ink could be measured.
 *
 * The alternative was to have the sweep click every plate. Rejected on the ADR 285 argument
 * unchanged, and more sharply here: the expand is a 300ms grid-template-columns transition with a
 * per-segment stagger of `90ms + i * 50ms`, so driving it from outside means inferring when twenty
 * plates have all finished unpacking — the exact inference the sweep already carries six guards'
 * worth of. The page knows. It can simply mount them open, with no transition to race.
 *
 * Scope: it sets each plate's INITIAL expanded state only. The viewer can still collapse any plate,
 * the toggle behaves normally, and nothing else about the plate changes — same segments, same copy,
 * same inks. It is inert on /broadcast, whose plates are not interactive and never carry the seg.
 */
export const isPlatesOpen = (search: string): boolean => hasFlag(search, 'plates-open');

export const platesOpenMode = (): boolean => flagHere('plates-open');
