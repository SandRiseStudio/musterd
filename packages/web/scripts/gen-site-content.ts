/**
 * Build-prep content pipeline (ADR 302): render the docs manifest, the blog posts, and the
 * markdown to HTML strings in a generated module, so the client bundle carries no markdown
 * runtime. Runs before `vite build` (see package.json `build`).
 *
 * The repo-root roadmap dataset used to be rendered here too, for the public /roadmap page. That
 * page was retired on 2026-09-02 (nick): the roadmap lives in ROADMAP.md, in the repository, and
 * the public origin is the product. `content/roadmap.data.ts` stays — its other three consumers
 * (gen-roadmap, check-roadmap-truth, the steward drift scan) are what write ROADMAP.md.
 *
 * Invariants this script owns:
 *   - a manifest entry whose source file is missing FAILS the build (a publish decision must not
 *     silently produce a dead page);
 *   - a blog file without a YYYY-MM-DD- prefix FAILS the build (the date is the sort key);
 *   - every page must open with a `# ` heading (it becomes the page title).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { marked } from 'marked';
import { DOCS_MANIFEST } from '../content/docs.manifest.ts';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pkgRoot));
const OUT_DIR = join(pkgRoot, 'src', 'content', 'generated');
const OUT_FILE = join(OUT_DIR, 'site-content.ts');

export function parsePostFilename(name: string): { slug: string; date: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(name);
  return m ? { date: m[1]!, slug: m[2]! } : null;
}

/**
 * Wide content scrolls inside its own box, never the body. The spec's tables are wider than a
 * phone, and Prose.css had no `table` rule at all, so on 2026-08-24 /docs/spec measured a
 * scrollWidth of 686 against a 375px viewport — the whole document slid sideways. Found by
 * opening the page; the contrast sweep and every curl had been green on it for three days.
 *
 * The wrapper rather than `display:block` on the table itself: that would fix the overflow and
 * silently drop the table's semantics, which is the one thing a spec's tables need to keep.
 * `tabindex="0"` because a scroll box no keyboard can reach is a WCAG trap, and `role="region"`
 * with a name so that focus stop announces itself instead of arriving as a mystery.
 */
function wrapTables(html: string): string {
  return html.replace(
    /<table>[\s\S]*?<\/table>/g,
    (table) =>
      `<div class="prose__scroll" role="region" aria-label="Table" tabindex="0">${table}</div>`,
  );
}

export function renderPage(md: string): { title: string; html: string } {
  const m = /^#\s+(.+)$/m.exec(md);
  if (!m) throw new Error('page has no # heading to use as title');
  const title = m[1]!.trim();
  const html = (marked.parse(md.replace(m[0], ''), { async: false }) as string).trim();
  return { title, html: wrapTables(html) };
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  rsquo: '’',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  nbsp: ' ',
};

const MAX_DESCRIPTION = 160;

/**
 * The page's own meta/og description: its first paragraph as plain text. Without this every page
 * inherited the site tagline, which is what shipped on 2026-08-21 — measured on production, a
 * shared link to any page described the homepage.
 */
export function excerpt(html: string): string {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const first = /<p>([\s\S]*?)<\/p>/.exec(withoutComments);
  const text = (first ? first[1]! : withoutComments)
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= MAX_DESCRIPTION) return text;
  const cut = text.slice(0, MAX_DESCRIPTION - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).trimEnd()}…`;
}

function main() {
  const docsPages = DOCS_MANIFEST.map((entry) => {
    const path = join(repoRoot, entry.source);
    if (!existsSync(path)) {
      throw new Error(`docs manifest entry "${entry.slug}" points at missing file: ${entry.source}`);
    }
    const page = renderPage(readFileSync(path, 'utf8'));
    return {
      slug: entry.slug,
      title: entry.title ?? page.title,
      html: page.html,
      excerpt: excerpt(page.html),
      source: entry.source,
    };
  });

  const blogDir = join(pkgRoot, 'content', 'blog');
  const blogPosts = readdirSync(blogDir)
    .filter((n) => n.endsWith('.md'))
    .map((name) => {
      const parsed = parsePostFilename(name);
      if (!parsed) throw new Error(`blog post "${name}" must be named YYYY-MM-DD-<slug>.md`);
      const page = renderPage(readFileSync(join(blogDir, name), 'utf8'));
      return {
        slug: parsed.slug,
        date: parsed.date,
        title: page.title,
        html: page.html,
        excerpt: excerpt(page.html),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));


  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_FILE,
    [
      '/* GENERATED by scripts/gen-site-content.ts — do not edit. */',
      'export interface SitePage { slug: string; title: string; html: string; excerpt: string }',
      'export interface BlogPost extends SitePage { date: string }',
      `export const docsPages: (SitePage & { source: string })[] = ${JSON.stringify(docsPages, null, 2)};`,
      `export const blogPosts: BlogPost[] = ${JSON.stringify(blogPosts, null, 2)};`,
      '',
    ].join('\n'),
  );
  console.log(
    `gen-site-content: ${docsPages.length} docs page(s), ${blogPosts.length} blog post(s) → src/content/generated/site-content.ts`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
