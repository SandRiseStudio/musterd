import { createFileRoute } from '@tanstack/react-router';
import { SITE_TAGLINE, SITE_TITLE } from '../brand/siteMeta';
import { Footer } from '../components/Footer';
import { GetStarted } from '../components/GetStarted';
import { Hero } from '../components/Hero/Hero';
import liveCss from '../live/Live.css?url';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [{ title: SITE_TITLE }, { name: 'description', content: SITE_TAGLINE }],
    links: [{ rel: 'stylesheet', href: liveCss }],
  }),
  component: Home,
});

function Home() {
  return (
    <main>
      <Hero />
      <GetStarted />
      <Footer />
    </main>
  );
}
