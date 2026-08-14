import { createFileRoute } from '@tanstack/react-router';
import { Footer } from '../components/Footer';
import { GetStarted } from '../components/GetStarted';
import { Hero } from '../components/Hero/Hero';
import liveCss from '../live/Live.css?url';

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [{ title: 'musterd' }],
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
