import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { distFileFor, missingFromDist, missingRoutesNotice } from './dist-routes.mjs';

/**
 * The defect these pin (2026-09-21, lane 01M32QTVN): a route missing from the built client is
 * served as a 404 by the gates' own static server, and a 404 page has text and a link on it — so
 * both sweeps measured it and reported a ✓. `contrast-gate --static-only --routes /roadmap`
 * printed `✓ /roadmap — 1 measured` for a route deleted on 2026-07-28.
 */

const distWith = (files: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'dist-routes-'));
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), '<!doctype html>');
  }
  return dir;
};

describe('distFileFor', () => {
  it('puts the landing page at the dist root and nests the rest', () => {
    expect(distFileFor('/')).toBe('index.html');
    expect(distFileFor('/watch')).toBe('watch/index.html');
    expect(distFileFor('/docs/getting-started')).toBe('docs/getting-started/index.html');
  });
});

describe('missingFromDist', () => {
  it('names the routes that are not in the build', () => {
    const dir = distWith(['index.html', 'watch/index.html']);
    expect(missingFromDist(dir, ['/', '/watch', '/roadmap'])).toEqual(['/roadmap']);
  });

  it('is empty when every route is there', () => {
    const dir = distWith(['index.html', 'board/index.html']);
    expect(missingFromDist(dir, ['/', '/board'])).toEqual([]);
  });

  it('does not accept a DIRECTORY as the page', () => {
    // `board/` existing without `board/index.html` is exactly what a dropped route can leave
    // behind, and treating the directory as proof would restore the hole.
    const dir = distWith(['index.html']);
    mkdirSync(join(dir, 'board'), { recursive: true });
    expect(missingFromDist(dir, ['/board'])).toEqual(['/board']);
  });
});

describe('missingRoutesNotice', () => {
  it('is empty when nothing is missing, so a caller can print it unconditionally', () => {
    const dir = distWith(['index.html']);
    expect(missingRoutesNotice(dir, ['/'], 'contrast-gate')).toBe('');
  });

  it('says no verdict was taken, rather than reporting a result about the page', () => {
    const dir = distWith(['index.html']);
    const notice = missingRoutesNotice(dir, ['/', '/roadmap'], 'contrast-gate');
    expect(notice).toContain('/roadmap');
    expect(notice).toContain('no verdict was taken');
    expect(notice).toContain('contrast-gate');
  });
});
