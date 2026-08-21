import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');

describe('public content routes', () => {
  for (const f of ['roadmap.tsx', 'docs.index.tsx', 'docs.$slug.tsx', 'blog.index.tsx', 'blog.$slug.tsx']) {
    it(`${f} renders site chrome and generated content only`, () => {
      const src = read(`./${f}`);
      expect(src).toContain('SiteNav');
      expect(src).toContain('SiteFooter');
      expect(src, 'content routes must not touch daemon modules').not.toMatch(/from '\.\.\/live\//);
    });
  }
  // Shipped 2026-08-21 and measured on production: every page inherited __root.tsx's og:* verbatim,
  // so /blog/launch/ advertised og:url https://musterd.io and og:title "musterd". A shared link to
  // any page described the homepage. pageMeta() is what gives a page its own identity.
  for (const f of ['roadmap.tsx', 'docs.index.tsx', 'docs.$slug.tsx', 'blog.index.tsx', 'blog.$slug.tsx']) {
    it(`${f} sets its own page metadata rather than inheriting the root's`, () => {
      const src = read(`./${f}`);
      expect(src).toContain('pageMeta(');
      expect(src, 'a bare title inherits the root og:*').not.toMatch(/meta:\s*\[\{\s*title/);
    });
  }

  it('slug routes prerender from the generated lists', () => {
    expect(read('./docs.$slug.tsx')).toContain('docsPages');
    expect(read('./blog.$slug.tsx')).toContain('blogPosts');
  });
});
