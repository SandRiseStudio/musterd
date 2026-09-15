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
      title: SITE_TITLE,
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
