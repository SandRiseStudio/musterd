import { createFileRoute } from '@tanstack/react-router';
import {
  SITE_TAGLINE,
  SITE_TITLE,
  organizationNode,
  pageHead,
  softwareApplicationNode,
  webSiteNode,
} from '../brand/siteMeta';
import { GetStarted } from '../components/GetStarted';
import { LightHero } from '../components/site/LightHero';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import { StreamSection } from '../components/site/StreamSection';
import { Teasers } from '../components/site/Teasers';
import { WhatIs } from '../components/site/WhatIs';

export const Route = createFileRoute('/')({
  head: () =>
    pageHead({
      // The tagline, not the bare wordmark. `musterd` alone is a 7-character title that throws
      // away the one line of search result we get to write — and `pageTitle` suppresses the
      // suffix here because the name is already inside the tagline.
      title: `${SITE_TITLE} — ${SITE_TAGLINE}`,
      description: SITE_TAGLINE,
      path: '/',
      // The landing page is where the product's entity is declared; every other route's graph
      // points back at these three by @id rather than restating them.
      graph: [softwareApplicationNode(), webSiteNode(), organizationNode()],
      // The player iframe is injected post-paint (StreamSection); these hints are all the initial
      // load owes Twitch.
      links: [
        { rel: 'preconnect', href: 'https://player.twitch.tv' },
        { rel: 'preconnect', href: 'https://static.twitch.tv' },
        { rel: 'preconnect', href: 'https://assets.twitch.tv' },
      ],
    }),
  component: Home,
});

function Home() {
  return (
    <main className="site-page">
      <SiteNav />
      <LightHero />
      <StreamSection />
      <WhatIs />
      <GetStarted />
      <Teasers />
      <SiteFooter />
    </main>
  );
}
