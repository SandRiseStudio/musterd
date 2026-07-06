import { createFileRoute } from '@tanstack/react-router';
import { Footer } from '../components/Footer';
import { Hero } from '../components/Hero/Hero';
import { Roadmap } from '../components/Roadmap/Roadmap';
import { Wedge } from '../components/Wedge';
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
      <Roadmap />
      <Wedge />
      <Footer />
    </main>
  );
}
