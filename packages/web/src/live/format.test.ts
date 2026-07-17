import { describe, expect, it } from 'vitest';
import type { MemberSummary } from '@musterd/protocol';
import { toneColor } from './office-scene/render';
import {
  accountStatusException,
  accountStatusMeta,
  actLabel,
  actTone,
  formatClock,
  goalEvent,
  laneEventDetail,
  postureMeta,
  proseSegments,
  richLength,
  richTokens,
  rosterOrder,
  rosterPrimaryChip,
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

describe('proseSegments — long bodies become scannable clause lines', () => {
  const text = (segs: RichToken[][]) => segs.map((s) => s.map((t) => t.text).join(''));

  it('leaves a short body as a single segment (no chopping)', () => {
    expect(proseSegments('on it — will open the PR')).toHaveLength(1);
  });

  it('splits a long body on sentence ends, semicolons, and spaced em-dashes', () => {
    const body =
      'Migration done: synced the checkout to origin/main and rebuilt the dist. ' +
      'Ran the install — both agents re-bootstrapped; the viewer is verified up on :5173.';
    const segs = text(proseSegments(body));
    expect(segs.length).toBeGreaterThanOrEqual(3);
    // sentence terminator stays with its clause
    expect(segs[0]).toBe('Migration done: synced the checkout to origin/main and rebuilt the dist.');
    // em-dash + semicolon are dropped (the line break stands in)
    expect(segs.some((s) => s.startsWith('Ran the install'))).toBe(true);
    expect(segs.some((s) => s.startsWith('the viewer is verified up'))).toBe(true);
  });

  it('does not split inside decimals, versions, or abbreviations mid-word', () => {
    const body =
      'Shipped v0.2 with a 12.2% win and the docs/design layout; the archaeology tool fires cleanly ' +
      'on the seeded commit and the acceptance suite is green across every one of the trap tickets.';
    const segs = text(proseSegments(body));
    // "v0.2" and "12.2%" have no space after the dot, so they never become split points
    expect(segs.some((s) => s.includes('v0.2') && s.includes('12.2%'))).toBe(true);
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

describe('postureMeta — roster posture pill (ADR 138)', () => {
  it('renders wire posture tokens with tones', () => {
    expect(postureMeta('working')).toEqual({ label: 'working', tone: 'ok', quiet: false });
    expect(postureMeta('idle')).toEqual({ label: 'idle', tone: 'ok', quiet: true });
    expect(postureMeta('away')).toEqual({ label: 'away', tone: 'pending', quiet: false });
    expect(postureMeta('offline')).toEqual({ label: 'offline', tone: 'muted', quiet: true });
  });
});

describe('rosterPrimaryChip — posture + offline reason (ADR 138/141)', () => {
  it('shows idle/working from posture when live', () => {
    expect(
      rosterPrimaryChip({
        posture: 'idle',
        presence: 'online',
        activity: 'idle',
      } as MemberSummary).label,
    ).toBe('idle');
    expect(
      rosterPrimaryChip({
        posture: 'working',
        presence: 'online',
        activity: 'working',
      } as MemberSummary).label,
    ).toBe('working');
  });

  it('prefers offline_reason over bare offline when known', () => {
    expect(
      rosterPrimaryChip({
        posture: 'offline',
        presence: 'offline',
        activity: 'offline',
        offline_reason: 'disconnected',
      } as MemberSummary).label,
    ).toBe('disconnected');
    expect(
      rosterPrimaryChip({
        posture: 'offline',
        presence: 'offline',
        activity: 'offline',
        offline_reason: 'unknown',
      } as MemberSummary).label,
    ).toBe('offline');
  });
});

describe('rosterOrder — active seats lead the rail', () => {
  const seat = (name: string, over: Partial<MemberSummary>): MemberSummary =>
    ({ name, kind: 'agent', presence: 'online', activity: 'idle', ...over }) as MemberSummary;

  it('orders working → idle → away → offline, whatever the input order', () => {
    const roster = [
      seat('off', { posture: 'offline', presence: 'offline', activity: 'offline' }),
      seat('idle', { posture: 'idle', activity: 'idle' }),
      seat('away', { posture: 'away', activity: 'idle' }),
      seat('work', { posture: 'working', activity: 'working' }),
    ];
    expect([...roster].sort(rosterOrder).map((m) => m.name)).toEqual(['work', 'idle', 'away', 'off']);
  });

  it('puts a working agent above an idle one (the reported case)', () => {
    const working = seat('stanley', { posture: 'working', activity: 'working' });
    const idle = seat('gptbot', { posture: 'idle', activity: 'working' }); // stale: activity lags posture
    expect([idle, working].sort(rosterOrder).map((m) => m.name)).toEqual(['stanley', 'gptbot']);
  });

  it('breaks ties within a posture by human-before-agent, then name', () => {
    const a = seat('zeb', { posture: 'working', activity: 'working', kind: 'human' });
    const b = seat('abe', { posture: 'working', activity: 'working', kind: 'agent' });
    const c = seat('cy', { posture: 'working', activity: 'working', kind: 'agent' });
    expect([b, c, a].sort(rosterOrder).map((m) => m.name)).toEqual(['zeb', 'abe', 'cy']);
  });
});

describe('accountStatusException — governance exceptions only (ADR 138)', () => {
  it('hides provisioned/active/unknown — posture owns the primary chip', () => {
    expect(accountStatusException('active')).toBeNull();
    expect(accountStatusException('provisioned')).toBeNull();
    expect(accountStatusException(undefined)).toBeNull();
  });

  it('surfaces disabled/banned/archived as wire tokens', () => {
    expect(accountStatusException('disabled')?.label).toBe('disabled');
    expect(accountStatusException('banned')?.label).toBe('banned');
    expect(accountStatusException('archived')?.label).toBe('archived');
  });

  it('keeps accountStatusMeta for tooltips / non-rail uses', () => {
    expect(accountStatusMeta('active').label).toBe('active');
    expect(accountStatusMeta('provisioned').label).toBe('provisioned');
  });
});

describe('formatClock — the office clock', () => {
  it('renders wall time as h:mm:ss with an un-padded hour, plus meridiem and zone', () => {
    // 2026-07-13T16:27:11Z is 9:27:11 AM in Los Angeles (PDT in July).
    const d = new Date('2026-07-13T16:27:11Z');
    const { time, meridiem, zone } = formatClock(d);
    expect(time).toMatch(/^\d{1,2}:\d{2}:\d{2}$/);
    expect(meridiem).toMatch(/^[AP]M$/);
    expect(zone.length).toBeGreaterThan(0);
    // The hour never carries a leading zero — "9:27:11", not "09:27:11".
    expect(time.startsWith('0')).toBe(false);
  });

  it('pads minutes and seconds to two digits so the slots never reflow', () => {
    const { time } = formatClock(new Date('2026-07-13T16:03:04Z'));
    const [, min, sec] = time.split(':');
    expect(min).toHaveLength(2);
    expect(sec).toHaveLength(2);
  });
});
