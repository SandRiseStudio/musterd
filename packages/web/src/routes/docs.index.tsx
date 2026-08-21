import { createFileRoute } from '@tanstack/react-router';
import { SiteFooter } from '../components/site/SiteFooter';
import { SiteNav } from '../components/site/SiteNav';
import { docsPages } from '../content/generated/site-content';
import '../components/site/Prose.css';

export const Route = createFileRoute('/docs/')({
  head: () => ({ meta: [{ title: 'Docs — musterd' }] }),
  component: DocsIndex,
});

function DocsIndex() {
  return (
    <main className="site-page">
      <SiteNav />
      <section className="prose">
        <h1>Docs</h1>
        <ul className="prose__list">
          {docsPages.map((p) => (
            <li key={p.slug}>
              <a href={`/docs/${p.slug}`}>{p.title}</a>
            </li>
          ))}
        </ul>
      </section>
      <SiteFooter />
    </main>
  );
}
