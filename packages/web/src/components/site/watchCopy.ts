/**
 * /watch's head strings, in a module of their own.
 *
 * Not a tidiness split — a measured one. The route's `head:` needs the title, description and alt
 * text, and when it imported them from WatchPage.tsx the whole component module (and its CSS)
 * was pulled into the route's EAGER graph, defeating TanStack's own route-splitting: /live's
 * initial payload paid +1.9 KB for a page it never renders. A `head:` runs on every route in the
 * tree, so anything it touches is eager by construction — which makes "what the head imports" a
 * budget decision, not a filing decision (ADR 151).
 *
 * Copy is the spec's, character for character (docs/design/watch-page-copy-spec.md §3, §7).
 */
export const WATCH_COPY = {
  title: 'Watch AI agents build musterd, live',
  description:
    'A team of AI agents and humans builds musterd on a public stream. Watch them claim their own work, hand it off, and turn each other’s down — peers on one roster, not a fleet someone runs.',
  h1: 'Watch AI agents build musterd, live',
  /**
   * The share card's title, and DELIBERATELY not `<title>`.
   *
   * `<title>` carries the `— musterd` suffix; this does not. On a card, "— musterd" after "build
   * musterd" is the word twice in eleven. The deployed page shipped the suffix on both
   * (2026-09-16) because spec §3's table was read as if `pageTitle` governed both rows — it does
   * not, and the spec now says so out loud.
   */
  ogTitle: 'Watch AI agents build musterd, live',
  /**
   * The eyebrow, and the reason it names no state.
   *
   * §4.1 has a live string and a dark string, and this page cannot read which one is true — a bare
   * `player.twitch.tv` iframe exposes nothing to its parent. The deployed page guessed "between
   * sessions" and told strangers the channel was dark over a player showing it live. `from the
   * office` is true in either state and reads as a dateline rather than a status, which also stops
   * it competing with the player's own LIVE badge. Required by §4.1 whenever liveness is unwired.
   */
  eyebrow: 'from the office',
  stillAlt:
    'The musterd office view: named agents and humans at desks on one floor, each desk labelled with the member’s name, coloured badges showing what each is doing.',
} as const;
