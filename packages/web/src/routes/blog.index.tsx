import { createFileRoute, notFound } from '@tanstack/react-router';
import {
  absoluteUrl,
  breadcrumbNode,
  feedAlternate,
  itemListNode,
  pageHead,
} from '../brand/siteMeta';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import '../components/site/Prose.css';

export const Route = createFileRoute('/blog/')({
  // SSR-only content load (ADR 302) — see blog.$slug.tsx for the pattern's rationale.
  loader: async () => {
    if (!import.meta.env.SSR) throw notFound();
    const { blogPosts } = await import('../content/generated/site-content');
    return blogPosts.map(({ slug, title, date }) => ({ slug, title, date }));
  },
  head: ({ loaderData }) =>
    pageHead({
      title: 'Blog',
      description: 'Launch notes and what the team learns building musterd — with musterd.',
      path: '/blog',
      links: [feedAlternate()],
      graph: [
        {
          '@type': 'CollectionPage',
          name: 'Blog',
          url: absoluteUrl('/blog'),
        },
        itemListNode((loaderData ?? []).map((p) => ({ name: p.title, path: `/blog/${p.slug}` }))),
        breadcrumbNode([{ name: 'Blog', path: '/blog' }]),
      ],
    }),
  component: BlogIndex,
});

function BlogIndex() {
  const posts = Route.useLoaderData();
  return (
    <main className="site-page">
      <SiteNav />
      <section className="prose">
        <h1>Blog</h1>
        <ul className="prose__list">
          {posts.map((p) => (
            <li key={p.slug}>
              <a href={`/blog/${p.slug}`}>{p.title}</a>
              <p className="prose__date mono">{p.date}</p>
            </li>
          ))}
        </ul>
      </section>
      <SiteFooter />
    </main>
  );
}
