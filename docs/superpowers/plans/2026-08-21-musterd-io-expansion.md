# musterd.io Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **musterd override (user CLAUDE.md):** subagent execution is disabled on this machine — the lane owner (miley, lane 01M0JVEWAGK3Q59RHPGRZ0E9DQ) implements inline.

**Goal:** Expand musterd.io from one landing page to a public multi-page site: new lightweight hero, embedded Twitch broadcast section, lightweight `/roadmap`, hybrid `/docs`, and a real `/blog`.

**Architecture:** All public pages are prerendered static HTML on the existing assets-only Worker. Markdown and roadmap data are rendered to HTML strings by a build-prep script (`gen-site-content.ts`) into a generated TS module, so no markdown runtime and no roadmap dataset ever reach the client bundle. The Twitch player is a static facade in prerendered HTML; an IntersectionObserver swaps in the real iframe post-paint.

**Tech Stack:** TanStack Start v1 (React 19, Vite 8) prerender, `marked` (devDependency, build-time only), Cloudflare assets-only Worker.

**Spec:** `docs/superpowers/specs/2026-08-21-musterd-io-expansion-design.md`

## Global Constraints

- Byte budgets (`pnpm perf:check`, docs/perf/budgets.json): initial 152000, total 241000, chunk 112000, CSS 26400, fonts 653000 gzip bytes. Retiring the canvas hero should LOWER totals; a raise needs its own justification + log entry (ADR 151/183).
- Fonts: only `inter`, `space-grotesk`, `space-mono`. No new families or weights.
- Daemon-connected routes (`/live`, `/board`, `/audit`, `/approvals`, `/broadcast`, `/character-sheet`, `/office-preview`) must NEVER reach `dist/site` (ADR 132/156).
- Colour via defined tokens; `pnpm tokens:check` and `pnpm a11y:check` must pass. Amber fills (`--lc-warn`) are never text; `-ink` variants are.
- Twitch channel: `sandrise_ai`. Embed URL host: `player.twitch.tv`; `parent` param = embedding hostname; `muted=true`.
- No client-side markdown rendering; no new render loops; no iframe element in prerendered HTML.
- Copy authored here is placeholder-grade and marked `{/* [SLOANE] */}` or `<!-- [SLOANE] -->`; real prose is the sloane seat's follow-up lane. Existing real copy (TAGLINE, WEDGE, GetStarted) is reused untouched.
- This repo runs TS scripts directly with `node` (v22 type stripping); test runner is vitest at the repo root; there is NO DOM test rig — component behavior is asserted against source (see `src/routes/broadcast.stage.test.ts` for the pattern).
- Commit trailer on every commit:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + `Claude-Session: https://claude.ai/code/session_01XqxoAPwBrLRpQM8ze7pWgD`

## Premise corrections vs the spec (discovered reading the code, 2026-08-21)

The spec inherited two stale premises from `packages/web/README.md`; intent is unchanged, work is smaller:

1. **There is no three.js to retire.** The immersive roadmap map was dropped from the web on 2026-07-28; three.js/anime.js are not in `packages/web/package.json`. Today's hero (`src/components/Hero/`) is a 2D-canvas office scene over a synthetic 5-member team. "New lightweight hero" = replace that canvas hero with a typographic one.
2. **`/roadmap` is a new page, not a move.** Roadmap data lives at repo-root `content/roadmap.data.ts` (82 items, build-time consumers only). The new `/roadmap` renders it via the build-prep pipeline — the dataset stays out of the browser bundle, honoring the comment in `src/content/site.ts` that moved it out.
3. The nav live-badge's "trivially available" check does not exist (Twitch's Helix API needs an auth token; there is no public unauthenticated liveness endpoint). Per the spec's else-branch it is dropped; the player itself communicates liveness.

Task 1 records these in the spec.

---

### Task 1: Spec corrections, stale README, and ADR 300

**Files:**
- Modify: `docs/superpowers/specs/2026-08-21-musterd-io-expansion-design.md`
- Modify: `packages/web/README.md`
- Create: `docs/decisions/300-musterd-io-public-site.md`

**Interfaces:**
- Produces: ADR 300 (referenced by later commit messages and the wrangler comment in Task 7).

- [ ] **Step 1: Append a "Premise corrections" section to the spec** — copy the three numbered corrections above verbatim under a `## Premise corrections (2026-08-21, post-approval)` heading, noting nick approved the intent and the corrections only shrink the work.

- [ ] **Step 2: Fix `packages/web/README.md`** — replace the three.js/anime.js hero description ("**three.js** + the **anime.js Three.js adapter** — the immersive hero…") with the current truth (2D-canvas office-scene hero, being replaced by the typographic hero in this change), and update the "serves one page — the roadmap" intro to describe the multi-page public site (/, /roadmap, /docs, /blog public; daemon surfaces excluded).

- [ ] **Step 3: Write ADR 300** at `docs/decisions/300-musterd-io-public-site.md`, following the house format of ADR 298 (check its header fields and mirror them). Content: (a) musterd.io grows from one landing route to the public set `/`, `/roadmap`, `/docs/**`, `/blog/**`; (b) the landing hero changes from the canvas office scene to a typographic hero — amends ADR 037's hero treatment, the aesthetic direction (warm mustard palette, type-led, honest copy per brand.md) stands; (c) the public-route allowlist in `stage-site.mjs` is the origin's safety property — adding a route to it is a deploy decision recorded in that file, daemon surfaces stay excluded (reaffirms ADR 132/156); (d) markdown/roadmap content is rendered to HTML at build-prep time — no markdown runtime in the client; (e) the Twitch broadcast embeds on `/` as a deferred, visibility-gated iframe (channel sandrise_ai), muted autoplay, never in the prerendered HTML.

- [ ] **Step 4: Run the docs gate** — `pnpm format:check` (fix anything it flags; it enforces ADR house rules).

- [ ] **Step 5: Commit** — `git add -A docs packages/web/README.md && git commit -m "docs: ADR 300 — musterd.io public site; correct stale web premises"` (+ trailers).

---

### Task 2: Shared site chrome — SiteNav, SiteFooter, site.css

**Files:**
- Create: `packages/web/src/components/site/SiteNav.tsx`
- Create: `packages/web/src/components/site/SiteFooter.tsx`
- Create: `packages/web/src/components/site/site.css`
- Test: `packages/web/src/components/site/site.test.ts`

**Interfaces:**
- Consumes: `SITE_TITLE` etc. from `../../brand/siteMeta`; `MusterdChip` from `../../brand/MusterdWord` (verify the export name in that file before importing; if it exports `MusterdWord` instead, use that).
- Produces: `SiteNav()` and `SiteFooter()` React components (no props); `NAV_LINKS: { label: string; href: string }[]` exported from `SiteNav.tsx`. Every public route (Tasks 4–6) renders `<SiteNav />` first and `<SiteFooter />` last.

- [ ] **Step 1: Write the failing test** (`site.test.ts`) — source-assertion style, plus the one pure export:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV_LINKS } from './SiteNav';

describe('site nav', () => {
  it('links every public surface and GitHub, nothing daemon-connected', () => {
    const hrefs = NAV_LINKS.map((l) => l.href);
    expect(hrefs).toEqual(['/docs', '/blog', '/roadmap', 'https://github.com/SandRiseStudio/musterd']);
    for (const h of hrefs) expect(h).not.toMatch(/live|board|audit|approvals|broadcast/);
  });

  it('nav renders the wordmark as the home link', () => {
    const src = readFileSync(fileURLToPath(new URL('./SiteNav.tsx', import.meta.url)), 'utf8');
    expect(src).toMatch(/href="\/"/);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `pnpm vitest run packages/web/src/components/site/site.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `SiteNav.tsx` (plain `<a>` links — these are separate prerendered documents, router `<Link>` buys nothing and drags code):

```tsx
import { MusterdChip } from '../../brand/MusterdWord';
import './site.css';

export const NAV_LINKS = [
  { label: 'Docs', href: '/docs' },
  { label: 'Blog', href: '/blog' },
  { label: 'Roadmap', href: '/roadmap' },
  { label: 'GitHub', href: 'https://github.com/SandRiseStudio/musterd' },
];

export function SiteNav() {
  return (
    <header className="sitenav">
      <a className="sitenav__home" href="/" aria-label="musterd home">
        <MusterdChip />
      </a>
      <nav className="sitenav__links" aria-label="Site">
        {NAV_LINKS.map((l) => (
          <a key={l.href} href={l.href}>{l.label}</a>
        ))}
      </nav>
    </header>
  );
}
```

`SiteFooter.tsx`: thin wrapper reusing the existing `Footer` (`export function SiteFooter() { return <Footer />; }`) unless reading `components/Footer.tsx` shows it is landing-specific — in that case a minimal footer with the GitHub/npm links copied from `GetStarted.tsx`'s `LINKS`. `site.css`: nav bar styles using existing tokens from `src/styles/tokens.css` only (read that file first; use its ink/paper tokens — invent no hexes).

- [ ] **Step 4: Run test → PASS**, then `pnpm --filter @musterd/web typecheck`.

- [ ] **Step 5: Commit** — `feat(web): shared public-site chrome (SiteNav/SiteFooter)`.

---

### Task 3: Build-prep content pipeline — manifest + gen-site-content

**Files:**
- Create: `packages/web/content/docs.manifest.ts`
- Create: `packages/web/content/docs/getting-started.md`, `packages/web/content/docs/concepts.md`
- Create: `packages/web/content/blog/2026-08-21-launch.md`
- Create: `packages/web/scripts/gen-site-content.ts`
- Test: `packages/web/scripts/gen-site-content.test.ts`
- Modify: `packages/web/package.json` (add `marked` devDependency; `build` becomes `node scripts/gen-site-content.ts && vite build`)
- Modify: `packages/web/.gitignore` or repo gitignore — ignore `packages/web/src/content/generated/`

**Interfaces:**
- Produces (generated module `src/content/generated/site-content.ts`, consumed by Task 4 routes):

```ts
export interface SitePage { slug: string; title: string; html: string }
export interface BlogPost extends SitePage { date: string } // YYYY-MM-DD from filename
export const docsPages: SitePage[];
export const blogPosts: BlogPost[];   // newest first
export const roadmapSections: { status: string; label: string; html: string }[];
```

- Produces (script exports, unit-tested): `parsePostFilename(name: string): { slug: string; date: string } | null`; `renderPage(md: string): { title: string; html: string }` (title = first `# ` heading, stripped from body); `renderRoadmap(): { status: string; label: string; html: string }[]`.

- [ ] **Step 1: Add the dependency** — `pnpm --filter @musterd/web add -D marked` (build-time only; zero client bytes — state this in the commit body).

- [ ] **Step 2: Write the manifest** (`content/docs.manifest.ts`). Entries resolve relative to the REPO ROOT; an explicit list, never a glob:

```ts
/** The ONLY repo files that reach the public /docs section. Adding here is a publish decision. */
export interface DocEntry { slug: string; title: string | null; source: string }
export const DOCS_MANIFEST: DocEntry[] = [
  { slug: 'getting-started', title: null, source: 'packages/web/content/docs/getting-started.md' },
  { slug: 'concepts', title: null, source: 'packages/web/content/docs/concepts.md' },
  { slug: 'product', title: 'What musterd is', source: 'PRODUCT.md' },
];
```

- [ ] **Step 3: Write the two hand-written docs pages** — `getting-started.md`: `# Getting started` + the brew/npx install commands and `musterd init` description copied from `GetStarted.tsx`'s real copy, then `<!-- [SLOANE] expand: first team walkthrough -->`. `concepts.md`: `# Concepts` + one honest paragraph each for seats, lanes, acts, acceptance (source facts from PRODUCT.md), `<!-- [SLOANE] -->` marker. Blog post `2026-08-21-launch.md`: `# musterd: muster your agents and humans into persistent teams` + 2–3 paragraphs mechanically condensed from `docs/launch-post.md` + `<!-- [SLOANE] full adaptation of docs/launch-post.md -->`.

- [ ] **Step 4: Write the failing tests** (`gen-site-content.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { parsePostFilename, renderPage, renderRoadmap } from './gen-site-content';

describe('parsePostFilename', () => {
  it('extracts date and slug', () =>
    expect(parsePostFilename('2026-08-21-launch.md')).toEqual({ date: '2026-08-21', slug: 'launch' }));
  it('rejects undated files', () => expect(parsePostFilename('notes.md')).toBeNull());
});

describe('renderPage', () => {
  it('lifts the first heading out as the title', () => {
    const { title, html } = renderPage('# Hello\n\nBody **bold**.');
    expect(title).toBe('Hello');
    expect(html).not.toContain('<h1>');
    expect(html).toContain('<strong>bold</strong>');
  });
  it('throws on a page with no heading', () => expect(() => renderPage('no heading')).toThrow());
});

describe('renderRoadmap', () => {
  it('emits one section per status, in STATUS_ORDER, each with items', () => {
    const sections = renderRoadmap();
    expect(sections.map((s) => s.status)).toEqual(['shipped', 'near-term', 'reserved', 'out-of-scope']);
    for (const s of sections) expect(s.html).toContain('<li');
  });
});
```

- [ ] **Step 5: Run → FAIL** (`pnpm vitest run packages/web/scripts/gen-site-content.test.ts`).

- [ ] **Step 6: Implement `gen-site-content.ts`.** Shape (module-level exports + a `main()` guarded by `import.meta.url === pathToFileURL(process.argv[1]).href` so tests import without side effects):

```ts
import { marked } from 'marked';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROADMAP, STATUS_ORDER, STATUS_META } from '../../../content/roadmap.data.ts';
import { DOCS_MANIFEST } from '../content/docs.manifest.ts';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pkgRoot));

export function parsePostFilename(name: string): { slug: string; date: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(name);
  return m ? { date: m[1], slug: m[2] } : null;
}

export function renderPage(md: string): { title: string; html: string } {
  const m = /^#\s+(.+)$/m.exec(md);
  if (!m) throw new Error('page has no # heading to use as title');
  const title = m[1].trim();
  const html = marked.parse(md.replace(m[0], ''), { async: false }) as string;
  return { title, html };
}

export function renderRoadmap(): { status: string; label: string; html: string }[] {
  return STATUS_ORDER.map((status) => ({
    status,
    label: STATUS_META[status].label,
    html: ROADMAP.filter((i) => i.status === status)
      .map((i) => `<li><strong>${esc(i.title)}</strong> — ${esc(i.blurb)}</li>`)
      .join('\n'),
  }));
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
```

`main()`: read every manifest entry (`existsSync` else `throw` naming the entry — a missing source FAILS the build), `renderPage` each (manifest `title` overrides); read `content/blog/*.md`, `parsePostFilename` (skip-with-throw on undated files), sort newest first; wrap `<li>` lists in `<ul>`; emit `src/content/generated/site-content.ts` as `/* GENERATED by scripts/gen-site-content.ts — do not edit */\nexport const docsPages = ${JSON.stringify(...)}` etc. `mkdirSync(..., { recursive: true })` first. Escape closing-script sequences is unnecessary (TS module, not inline script) — JSON.stringify suffices.

- [ ] **Step 7: Run tests → PASS.** Then run the script once (`node packages/web/scripts/gen-site-content.ts`) and eyeball the generated module.

- [ ] **Step 8: Wire the build** — package.json: `"build": "node scripts/gen-site-content.ts && vite build"`. Add the generated dir to gitignore. Run `pnpm --filter @musterd/web typecheck`.

- [ ] **Step 9: Commit** — `feat(web): build-prep content pipeline (docs manifest, blog, roadmap HTML)`.

---

### Task 4: The four content routes

**Files:**
- Create: `packages/web/src/routes/roadmap.tsx`, `docs.tsx`, `docs.$slug.tsx`, `blog.tsx`, `blog.$slug.tsx`
- Create: `packages/web/src/components/site/Prose.css` (typography for generated HTML — tokens only)
- Modify: `packages/web/vite.config.ts` (pages list)
- Test: `packages/web/src/routes/site-routes.test.ts`

**Interfaces:**
- Consumes: `docsPages`, `blogPosts`, `roadmapSections` from `../content/generated/site-content`; `SiteNav`/`SiteFooter` (Task 2).
- Produces: prerendered documents at `/roadmap`, `/docs`, `/docs/<slug>`, `/blog`, `/blog/<slug>` — the slugs Task 7 stages.

- [ ] **Step 1: Failing test** (`site-routes.test.ts`, source-assertion pattern):

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');

describe('public content routes', () => {
  for (const f of ['roadmap.tsx', 'docs.tsx', 'docs.$slug.tsx', 'blog.tsx', 'blog.$slug.tsx']) {
    it(`${f} renders site chrome and generated content only`, () => {
      const src = read(`./${f}`);
      expect(src).toContain('SiteNav');
      expect(src).toContain('SiteFooter');
      expect(src, 'content routes must not touch daemon modules').not.toMatch(/from '\.\.\/live\//);
    });
  }
  it('slug routes prerender from the generated lists', () => {
    expect(read('./docs.$slug.tsx')).toContain('docsPages');
    expect(read('./blog.$slug.tsx')).toContain('blogPosts');
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Pattern for a slug route (`blog.$slug.tsx`; `docs.$slug.tsx` is identical with `docsPages`/`Doc`):

```tsx
import { createFileRoute, notFound } from '@tanstack/react-router';
import { blogPosts } from '../content/generated/site-content';
import { SiteNav } from '../components/site/SiteNav';
import { SiteFooter } from '../components/site/SiteFooter';
import '../components/site/Prose.css';

export const Route = createFileRoute('/blog/$slug')({
  loader: ({ params }) => {
    const post = blogPosts.find((p) => p.slug === params.slug);
    if (!post) throw notFound();
    return post;
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.title} — musterd` }] }),
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
```

Index routes map the lists to link cards (plain `<a href={`/blog/${p.slug}`}>` — crawlLinks discovers the slug pages from exactly these links). `roadmap.tsx` maps `roadmapSections` to `<section><h2>{label}</h2><ul dangerouslySetInnerHTML…/></section>` and keeps a link to GitHub's ROADMAP.md. `Prose.css`: readable measure (~65ch), heading/code styles, existing tokens only.

- [ ] **Step 4: Update `vite.config.ts`** pages: `pages: [{ path: '/' }, { path: '/roadmap' }, { path: '/docs' }, { path: '/blog' }]` (slug pages come from crawlLinks).

- [ ] **Step 5: Test → PASS; typecheck; build** — `pnpm --filter @musterd/web build`; verify `dist/client/roadmap/index.html`, `docs/index.html`, `docs/getting-started/index.html`, `blog/index.html`, and `blog/launch/index.html` (slug from `parsePostFilename`, date not included) exist and contain real text (`grep -l "Getting started" dist/client/docs/getting-started/index.html`).

- [ ] **Step 6: Commit** — `feat(web): /roadmap, /docs, /blog prerendered routes`.

---

### Task 5: New landing page — typographic hero, what-is, teasers

**Files:**
- Create: `packages/web/src/components/site/LightHero.tsx`, `LightHero.css`, `WhatIs.tsx`, `Teasers.tsx`
- Modify: `packages/web/src/routes/index.tsx`
- Delete: `packages/web/src/components/Hero/` (Hero.tsx, Hero.css) — after confirming `grep -rn "components/Hero" packages/web/src` shows index.tsx as the only consumer
- Test: `packages/web/src/routes/landing.test.ts`

**Interfaces:**
- Consumes: `TAGLINE`, `WEDGE` from `../content/site` (real copy, reused); `GetStarted`, site chrome.
- Produces: the `/` document Task 6 adds the stream section into.

- [ ] **Step 1: Failing test** (`landing.test.ts`):

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = () => readFileSync(fileURLToPath(new URL('./index.tsx', import.meta.url)), 'utf8');

describe('landing page', () => {
  it('uses the typographic hero, not the canvas office scene', () => {
    expect(src()).toContain('LightHero');
    expect(src()).not.toMatch(/components\/Hero\/Hero|office-scene/);
  });
  it('no longer pulls the /live stylesheet', () => {
    expect(src()).not.toContain('Live.css');
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `LightHero.tsx`: `<section class="lh">` — `MusterdChip` wordmark, `<h1>{TAGLINE}</h1>`, one-sentence sub `{/* [SLOANE] */}` reusing `SITE_ONE_LINER` from siteMeta, the `musterd init` command line (styles echo GetStarted's `gs__cmd`), CTA links to `#get-started` and `/docs`. `LightHero.css`: mustard-gradient band built from existing tokens (read `src/styles/tokens.css` and `brand.css` for the palette; `a11y:check` will sweep it — text inks must clear AA on the gradient, so use existing ink tokens, never tinted fills). `WhatIs.tsx`: three short columns (identity/lanes/humans-as-peers) with `{/* [SLOANE] */}` markers + the `WEDGE` block verbatim. `Teasers.tsx`: two cards linking `/docs` and `/blog` (latest post title from `blogPosts[0]`? NO — that imports generated content into the landing chunk; hardcode the section links only). New `index.tsx` body: `<SiteNav /><LightHero /><StreamSection … (Task 6 adds) /><WhatIs /><GetStarted /><Teasers /><SiteFooter />` — Task 5 lands without StreamSection.

- [ ] **Step 4: Delete `src/components/Hero/`**; `grep -rn "Hero" packages/web/src --include="*.tsx"` to confirm no dangling imports. Run full web tests + typecheck + build; open `pnpm --filter @musterd/web preview` and look at `/`.

- [ ] **Step 5: Commit** — `feat(web): typographic landing hero replaces canvas office hero`.

---

### Task 6: Stream section — facade + deferred Twitch embed

**Files:**
- Create: `packages/web/src/components/site/twitchEmbed.ts`
- Create: `packages/web/src/components/site/StreamSection.tsx`, `StreamSection.css`
- Modify: `packages/web/src/routes/index.tsx` (mount section + preconnect links in `head`)
- Test: `packages/web/src/components/site/twitchEmbed.test.ts`, `packages/web/src/components/site/streamSection.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks beyond site chrome CSS conventions.
- Produces: `TWITCH_CHANNEL = 'sandrise_ai'`, `twitchEmbedUrl(channel: string, parent: string): string`, `<StreamSection />`.

- [ ] **Step 1: Failing tests.** `twitchEmbed.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TWITCH_CHANNEL, twitchEmbedUrl } from './twitchEmbed';

describe('twitchEmbedUrl', () => {
  it('builds the player URL with channel, parent, muted autoplay', () => {
    const u = new URL(twitchEmbedUrl(TWITCH_CHANNEL, 'musterd.io'));
    expect(u.origin).toBe('https://player.twitch.tv');
    expect(u.searchParams.get('channel')).toBe('sandrise_ai');
    expect(u.searchParams.get('parent')).toBe('musterd.io');
    expect(u.searchParams.get('muted')).toBe('true');
    expect(u.searchParams.get('autoplay')).toBe('true');
  });
});
```

`streamSection.test.ts` (source assertions — the no-DOM-rig pattern, each expectation commented with why, mirroring `broadcast.stage.test.ts`):

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = () => readFileSync(fileURLToPath(new URL('./StreamSection.tsx', import.meta.url)), 'utf8');

describe('the stream embed is deferred', () => {
  it('first render is the facade: visibility state seeds false', () => {
    expect(src()).toMatch(/useState\(false\)/);
  });
  it('the iframe renders only behind the visibility flag', () => {
    const s = src();
    const iframeAt = s.indexOf('<iframe');
    expect(iframeAt).toBeGreaterThan(-1);
    expect(s.slice(0, iframeAt)).toMatch(/visible\s*\?|\{visible &&/);
  });
  it('an IntersectionObserver flips it, and is disconnected after', () => {
    expect(src()).toContain('IntersectionObserver');
    expect(src()).toMatch(/\.disconnect\(\)/);
  });
  it('parent comes from location.hostname so previews work', () => {
    expect(src()).toContain('location.hostname');
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** `twitchEmbed.ts`:

```ts
export const TWITCH_CHANNEL = 'sandrise_ai';
export const TWITCH_URL = `https://www.twitch.tv/${TWITCH_CHANNEL}`;

/** player.twitch.tv iframe URL. `parent` is Twitch's embed allowlist — the embedding hostname. */
export function twitchEmbedUrl(channel: string, parent: string): string {
  const u = new URL('https://player.twitch.tv/');
  u.searchParams.set('channel', channel);
  u.searchParams.set('parent', parent);
  u.searchParams.set('muted', 'true');
  u.searchParams.set('autoplay', 'true');
  return u.toString();
}
```

`StreamSection.tsx`: side-by-side section (`display:grid; grid-template-columns: 1.1fr 1fr;` stacking under 720px). Left: heading "Built by its own agents — live" + 2 short paragraphs `{/* [SLOANE] */}` + `<a href={TWITCH_URL}>watch on Twitch</a>`. Right: 16:9 box (`aspect-ratio: 16/9`); `visible === false` → facade `<div class="ss__facade">` (mustard-dark gradient, LIVE-styled badge, "▶ live broadcast" text — static DOM, no request); `visible === true` → `<iframe src={twitchEmbedUrl(TWITCH_CHANNEL, location.hostname)} allowFullScreen title="musterd agents live on Twitch" />`. Mount effect: `const o = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setVisible(true); o.disconnect(); } }, { rootMargin: '200px' }); o.observe(ref.current); return () => o.disconnect();`. SSR safety: the observer lives in `useEffect` (never during render — the hydration lesson documented in `broadcast.stage.test.ts` applies).

- [ ] **Step 4: Wire into `index.tsx`** — `<StreamSection />` after `<LightHero />`; add to the route `head` links: `{ rel: 'preconnect', href: 'https://player.twitch.tv' }, { rel: 'preconnect', href: 'https://static.twitch.tv' }, { rel: 'preconnect', href: 'https://assets.twitch.tv' }`.

- [ ] **Step 5: Tests → PASS; build; verify the facade prerendered** — `grep -c '<iframe' dist/client/index.html` must be 0; `grep -c 'player.twitch.tv' dist/client/index.html` ≥ 1 (preconnect only). Preview and watch the iframe appear on scroll (channel offline shows Twitch's offline card — expected).

- [ ] **Step 6: Commit** — `feat(web): landing stream section — deferred sandrise_ai Twitch embed`.

---

### Task 7: Staging allowlist + stage tests

**Files:**
- Create: `packages/web/scripts/stage-allowlist.mjs`
- Modify: `packages/web/scripts/stage-site.mjs`
- Modify: `packages/web/wrangler.jsonc` (comment only: the origin now serves the ADR 300 public set)
- Test: `packages/web/scripts/stage-site.test.ts`

**Interfaces:**
- Produces: `PUBLIC_ALLOW: string[]` and `DAEMON_ROUTES: string[]` from `stage-allowlist.mjs`; `stage-site.mjs` imports both.

- [ ] **Step 1: Failing test:**

```ts
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs data module
import { PUBLIC_ALLOW, DAEMON_ROUTES } from './stage-allowlist.mjs';

describe('the public-origin allowlist (ADR 300)', () => {
  it('stages exactly the public set', () => {
    expect([...PUBLIC_ALLOW].sort()).toEqual(['assets', 'blog', 'build.json', 'docs', 'index.html', 'roadmap'].sort());
  });
  it('daemon surfaces are named and disjoint from the allowlist', () => {
    for (const r of ['live', 'board', 'audit', 'approvals', 'broadcast', 'character-sheet', 'office-preview']) {
      expect(DAEMON_ROUTES).toContain(r);
      expect(PUBLIC_ALLOW).not.toContain(r);
    }
  });
});
```

(`build.json` is emitted at the dist root by the build stamp — check whether the current script stages it today; if it is not in `dist/client` root adjust the expectation to match reality, keeping the disjointness test as-is.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `stage-allowlist.mjs` exports the two lists with the "adding here is a deploy decision (ADR 300)" comment moved from stage-site.mjs; `stage-site.mjs` imports them, and adds one new check before staging: `for (const r of DAEMON_ROUTES) if (ALLOW... includes(r)) die(...)` plus the existing missing/unexpected checks unchanged.

- [ ] **Step 4: Test → PASS.** Full pipeline: `pnpm --filter @musterd/web build && pnpm --filter @musterd/web stage:site`; verify output lists `index.html, assets, roadmap, docs, blog` staged and the daemon routes withheld; `ls dist/site` confirms.

- [ ] **Step 5: Commit** — `feat(web): stage-site allowlist covers the ADR 300 public set`.

---

### Task 8: Gates, perf log, and verification

**Files:**
- Modify: `docs/perf/web-live-baseline.md` (append measurement)
- Possibly modify: `docs/perf/budgets.json` — ONLY if `perf:check` shows the canvas-hero removal moved numbers enough that a tightening re-baseline is due (a re-baseline may only tighten, ADR 183).

- [ ] **Step 1: Run every gate** from the repo root: `pnpm --filter @musterd/web build && pnpm perf:check && pnpm a11y:check && pnpm tokens:check && pnpm format:check && pnpm vitest run packages/web`. Fix failures at their cause (read AGENTS.md's remedy table before touching budgets).

- [ ] **Step 2: Append to `docs/perf/web-live-baseline.md`**: date, branch, the perf:check summary numbers before/after this change (run `git stash`-free: check out main's build numbers from the log's last entry instead of rebuilding main), one line on the landing composition change (canvas hero out, static stream facade in, Twitch iframe deferred and third-party).

- [ ] **Step 3: Lighthouse sanity** (optional but cheap): `pnpm --filter @musterd/web preview` + Chrome DevTools Lighthouse on `/` — confirm no third-party Twitch bytes in the initial load trace.

- [ ] **Step 4: Commit** — `perf(web): record landing re-composition baseline`.

---

### Task 9: Land and hand off

- [ ] **Step 1:** Push branch, open the PR (`gh pr create`) titled `musterd.io expansion — public multi-page site (ADR 300)`; body summarizes spec + premise corrections, PR trailer per repo convention.
- [ ] **Step 2:** `lane_update` → `awaiting_acceptance` via `lane_submit` once CI is green; acceptance routes per ADR 244 at the lane's declared `normal` stakes.
- [ ] **Step 3:** Open the copy lane for sloane — title "musterd.io copy — landing, what-is, stream story, getting-started, launch post"; surface `packages/web/content/**`, `packages/web/src/components/site/**`; detail lists every `[SLOANE]` marker location; `team_send {act:'handoff'}` to sloane.
- [ ] **Step 4:** Deploy is nick's call — note in the PR that `deploy:site` should wait for sloane's copy unless nick wants the placeholder version live.
