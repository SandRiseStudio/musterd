/**
 * The marketing page's own copy — the two strings the landing page actually renders.
 *
 * These used to live at the bottom of `roadmap.data.ts`, back when that module was a web module and
 * the landing page's centrepiece was the roadmap map. The map is gone (nick, 2026-07-28: "drop the
 * roadmap from the web UI") and the data moved out to `content/roadmap.data.ts` at the repo root,
 * where its three real consumers — `gen-roadmap`, `check-roadmap-truth`, and the steward drift scan
 * — already were. Everything they need is a build-time concern.
 *
 * Leaving TAGLINE and WEDGE behind in that module would have dragged all ~82 roadmap items back into
 * the browser bundle to render two paragraphs, which is the whole cost the move exists to avoid. So
 * they live here, in the package that renders them, and `gen-roadmap` imports WEDGE from here — one
 * source of truth, pulled toward the consumer that is picky about bytes rather than the one that is
 * not.
 */

export interface Ref {
  label: string;
  href: string;
}

const REPO = 'https://github.com/SandRiseStudio/musterd/blob/main';
const doc = (path: string, label: string): Ref => ({ label, href: `${REPO}/${path}` });

/**
 * The prioritisation note, rendered into ROADMAP.md by `pnpm roadmap:gen`.
 *
 * NO LONGER ON THE HOMEPAGE (cut 2026-09-16, lane 01M2NS50HC — see WhatIs.tsx for why). Its reader
 * is a contributor deciding what to work on, not a stranger deciding whether to install. Kept here
 * rather than moved because `gen-roadmap` imports it and this package is the one that is picky
 * about bytes; it costs the bundle nothing now that no component references it.
 *
 * The 79% names MAST and links it. It did not, and on a public page that made a third party's
 * failure taxonomy read as our own measurement — the move ADR 320's "what this is not" forbids.
 * A borrowed number carries its source wherever it is rendered, including in our own repo.
 */
export const WEDGE = {
  heading: 'How priorities are decided',
  body: 'The wedge is persistent teams with identity, presence, and humans as peers — the coordination layer where MAST (arXiv 2503.13657) attributes about 79% of multi-agent failures, across other teams\u2019 systems rather than ours. Work is weighed by whether it strengthens that layer, not by adding more agents or more orchestration. Human partnership ranks first, on evidence: collaborative agents beat fully autonomous ones on real-user preference, and removing the notification protocol more than halves the win rate.',
  refs: [
    { label: 'MAST (arXiv 2503.13657)', href: 'https://arxiv.org/abs/2503.13657' },
    doc('ROADMAP.md', 'ROADMAP.md'),
    doc('docs/design/research-foundation.md', 'research-foundation.md'),
    doc('docs/design/landscape.md', 'landscape.md'),
  ] as Ref[],
};

export const TAGLINE = 'Muster your agents and humans into persistent teams.';
