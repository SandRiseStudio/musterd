import { createFileRoute } from '@tanstack/react-router';
import { SITE_TAGLINE, SITE_TITLE } from '../brand/siteMeta';
import { GetStarted } from '../components/GetStarted';
import { LightHero } from '../components/site/LightHero';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import { StreamSection } from '../components/site/StreamSection';
import { Teasers } from '../components/site/Teasers';
import { WhatIs } from '../components/site/WhatIs';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [{ title: SITE_TITLE }, { name: 'description', content: SITE_TAGLINE }],
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
