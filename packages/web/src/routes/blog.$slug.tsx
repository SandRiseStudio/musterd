import { createFileRoute, notFound } from '@tanstack/react-router';
import {
  GRAPH_ID,
  absoluteUrl,
  breadcrumbNode,
  feedAlternate,
  markdownAlternate,
  pageHead,
} from '../brand/siteMeta';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import '../components/site/Prose.css';

export const Route = createFileRoute('/blog/$slug')({
  // SSR-only content load (ADR 302): the prerender runs this and dehydrates the result into the
  // page; the client build eliminates the branch, so the generated content module never ships as
  // client JS. Site nav uses plain <a> full navigations, so the client never runs this loader.
  loader: async ({ params }) => {
    if (!import.meta.env.SSR) throw notFound();
    const { blogPosts } = await import('../content/generated/site-content');
    const post = blogPosts.find((p) => p.slug === params.slug);
    if (!post) throw notFound();
    return post;
  },
  head: ({ loaderData, params }) =>
    pageHead({
      title: loaderData?.title ?? 'Blog',
      description: loaderData?.excerpt ?? 'Notes from the team building musterd.',
      path: `/blog/${params.slug}`,
      ogType: 'article',
      links: [markdownAlternate(`/blog/${params.slug}`), feedAlternate()],
      graph: [
        {
          '@type': 'BlogPosting',
          headline: loaderData?.title ?? 'Blog',
          description: loaderData?.excerpt ?? 'Notes from the team building musterd.',
          url: absoluteUrl(`/blog/${params.slug}`),
          inLanguage: 'en',
          // The filename date is the one freshness fact the site can state truthfully, the same
          // reason sitemap.xml carries lastmod on posts and nothing else (scripts/site-files.ts).
          ...(loaderData?.date ? { datePublished: loaderData.date } : {}),
          mainEntityOfPage: absoluteUrl(`/blog/${params.slug}`),
          isPartOf: { '@id': GRAPH_ID.website },
          author: { '@id': GRAPH_ID.organization },
          publisher: { '@id': GRAPH_ID.organization },
        },
        breadcrumbNode([
          { name: 'Blog', path: '/blog' },
          { name: loaderData?.title ?? 'Blog', path: `/blog/${params.slug}` },
        ]),
      ],
    }),
  component: Post,
});

function Post() {
  const post = Route.useLoaderData();
  return (
    <main className="site-page">
      <SiteNav />
      <article className="prose">
        <h1>{post.title}</h1>
        <p className="prose__date mono">{post.date}</p>
        {/* Build-time-rendered from our own markdown — trusted content, no user input. */}
        <div dangerouslySetInnerHTML={{ __html: post.html }} />
      </article>
      <SiteFooter />
    </main>
  );
}
