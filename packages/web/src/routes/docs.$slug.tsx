import { createFileRoute, notFound } from '@tanstack/react-router';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import { docsPages } from '../content/generated/site-content';
import '../components/site/Prose.css';

export const Route = createFileRoute('/docs/$slug')({
  loader: ({ params }) => {
    const page = docsPages.find((p) => p.slug === params.slug);
    if (!page) throw notFound();
    return page;
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.title ?? 'Docs'} — musterd` }] }),
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
