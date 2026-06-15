import { describe, expect, it } from 'vitest';
import { resolveProvenance, resolveWorkspace } from './workspace.js';

describe('resolveWorkspace (where-on-attach seed, ADR 014)', () => {
  it('uses the declared override verbatim, capped at 120 chars', () => {
    expect(resolveWorkspace({ MUSTERD_WORKSPACE: 'auth rewrite' }, '/tmp/whatever')).toBe(
      'auth rewrite',
    );
    const long = 'x'.repeat(200);
    expect(resolveWorkspace({ MUSTERD_WORKSPACE: long }, '/tmp/whatever').length).toBe(120);
  });

  it('falls back to the cwd folder name when not a git repo and nothing declared', () => {
    // A path that exists but is not inside a git repo (the OS temp root is not versioned).
    const label = resolveWorkspace({}, '/');
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });

  it('qualifies the folder with the git branch when run inside this repo', () => {
    // This test file lives inside the musterd git repo, so the branch qualifier is available.
    const label = resolveWorkspace({}, process.cwd());
    // folder@branch form (degrades to bare folder only outside git) — assert the @qualifier shape.
    expect(label).toMatch(/.+@.+/);
  });
});

describe('resolveProvenance', () => {
  it('defaults to session', () => {
    expect(resolveProvenance({})).toBe('session');
  });
  it('passes through a valid provenance', () => {
    expect(resolveProvenance({ MUSTERD_PROVENANCE: 'scheduled' })).toBe('scheduled');
  });
  it('falls back to session for an unknown value', () => {
    expect(resolveProvenance({ MUSTERD_PROVENANCE: 'vibes' })).toBe('session');
  });
});
