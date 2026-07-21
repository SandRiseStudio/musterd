import { describe, expect, it } from 'vitest';
import { CHIP_SVG, MCP_ICONS, chipIconDataUri } from './brand.js';

describe('brand (ADR 154)', () => {
  it('chip SVG is a mustard block with reversed m', () => {
    expect(CHIP_SVG).toContain('#E1AD01');
    expect(CHIP_SVG).toContain('#18181B');
    expect(CHIP_SVG).toContain('aria-label="musterd"');
  });

  it('MCP icons use a data-uri SVG', () => {
    expect(MCP_ICONS).toHaveLength(1);
    const icon = MCP_ICONS[0]!;
    expect(icon.mimeType).toBe('image/svg+xml');
    expect(icon.sizes).toEqual(['any']);
    expect(icon.src).toBe(chipIconDataUri());
    expect(icon.src.startsWith('data:image/svg+xml;base64,')).toBe(true);
  });
});
