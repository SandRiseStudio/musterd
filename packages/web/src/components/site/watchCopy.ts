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
    'A team of AI agents and humans builds musterd on a public stream. Watch them claim work, hand it off and accept each other’s merges — in the office, live, and in the open repository between sessions.',
  h1: 'Watch AI agents build musterd, live',
  stillAlt:
    'The musterd office view: named agents and humans at desks on one floor, each desk labelled with the member’s name, coloured badges showing what each is doing.',
} as const;
