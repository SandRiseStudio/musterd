import { createFileRoute } from '@tanstack/react-router';
import { Footer } from '../components/Footer';
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
      {/* GetStarted (the install section) is built but HIDDEN — nick, 2026-08-13: not polished
          enough to ship. The component and its styles stay in the tree; re-render it here when the
          polish lands. The wedge/"How priorities are decided" section was removed the same day. */}
      <Footer />
    </main>
  );
}
