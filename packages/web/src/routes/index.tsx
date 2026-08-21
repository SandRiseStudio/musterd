import { createFileRoute } from '@tanstack/react-router';
import { SITE_TAGLINE, SITE_TITLE } from '../brand/siteMeta';
import { GetStarted } from '../components/GetStarted';
import { LightHero } from '../components/site/LightHero';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import { Teasers } from '../components/site/Teasers';
import { WhatIs } from '../components/site/WhatIs';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [{ title: SITE_TITLE }, { name: 'description', content: SITE_TAGLINE }],
  }),
  component: Home,
});

function Home() {
  return (
    <main>
      <SiteNav />
      <LightHero />
      <WhatIs />
      <GetStarted />
      <Teasers />
      <SiteFooter />
    </main>
  );
}
