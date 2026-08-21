import { createFileRoute } from '@tanstack/react-router';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import { roadmapSections } from '../content/generated/site-content';
import '../components/site/Prose.css';

export const Route = createFileRoute('/roadmap')({
  head: () => ({ meta: [{ title: 'Roadmap — musterd' }] }),
  component: Roadmap,
});

// The lightweight roadmap (ADR 300): the repo-root roadmap data rendered to HTML at build-prep
// time, so the ~82-item dataset never rides the client bundle. ROADMAP.md remains the generated
// canonical document (ADR 041).
function Roadmap() {
  return (
    <main className="site-page">
      <SiteNav />
      <article className="prose">
        <h1>Roadmap</h1>
        <p>
          Generated from the same source of truth as{' '}
          <a href="https://github.com/SandRiseStudio/musterd/blob/main/ROADMAP.md">ROADMAP.md</a>,
          which carries the full build sequence and per-item references.
        </p>
        {roadmapSections.map((s) => (
          <section key={s.status}>
            <h2>{s.label}</h2>
            {/* Build-time-rendered from content/roadmap.data.ts — trusted content, no user input. */}
            <div dangerouslySetInnerHTML={{ __html: s.html }} />
          </section>
        ))}
      </article>
      <SiteFooter />
    </main>
  );
}
