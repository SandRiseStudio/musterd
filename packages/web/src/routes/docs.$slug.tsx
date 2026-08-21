import { createFileRoute, notFound } from '@tanstack/react-router';
import { pageMeta } from '../brand/siteMeta';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import '../components/site/Prose.css';

export const Route = createFileRoute('/docs/$slug')({
  // SSR-only content load (ADR 302) — see blog.$slug.tsx for the pattern's rationale.
  loader: async ({ params }) => {
    if (!import.meta.env.SSR) throw notFound();
    const { docsPages } = await import('../content/generated/site-content');
    const page = docsPages.find((p) => p.slug === params.slug);
    if (!page) throw notFound();
    return page;
  },
  head: ({ loaderData, params }) => ({
    meta: pageMeta({
      title: loaderData?.title ?? 'Docs',
      description: loaderData?.excerpt ?? 'musterd documentation.',
      path: `/docs/${params.slug}`,
    }),
  }),
  component: Doc,
});

function Doc() {
  const page = Route.useLoaderData();
  return (
    <main className="site-page">
      <SiteNav />
      <article className="prose">
        <h1>{page.title}</h1>
        {/* Build-time-rendered from the docs manifest — trusted content, no user input. */}
        <div dangerouslySetInnerHTML={{ __html: page.html }} />
      </article>
      <SiteFooter />
    </main>
  );
}
