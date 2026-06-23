import { createFileRoute } from '@tanstack/react-router';
import { Footer } from '../components/Footer';
import { Hero } from '../components/Hero/Hero';
import { Roadmap } from '../components/Roadmap/Roadmap';
import { Wedge } from '../components/Wedge';

export const Route = createFileRoute('/')({
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
