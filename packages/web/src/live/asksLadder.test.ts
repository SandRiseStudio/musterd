import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The asks rail's degradation ladder, pinned as a CONTAINER ladder.
 *
 * This reads the stylesheet rather than a component because the defect it guards lives nowhere
 * else: every one of these rules was correct CSS, in the right order, expressing the right
 * priorities — and every one of them was keyed to the WINDOW while the rail is sized by the office
 * panel. At a 1440px viewport the rail is 551px and wants 850px, so the ladder never fired and the
 * counts clipped to "1i…" instead of leaving. Nothing in the DOM, and nothing a server-rendered
 * test can reach, can tell those two ladders apart: only the at-rule can.
 *
 * There is no browser here, so this deliberately does NOT assert layout. It asserts the one thing
 * that made the old ladder inert — which question each step asks — plus the ORDER, which is the
 * design decision the rules encode (shed context, keep the answer).
 */
const raw = readFileSync(fileURLToPath(new URL('./Live.css', import.meta.url)), 'utf8');
/* Comments out FIRST. This file explains its own rules at length, and the ladder's comment quotes
   the `@media` it replaced — so a parser that reads the source verbatim finds a viewport step that
   is nothing but prose about a viewport step, and reports the defect it was written to disprove.
   (It did, on the first run.) */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');

/** The at-rule preludes that a given selector's `display: none` sits inside, outermost first. */
function hidingRules(selector: string): string[] {
  const found: string[] = [];
  const re = /@(container|media)([^{]*)\{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const [, kind, prelude, body] = m;
    if (!body || !prelude) continue;
    // The selector must be hidden here, not merely mentioned.
    const block = new RegExp(
      `(^|,)\\s*${selector.replace('.', '\\.')}\\s*(,[^{]*)?\\{[^}]*display:\\s*none`,
      'm',
    );
    if (block.test(body)) found.push(`@${kind} ${prelude.trim()}`);
  }
  return found;
}

const width = (rule: string): number => Number(/max-width:\s*(\d+)px/.exec(rule)?.[1] ?? NaN);

describe('the asks rail sheds by its own width, not the window', () => {
  /* The bug, in one assertion. A `@media` step here is not a style preference: `.lc-office` is
     `display: none` below 880px, so a viewport-keyed rule on this rail is dead on the only route
     that renders it. */
  it.each(['.lc-asks__gist', '.lc-asks__meta', '.lc-asks__link', '.lc-asks__verb', '.lc-asks__tier'])(
    'hides %s from a container query and never from a viewport one',
    (sel) => {
      const rules = hidingRules(sel);
      expect(rules.length).toBeGreaterThan(0);
      for (const r of rules) expect(r).toMatch(/^@container asks /);
    },
  );

  /* The ladder's whole doctrine is an ORDER: context goes before the answer does. Encoded as
     thresholds, that means the expendable things must leave at a WIDER container than the ones that
     outrank them — the gist before the counts, the counts before the verb and the tier. */
  it('sheds in priority order — gist, then the counts and the link, then verb and tier', () => {
    const at = (sel: string) => width(hidingRules(sel)[0] ?? '');
    const gist = at('.lc-asks__gist');
    const meta = at('.lc-asks__meta');
    const link = at('.lc-asks__link');
    const verb = at('.lc-asks__verb');
    const tier = at('.lc-asks__tier');
    expect(gist).toBeGreaterThan(meta);
    expect(meta).toBe(link); // the counts and the link leave together
    expect(meta).toBeGreaterThan(verb);
    expect(verb).toBe(tier); // as do the verb and the tier
  });

  /* The measurement this ladder was rebuilt on (2026-09-02, connected /live at a 1440px viewport):
     the rail box is 551px, so the container is ~553px. The first two steps must fire there and the
     third must not — that is the difference between "sheds context" and "sheds the answer". If a
     future edit moves these numbers past 553 in either direction, it changes what the office panel
     shows, and it should have to say so here. */
  it('fires its first two steps at the office panel’s measured 553px, and not its third', () => {
    const OFFICE_PANEL_PX = 553;
    expect(width(hidingRules('.lc-asks__gist')[0] ?? '')).toBeGreaterThan(OFFICE_PANEL_PX);
    expect(width(hidingRules('.lc-asks__meta')[0] ?? '')).toBeGreaterThan(OFFICE_PANEL_PX);
    expect(width(hidingRules('.lc-asks__verb')[0] ?? '')).toBeLessThan(OFFICE_PANEL_PX);
  });

  /* The queries are answerable: something has to actually BE the `asks` container, or every
     `@container asks` rule above is inert in a new and quieter way than the one it replaced. */
  it('names a container for those queries to ask', () => {
    expect(css).toMatch(/\.lc-asks\s*\{[^}]*container:\s*asks\s*\/\s*inline-size/);
  });
});
