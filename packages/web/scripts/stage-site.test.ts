import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs data module
import { DAEMON_ROUTES, PUBLIC_ALLOW } from './stage-allowlist.mjs';

describe('the public-origin allowlist (ADR 302)', () => {
  it('stages exactly the public set', () => {
    expect([...PUBLIC_ALLOW].sort()).toEqual(['assets', 'blog', 'docs', 'index.html', 'roadmap'].sort());
  });

  it('daemon surfaces are named and disjoint from the allowlist', () => {
    for (const r of ['live', 'board', 'audit', 'approvals', 'broadcast', 'character-sheet', 'office-preview']) {
      expect(DAEMON_ROUTES).toContain(r);
      expect(PUBLIC_ALLOW).not.toContain(r);
    }
  });
});
