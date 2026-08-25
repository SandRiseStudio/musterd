import { describe, expect, it } from 'vitest';
import { surfaceGlyph } from './surfaceGlyph';

describe('surfaceGlyph', () => {
  it('marks the three non-claude-code harnesses', () => {
    for (const surface of ['codex', 'cursor', 'opencode'] as const) {
      const glyph = surfaceGlyph(surface);
      expect(glyph, surface).not.toBeNull();
      expect(glyph!.id).toBe(surface);
      expect(glyph!.svg).toContain('<svg');
    }
  });

  it('returns null for every other surface — bare text is the fallback, not a broken mark', () => {
    for (const surface of ['claude-code', 'cli', 'web', 'ios', 'slack', 'other', 'never-seen', '', null, undefined]) {
      expect(surfaceGlyph(surface), String(surface)).toBeNull();
    }
  });

  it('tints via currentColor so the seg ink token drives the colour (no baked brand hex)', () => {
    for (const surface of ['codex', 'cursor', 'opencode'] as const) {
      const svg = surfaceGlyph(surface)!.svg;
      expect(svg).toContain('currentColor');
      expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      expect(svg).toContain('aria-hidden="true"');
    }
  });
});
