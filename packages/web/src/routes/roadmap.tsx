import { createFileRoute, notFound } from '@tanstack/react-router';
import { pageMeta } from '../brand/siteMeta';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import '../components/site/Prose.css';

export const Route = createFileRoute('/roadmap')({
  // SSR-only content load (ADR 302) — see blog.$slug.tsx for the pattern's rationale. The ~82-item
  // roadmap dataset thus never rides the client bundle, honoring the move recorded in
  // src/content/site.ts.
  loader: async () => {
    if (!import.meta.env.SSR) throw notFound();
    const { roadmapSections } = await import('../content/generated/site-content');
    return roadmapSections;
  },
  head: () => ({
    meta: pageMeta({
      title: 'Roadmap',
      description:
        'What musterd has shipped and what is next — generated from the same source of truth as ROADMAP.md.',
      path: '/roadmap',
    }),
  }),
  component: Roadmap,
});

// The lightweight roadmap: ROADMAP.md remains the generated canonical document (ADR 041).
function Roadmap() {
  const sections = Route.useLoaderData();
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
        {sections.map((s) => (
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
