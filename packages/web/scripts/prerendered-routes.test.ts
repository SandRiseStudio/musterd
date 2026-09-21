import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declaredRoutes, missingRoutes, outputFor, routePathFor } from './prerendered-routes';

/**
 * The defect these pin: a prerender error does not fail the build, so `dist/client` can be missing
 * routes while `pnpm build` exits 0 and every downstream gate reads that dist and stays green
 * (2026-09-21, lane 01M32QTVN).
 */

const distWith = (files: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'prerender-check-'));
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), '<!doctype html>');
  }
  return dir;
};

describe('routePathFor', () => {
  it('maps flat-route filenames to URL paths', () => {
    expect(routePathFor('index.tsx')).toBe('/');
    expect(routePathFor('watch.tsx')).toBe('/watch');
    expect(routePathFor('office-preview.tsx')).toBe('/office-preview');
    expect(routePathFor('docs.index.tsx')).toBe('/docs');
    expect(routePathFor('blog.index.tsx')).toBe('/blog');
  });

  it('is not fooled by the non-routes that live in the routes directory', () => {
    // All three of these sit in src/routes today, and counting any of them would make the check
    // demand output for a page that does not exist — a gate that cries wolf gets deleted.
    expect(routePathFor('__root.tsx')).toBeNull();
    expect(routePathFor('landing.test.ts')).toBeNull();
    expect(routePathFor('broadcast.stage.test.ts')).toBeNull();
  });

  it('skips param routes, whose concrete pages are named by data rather than by file', () => {
    expect(routePathFor('docs.$slug.tsx')).toBeNull();
    expect(routePathFor('blog.$slug.tsx')).toBeNull();
  });
});

describe('outputFor', () => {
  it('puts the landing page at the dist root and nests the rest', () => {
    expect(outputFor('/')).toBe('index.html');
    expect(outputFor('/board')).toBe('board/index.html');
    expect(outputFor('/docs')).toBe('docs/index.html');
  });
});

describe('declaredRoutes', () => {
  it('reads the real route tree and finds the routes that went missing', () => {
    // Not a fixture: if someone adds a route file, this check must cover it without being told.
    const routes = declaredRoutes();
    for (const r of ['/', '/board', '/approvals', '/audit', '/character-sheet', '/watch']) {
      expect(routes).toContain(r);
    }
    // /roadmap is NOT a route — dropped from the web UI 2026-07-28 — and must not be demanded.
    expect(routes).not.toContain('/roadmap');
  });
});

describe('missingRoutes', () => {
  it('names exactly the routes a build failed to emit', () => {
    const dist = distWith(['index.html', 'watch/index.html']);
    expect(missingRoutes(dist, ['/', '/watch', '/board'])).toEqual(['/board']);
  });

  it('is empty when the build emitted everything', () => {
    const dist = distWith(['index.html', 'board/index.html']);
    expect(missingRoutes(dist, ['/', '/board'])).toEqual([]);
  });

  it('reproduces the 2026-09-21 five-route drop', () => {
    const dist = distWith(['index.html', 'watch/index.html', 'docs/index.html', 'live/index.html']);
    expect(
      missingRoutes(dist, ['/', '/approvals', '/audit', '/board', '/character-sheet', '/docs', '/live', '/watch']),
    ).toEqual(['/approvals', '/audit', '/board', '/character-sheet']);
  });

  it('allows an optional route to be absent — /blog with no posts is the real case', () => {
    const dist = distWith(['index.html']);
    expect(missingRoutes(dist, ['/', '/blog'], ['/blog'])).toEqual([]);
    // And still reports it when it is NOT declared optional, so the allowance is explicit.
    expect(missingRoutes(dist, ['/', '/blog'])).toEqual(['/blog']);
  });
});
