import { createFileRoute } from '@tanstack/react-router';
import {
  SITE_TITLE,
  breadcrumbNode,
  broadcastEventNode,
  pageHead,
  webPageNode,
} from '../brand/siteMeta';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import { WatchPage } from '../components/site/WatchPage';
import { WATCH_COPY } from '../components/site/watchCopy';
import officeStill from '../brand/office-still.png?url';

/**
 * The stream's front door (copy spec: docs/design/watch-page-copy-spec.md).
 *
 * Public and prerendered like /docs, with no daemon behind it — the surfaces that ARE the office
 * (/live, /broadcast, the scene itself) stay off this origin by design (ADR 132, ADR 156). This
 * page is a window onto them, which is why it can be static: a Twitch embed and prose.
 *
 * Every string here is in the spec character for character. It exists because no page on the
 * domain was about watching agents build — measured 2026-09-16, the home page gave the stream one
 * section and a link — and a search engine cannot rank a domain for a phrase no page is about.
 */
export const Route = createFileRoute('/watch')({
  head: () =>
    pageHead({
      // The suffix is written in rather than left to `pageTitle`, and that is deliberate.
      // `pageTitle` drops it when the name is already in the title — the right rule for the launch
      // post ("musterd: … — musterd") and for the home page, but here "musterd" appears mid-sentence
      // as the OBJECT being built, so the rule over-triggers and costs the tag. The spec pins the
      // 45-character form (§3, with its own length check), so it is stated; `pageTitle` still runs
      // and is now a no-op, which is what the spec's "via pageTitle" asks for.
      title: `${WATCH_COPY.title} — ${SITE_TITLE}`,
      description: WATCH_COPY.description,
      path: '/watch',
      // The office, not the wordmark card: this page is about a picture, and the generic card
      // would unfurl it as the one thing it is not about.
      image: { url: officeStill, alt: WATCH_COPY.stillAlt },
      graph: [
        webPageNode({
          name: WATCH_COPY.h1,
          description: WATCH_COPY.description,
          path: '/watch',
        }),
        broadcastEventNode(),
        breadcrumbNode([{ name: 'Watch', path: '/watch' }]),
      ],
      // The player iframe is injected post-paint; these hints are all the initial load owes Twitch.
      links: [
        { rel: 'preconnect', href: 'https://player.twitch.tv' },
        { rel: 'preconnect', href: 'https://static.twitch.tv' },
        { rel: 'preconnect', href: 'https://assets.twitch.tv' },
      ],
    }),
  component: Watch,
});

function Watch() {
  return (
    <main className="site-page">
      <SiteNav />
      <WatchPage />
      <SiteFooter />
    </main>
  );
}
