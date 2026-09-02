import { createFileRoute, notFound } from '@tanstack/react-router';
import { GRAPH_ID, absoluteUrl, breadcrumbNode, pageHead } from '../brand/siteMeta';
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
  head: ({ loaderData, params }) =>
    pageHead({
      title: loaderData?.title ?? 'Docs',
      description: loaderData?.excerpt ?? 'musterd documentation.',
      path: `/docs/${params.slug}`,
      graph: [
        {
          '@type': 'TechArticle',
          headline: loaderData?.title ?? 'Docs',
          description: loaderData?.excerpt ?? 'musterd documentation.',
          url: absoluteUrl(`/docs/${params.slug}`),
          inLanguage: 'en',
          isPartOf: { '@id': GRAPH_ID.website },
          publisher: { '@id': GRAPH_ID.organization },
          about: { '@id': GRAPH_ID.software },
        },
        breadcrumbNode([
          { name: 'Docs', path: '/docs' },
          { name: loaderData?.title ?? 'Docs', path: `/docs/${params.slug}` },
        ]),
      ],
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
