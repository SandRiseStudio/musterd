import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RosterPanel } from './RosterPanel';

/**
 * What the roster RENDERS for a seat living on another machine (presence replication, ADR 356).
 *
 * Rendered with `react-dom/server` and no DOM, for the reasons `AsksStrip.render.test.ts` sets out
 * at length: React is already here, a headless browser costs a Chromium per run, and the question
 * is the markup rather than the paint. Effects never run, so every claim below is render-time.
 *
 * The claim under test is narrow and worth stating precisely: the node suffix is a fact about
 * WHERE, and it must appear only when that fact is news. A row on this daemon carries `node: null`
 * and gets nothing, because the machine you are already looking at is not information.
 */

const seat = (over: Partial<MemberSummary> = {}): MemberSummary =>
  ({
    // The row keys on `id`, so the fixture carries one — without it React warns about a missing
    // key and the noise reads like a product defect in every future run of this file.
    id: 'm_stanley',
    name: 'stanley',
    kind: 'agent',
    presence: 'online',
    posture: 'working',
    presences: [],
    capabilities: {},
    ...over,
  }) as unknown as MemberSummary;

const presence = (over: Record<string, unknown> = {}) =>
  ({ surface: 'claude-code', node: null, node_label: null, ...over }) as never;

const render = (roster: MemberSummary[]) =>
  renderToStaticMarkup(createElement(RosterPanel, { roster }));

describe('RosterPanel — the machine a seat lives on', () => {
  it('names the node beside the posture chip when the seat is on another machine', () => {
    const html = render([
      seat({ presences: [presence({ node: 'n_b', node_label: 'laptop-b' })] }),
    ]);
    expect(html).toContain('lc-stat__node');
    expect(html).toContain('@ laptop-b');
  });

  it('says WHERE in the chip tooltip too, so the suffix is not the only carrier', () => {
    const html = render([
      seat({ presences: [presence({ node: 'n_b', node_label: 'laptop-b' })] }),
    ]);
    expect(html).toContain('on laptop-b');
  });

  it('stays silent for a local row — the machine you are on is not news', () => {
    const html = render([seat({ presences: [presence()] })]);
    expect(html).not.toContain('lc-stat__node');
    expect(html).not.toContain(' @ ');
  });

  it('stays silent when the seat has no presence at all', () => {
    const html = render([seat({ presence: 'offline', posture: 'offline', presences: [] })]);
    expect(html).not.toContain('lc-stat__node');
  });

  /**
   * A replicated node row can arrive with an id and no label — the label lives on the `nodes` row
   * the presence LEFT JOINs to, so a node this daemon has not synced yet joins to null. Printing
   * the raw id would put a ULID in the roster; printing nothing is the honest fallback, since the
   * seat's own posture is unaffected by our not knowing the machine's name.
   */
  it('prints nothing rather than a raw node id when the label has not synced', () => {
    const html = render([seat({ presences: [presence({ node: 'n_b', node_label: null })] })]);
    expect(html).not.toContain('lc-stat__node');
    expect(html).not.toContain('n_b');
  });

  /**
   * `presences` is ordered `last_seen_at DESC` server-side (presence.ts:461), so index 0 is the
   * machine the seat was most recently seen on. This pins that the chip follows that order rather
   * than insertion or an arbitrary pick — the CLI reads `presences[0]` for the same reason
   * (render/rows.ts:352), and the two surfaces disagreeing about where someone is would be worse
   * than either being wrong alone.
   */
  it('names the most recently seen machine when a seat is present on two', () => {
    const html = render([
      seat({
        presences: [
          presence({ node: 'n_b', node_label: 'laptop-b' }),
          presence({ node: 'n_c', node_label: 'laptop-c' }),
        ],
      }),
    ]);
    expect(html).toContain('@ laptop-b');
    expect(html).not.toContain('laptop-c');
  });
});

/**
 * The contrast gate cannot see this suffix, and that is worth pinning rather than hoping about.
 *
 * `a11y:check` sweeps `/live` connected against the fixture team (scripts/a11y/fixture-team.sh),
 * and that team runs on ONE daemon — every seat it seats carries `node: null`, so no fixture row
 * ever renders `.lc-stat__node`. Seeding one would take a second daemon and a replicated presence,
 * which is federation machinery for a fixture, and I am not spending that here.
 *
 * What makes the blindness harmless is a property of the rule rather than a fact about the fixture:
 * the suffix declares NO colour and NO alpha, so it inherits the chip's ink and paints at exactly
 * the ratio the gate already measures on the label beside it, on every row, every run. That holds
 * only as long as nobody adds `color` or `opacity` — which is precisely the edit a future reader
 * would make to "quieten" it, and precisely the edit no gate would catch.
 *
 * So: read the stylesheet and fail on it. The reason the fix is weight-and-tracking rather than an
 * alpha pass is in the rule's own comment; this is the test that keeps it that way.
 */
const css = readFileSync(fileURLToPath(new URL('./Live.css', import.meta.url)), 'utf8');

describe('.lc-stat__node stays inside what the contrast gate can measure', () => {
  const rule = /\.lc-stat__node\s*\{([^}]*)\}/.exec(css)?.[1];

  it('exists as a rule at all', () => {
    expect(rule).toBeDefined();
  });

  it('declares no colour of its own — it inherits the chip ink the gate already measures', () => {
    expect(rule).not.toMatch(/(^|[;\s])color\s*:/);
  });

  it('declares no alpha — an opacity pass over the faintest chip ink lands below AA', () => {
    expect(rule).not.toMatch(/(^|[;\s])opacity\s*:/);
  });
});
