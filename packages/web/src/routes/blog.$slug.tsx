import { createFileRoute, notFound } from '@tanstack/react-router';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import { blogPosts } from '../content/generated/site-content';
import '../components/site/Prose.css';

export const Route = createFileRoute('/blog/$slug')({
  loader: ({ params }) => {
    const post = blogPosts.find((p) => p.slug === params.slug);
    if (!post) throw notFound();
    return post;
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.title ?? 'Blog'} — musterd` }] }),
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
