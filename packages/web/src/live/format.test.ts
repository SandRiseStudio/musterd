import { describe, expect, it } from 'vitest';
import { toneColor } from './office-scene/render';
import {
  actLabel,
  actTone,
  goalEvent,
  laneEventDetail,
  richLength,
  richTokens,
  type RichToken,
} from './format';

describe('actTone — steering acts (ADR 103)', () => {
  it('gives steer and challenge their own prominent tones, and defer the lane family', () => {
    expect(actTone('steer')).toBe('steer');
    expect(actTone('challenge')).toBe('challenge');
    // defer mutates a Goal on the plan → rides the same lane (work-moving) family as lane transitions.
    expect(actTone('defer')).toBe('lane');
    expect(actTone('lane_open')).toBe('lane');
  });

  it('leaves the pre-existing acts untouched', () => {
    expect(actTone('request_help')).toBe('accent');
    expect(actTone('resolve')).toBe('success');
    expect(actTone('handoff')).toBe('handoff');
    expect(actTone('nope')).toBe('neutral');
  });
});

describe('actLabel — steering acts', () => {
  it('reads the steering acts verbatim (already clean single words)', () => {
    expect(actLabel('steer')).toBe('steer');
    expect(actLabel('challenge')).toBe('challenge');
    expect(actLabel('defer')).toBe('defer');
  });
});

describe('laneEventDetail — the human parts of a lane event, no verb echo, no id', () => {
  it('pulls the title from meta and skips the default project', () => {
    expect(
      laneEventDetail({
        body: '[lane] claimed "freeze predicates"',
        meta: { lane_claim: { lane: '01KX6QBGJ8W0NAHWAMFNQ38JRX', title: 'freeze predicates' } },
      }),
    ).toEqual({ title: 'freeze predicates' });
  });

  it('carries state + a non-default project as pill data', () => {
    expect(
      laneEventDetail({
        body: '[lane] opened "scenario repo"',
        meta: { lane_open: { lane: 'x', title: 'scenario repo', project: 'cookoff' } },
      }),
    ).toEqual({ title: 'scenario repo', project: 'cookoff' });
    expect(
      laneEventDetail({
        body: '[lane] resolved "prep"',
        meta: { lane_resolve: { lane: 'x', title: 'prep', state: 'done' } },
      }),
    ).toEqual({ title: 'prep', state: 'done' });
  });

  it('falls back to the quoted body when meta omits the title (lane_handoff)', () => {
    expect(
      laneEventDetail({
        body: '[lane] "the work" handed to you — branch feat/x',
        meta: { lane_handoff: { lane: 'x', branch: 'feat/x' } },
      }),
    ).toEqual({ title: 'the work', branch: 'feat/x' });
  });

  it('is null for a plain message', () => {
    expect(laneEventDetail({ body: 'hello', meta: null })).toBeNull();
  });
});

describe('goalEvent', () => {
  it('recovers a Goal declaration with its wave', () => {
    expect(
      goalEvent({
        act: 'message',
        body: '[goal] declared "prove value"',
        meta: { goal: { id: 'g', title: 'prove value', wave: 'later' } },
      }),
    ).toEqual({ title: 'prove value', wave: 'later' });
  });
  it('ignores non-goal messages', () => {
    expect(goalEvent({ act: 'message', body: 'hi', meta: null })).toBeNull();
    expect(goalEvent({ act: 'status_update', body: 'hi', meta: { goal: { title: 'x' } } })).toBeNull();
  });
});

describe('richTokens — prose rendered richly, not as a raw dump', () => {
  const kinds = (t: RichToken[]) => t.map((x) => x.kind);

  it('strips a composed [lane]/[goal] tag prefix', () => {
    expect(richTokens('[lane] the flag detail')).toEqual([{ kind: 'text', text: 'the flag detail' }]);
  });

  it('marks bold, code, PR refs and commit shas', () => {
    const t = richTokens('shipped **Stage 1** in `format.ts` (PR #210, d3bfbcc)');
    expect(kinds(t)).toContain('strong');
    expect(kinds(t)).toContain('code');
    expect(kinds(t)).toContain('ref');
    expect(t.find((x) => x.kind === 'ref')?.text).toBe('#210');
    // the short sha reads as code
    expect(t.some((x) => x.kind === 'code' && x.text === 'd3bfbcc')).toBe(true);
  });

  it('collapses a raw ULID to a short token but keeps the full value for hover', () => {
    const t = richTokens('lane 01KX6QBGJ8W0NAHWAMFNQ38JRX claimed');
    const id = t.find((x) => x.kind === 'id');
    expect(id).toEqual({ kind: 'id', text: '01KX6Q…8JRX', title: '01KX6QBGJ8W0NAHWAMFNQ38JRX' });
  });

  it('does not treat a plain word or a #-in-url as a ref/id', () => {
    expect(richTokens('see docs/design')).toEqual([{ kind: 'text', text: 'see docs/design' }]);
    expect(kinds(richTokens('a/b#3'))).toEqual(['text']);
  });

  it('richLength counts the visible characters (short id, inner bold text)', () => {
    expect(richLength(richTokens('**hi** there'))).toBe('hi there'.length);
    expect(richLength(richTokens('01KX6QBGJ8W0NAHWAMFNQ38JRX'))).toBe('01KX6Q…8JRX'.length);
  });
});

describe('toneColor — office palette mirrors the CSS tokens', () => {
  it('resolves every act tone to a concrete colour (no steering/lane tone falls through to default)', () => {
    const defaultColor = toneColor('neutral');
    for (const tone of ['steer', 'challenge', 'lane', 'handoff', 'status', 'accent', 'success']) {
      expect(toneColor(tone)).not.toBe(defaultColor);
    }
  });
});
