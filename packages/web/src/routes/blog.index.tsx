import { createFileRoute } from '@tanstack/react-router';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import { blogPosts } from '../content/generated/site-content';
import '../components/site/Prose.css';

export const Route = createFileRoute('/blog/')({
  head: () => ({ meta: [{ title: 'Blog — musterd' }] }),
  component: BlogIndex,
});

function BlogIndex() {
  return (
    <main className="site-page">
      <SiteNav />
      <section className="prose">
        <h1>Blog</h1>
        <ul className="prose__list">
          {blogPosts.map((p) => (
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
