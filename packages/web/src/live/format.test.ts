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
  isFeatureBehind,
  memberAvatar,
  memberColor,
  memberHue,
  memberInk,
  laneEvent,
  laneEventDetail,
  postureMeta,
  proseSegments,
  richLength,
  richTokens,
  rosterOrder,
  rosterPrimaryChip,
  type RichToken,
  acceptanceCapacity,
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

describe('laneEvent — recovering the lane sub-type from meta', () => {
  it('recovers a lane handoff whether it rides as a message or as a typed handoff act', () => {
    // The daemon now names the transfer `handoff` so it enters the directed ledger and can wake an
    // offline recipient. The stream must keep badging it as a lane event either way — before this,
    // the act check silently collapsed the new form back into a generic "handoff" row with no lane
    // glyph and no office choreography.
    const meta = { lane_handoff: { lane: 'x', branch: 'feat/x' } };
    expect(laneEvent({ act: 'message', meta })).toBe('lane_handoff');
    expect(laneEvent({ act: 'handoff', meta })).toBe('lane_handoff');
  });

  it('leaves a teammate-composed handoff alone — no lane meta, no lane badge', () => {
    expect(laneEvent({ act: 'handoff', meta: null })).toBeNull();
    expect(laneEvent({ act: 'handoff', meta: { progress: 0.5 } })).toBeNull();
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

describe('isFeatureBehind — feature-skew hint (ADR 148)', () => {
  const seat = (over: Partial<MemberSummary>): MemberSummary =>
    ({
      name: 'ada',
      kind: 'agent',
      presence: 'online',
      presences: [{ surface: 'claude-code', status: 'online', last_seen_at: 0, epoch: 1 }],
      ...over,
    }) as MemberSummary;

  it('flags a live seat whose epoch is below the daemon', () => {
    expect(isFeatureBehind(seat({ presences: [{ epoch: 1 } as never] }), 3)).toBe(true);
  });

  it('does not flag when the seat is current (equal epoch)', () => {
    expect(isFeatureBehind(seat({ presences: [{ epoch: 3 } as never] }), 3)).toBe(false);
  });

  it('does not flag when the seat is ahead — that is the daemon lagging, surfaced elsewhere', () => {
    expect(isFeatureBehind(seat({ presences: [{ epoch: 4 } as never] }), 3)).toBe(false);
  });

  it('never guesses: unknown member epoch or unknown daemon epoch → not behind', () => {
    expect(isFeatureBehind(seat({ presences: [{} as never] }), 3)).toBe(false); // member epoch absent
    expect(isFeatureBehind(seat({ presences: [{ epoch: 1 } as never] }), undefined)).toBe(false); // daemon absent
  });

  it('excludes offline seats — a seat that is not running cannot be behind', () => {
    expect(
      isFeatureBehind(seat({ presence: 'offline', presences: [{ epoch: 1 } as never] }), 3),
    ).toBe(false);
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

/**
 * Acceptance capacity (nick, 2026-08-05: the broadcast reads "→ gptbot" on nearly every row).
 *
 * The server's `pickLadder` (ADR 188) never routes a `same_model` or ungradeable counterpart, so
 * when every live agent attests one model the LIVE picker returns null for every lane and acceptance
 * survives only by waking an offline seat (ADR 191). That happened here: five live agents converged
 * on claude-opus-5 and one wakeable seat became the team's entire acceptance capacity.
 *
 * Nobody chose it and nothing noticed. This mirrors the server's rule client-side so a surface can
 * say so — the same reasoning `pickLadder` does, over the roster the page already holds.
 */
describe('acceptanceCapacity — can any LIVE seat accept another seat\'s work?', () => {
  const seat = (name: string, model: string | null, over: Partial<MemberSummary> = {}) =>
    ({
      name,
      kind: 'agent',
      presence: 'online',
      presences: model ? [{ model }] : [],
      ...over,
    }) as MemberSummary;

  it('reports zero live candidates when every live agent attests the same model', () => {
    const cap = acceptanceCapacity([
      seat('miley', 'claude-opus-5'),
      seat('izzo', 'claude-opus-5'),
      seat('dolly', 'claude-opus-5'),
    ]);
    expect(cap.degraded).toBe(true);
    expect(cap.liveCandidates).toBe(0);
    expect(cap.models).toEqual(['claude-opus-5']);
  });

  it('is healthy the moment ONE seat differs — the whole remedy is one model switch', () => {
    const cap = acceptanceCapacity([
      seat('miley', 'claude-fable-5'),
      seat('izzo', 'claude-opus-5'),
      seat('dolly', 'claude-opus-5'),
    ]);
    expect(cap.degraded).toBe(false);
    expect(cap.liveCandidates).toBe(3);
  });

  it('counts a live HUMAN as capacity — a human is cross-family by construction (ADR 188)', () => {
    const cap = acceptanceCapacity([
      seat('miley', 'claude-opus-5'),
      seat('izzo', 'claude-opus-5'),
      seat('nick', null, { kind: 'human' }),
    ]);
    expect(cap.degraded).toBe(false);
  });

  it('ignores offline seats — a seat that is not running cannot accept anything', () => {
    const cap = acceptanceCapacity([
      seat('miley', 'claude-opus-5'),
      seat('izzo', 'claude-opus-5'),
      seat('gptbot', 'gpt-5.2-codex', { presence: 'offline' }),
    ]);
    expect(cap.degraded).toBe(true);
  });

  it('does not count an unattested live seat — it cannot prove anything (ADR 158)', () => {
    // gptbot's real shape today: live, routed to, and attesting an empty model in all 32 rows.
    const cap = acceptanceCapacity([
      seat('miley', 'claude-opus-5'),
      seat('izzo', 'claude-opus-5'),
      seat('gptbot', null),
    ]);
    expect(cap.degraded).toBe(true);
    expect(cap.unattested).toEqual(['gptbot']);
  });

  it('is not degraded when there is nothing to review — one seat cannot be a monoculture', () => {
    expect(acceptanceCapacity([seat('miley', 'claude-opus-5')]).degraded).toBe(false);
    expect(acceptanceCapacity([]).degraded).toBe(false);
  });

  it('excludes service seats — a ledger seat never accepts (ADR 232)', () => {
    const cap = acceptanceCapacity([
      seat('miley', 'claude-opus-5'),
      seat('izzo', 'claude-opus-5'),
      seat('autorefresh', null, { kind: 'service' as MemberSummary['kind'] }),
    ]);
    expect(cap.degraded).toBe(true);
    expect(cap.unattested).toEqual([]);
  });
});

/**
 * A live seat attesting nothing is ineligible in BOTH directions — it cannot accept and cannot be
 * accepted for (ADR 158). That is worth saying even when the ladder is otherwise standing, because
 * it is silent everywhere else: `reattestModel` audits nothing when the value is unchanged, so a
 * seat that re-claims into a fresh occupancy attesting null leaves no audit row at all. Observed
 * 2026-08-05: ryder attested claude-opus-5 at 13:33:55, re-claimed, and read unattested at 13:47
 * with nothing in between.
 */
describe('acceptanceCapacity — unattested live seats are reported even when the ladder is up', () => {
  const seat = (name: string, model: string | null, over: Partial<MemberSummary> = {}) =>
    ({
      name,
      kind: 'agent',
      presence: 'online',
      presences: model ? [{ model }] : [],
      ...over,
    }) as MemberSummary;

  it('names them while reporting the ladder healthy — the exact roster after the fable-5 switch', () => {
    const cap = acceptanceCapacity([
      seat('dolly', 'claude-fable-5'),
      seat('izzo', 'claude-opus-5'),
      seat('miley', 'claude-opus-5'),
      seat('ryder', null),
      seat('kimi', null),
    ]);
    expect(cap.degraded).toBe(false);
    expect(cap.unattested).toEqual(['ryder', 'kimi']);
    expect(cap.liveCandidates).toBe(3);
  });
});

/**
 * The bounce guard. Every autorefresh restart makes all seats re-claim, and a fresh occupancy
 * attests nothing until its first call — ryder was observed unattested for ~14 minutes across one
 * such window on 2026-08-05. Without a guard the amber line would fire on every daemon bounce,
 * which is precisely the cried-wolf failure ADR 148 retired the build-SHA "stale" chip for.
 *
 * The rule that survives both cases: unattested seats cannot RESCUE a flat ladder (they are
 * ineligible either way), so they must not suppress the warning — but concluding "nothing pairs"
 * needs at least two seats whose models we can actually see. Fewer than that is `unknown`, not
 * `degraded`, which is the same absent-vs-unknown discipline ADR 169/189 draws elsewhere.
 */
describe('acceptanceCapacity — unknown is not degraded', () => {
  const seat = (name: string, model: string | null, over: Partial<MemberSummary> = {}) =>
    ({ name, kind: 'agent', presence: 'online', presences: model ? [{ model }] : [], ...over }) as MemberSummary;

  it('stays quiet mid-bounce, when every seat has re-claimed and not yet attested', () => {
    const cap = acceptanceCapacity([seat('miley', null), seat('izzo', null), seat('dolly', null)]);
    expect(cap.degraded).toBe(false);
    expect(cap.unattested).toEqual(['miley', 'izzo', 'dolly']);
  });

  it('stays quiet when only ONE seat has attested — one model is not evidence of a monoculture', () => {
    expect(acceptanceCapacity([seat('miley', 'claude-opus-5'), seat('izzo', null)]).degraded).toBe(
      false,
    );
  });

  it('still fires when unattested seats sit BESIDE a real monoculture — they cannot rescue it', () => {
    // The true 13:09 roster: five agents on one model, plus an unattested seat that helps nobody.
    const cap = acceptanceCapacity([
      seat('miley', 'claude-opus-5'),
      seat('izzo', 'claude-opus-5'),
      seat('dolly', 'claude-opus-5'),
      seat('ryder', 'claude-opus-5'),
      seat('stanley', 'claude-opus-5'),
      seat('kimi', null),
    ]);
    expect(cap.degraded).toBe(true);
  });
});

/* ─── identity colour: the fill / ink split ──────────────────────────────────────────────────────
 * These are contrast REGRESSION tests, not unit trivia. The values they pin were arrived at by
 * measurement, and the failure mode they guard against is someone "tidying" the derived lightnesses
 * back to a single constant — which is exactly the state that made avatar initials unreadable. */

/** sRGB relative luminance of an `hsl(h, s%, l%)` string, per WCAG 2.1. */
function luminanceOfHsl(css: string): number {
  const [hue, sat, light] = css.match(/[\d.]+/g)!.map(Number);
  const s = sat / 100;
  const l = light / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
}
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const WHITE = 1;
/** --lc-surface-3 #e8d7b4, the darkest paper any of this text can land on. */
const DARKEST_PAPER = 0.6598;

/** Enough names to sweep both hue bands densely. */
const NAMES = Array.from({ length: 400 }, (_, i) => `seat-${i}`);
const KINDS = ['agent', 'human'] as const;

describe('memberColor — the identity FILL, deliberately unchanged', () => {
  it('still returns the floor-body colour at a constant lightness', () => {
    // The room paints characters with this. Pinned so an accessibility change to the AVATAR can
    // never silently restyle the office.
    expect(memberColor('miley', 'agent')).toMatch(/^hsl\(\d+, 68%, 62%\)$/);
    expect(memberColor('nick', 'human')).toMatch(/^hsl\(\d+, 68%, 62%\)$/);
  });

  it('is stable across calls and distinct per member', () => {
    expect(memberColor('miley', 'agent')).toBe(memberColor('miley', 'agent'));
    expect(memberColor('miley', 'agent')).not.toBe(memberColor('izzo', 'agent'));
  });

  it('cannot carry a hard-coded initial colour — which is why memberAvatar exists', () => {
    // The premise of the split, asserted rather than left in a comment. For any ONE background at
    // least one pole clears AA (the two failure conditions are mutually exclusive), so the bug is
    // not "nothing works" — it is that the correct pole FLIPS across the band, and every avatar
    // component pins one. Both failure sets must be non-empty for that to be true.
    const fills = NAMES.flatMap((n) => KINDS.map((k) => luminanceOfHsl(memberColor(n, k))));
    expect(fills.filter((bg) => contrast(WHITE, bg) < 4.5).length).toBeGreaterThan(0);
    expect(fills.filter((bg) => contrast(0, bg) < 4.5).length).toBeGreaterThan(0);
    expect(fills.filter((bg) => contrast(WHITE, bg) < 4.5 && contrast(0, bg) < 4.5)).toEqual([]);
  });
});

describe('memberAvatar — the fill that has to carry a letter', () => {
  it('takes white initials at AA for every member, in both bands', () => {
    for (const name of NAMES) {
      for (const kind of KINDS) {
        const ratio = contrast(WHITE, luminanceOfHsl(memberAvatar(name, kind)));
        expect(ratio, `white on ${kind} avatar ${name} (${memberAvatar(name, kind)})`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps the member’s hue, so the avatar and the body are one identity', () => {
    for (const name of NAMES.slice(0, 40)) {
      for (const kind of KINDS) {
        expect(memberAvatar(name, kind)).toContain(`hsl(${memberHue(name, kind)},`);
      }
    }
  });

  it('holds luminance constant, which is what makes one pole correct for everyone', () => {
    // The old palette spanned 4.6x in luminance at a constant LIGHTNESS. Evening that out is the
    // mechanism, not a nicety: it is why the initials can be uniformly white.
    const lums = NAMES.flatMap((n) => KINDS.map((k) => luminanceOfHsl(memberAvatar(n, k))));
    expect(Math.max(...lums) / Math.min(...lums)).toBeLessThan(1.1);
  });
});

describe('memberInk — the identity colour as TEXT on paper', () => {
  it('clears AA against the darkest paper for every member', () => {
    for (const name of NAMES) {
      for (const kind of KINDS) {
        const ratio = contrast(DARKEST_PAPER, luminanceOfHsl(memberInk(name, kind)));
        expect(ratio, `${kind} ink ${name} (${memberInk(name, kind)})`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('is darker than the avatar fill, which is darker than the floor fill', () => {
    for (const name of NAMES.slice(0, 40)) {
      for (const kind of KINDS) {
        expect(luminanceOfHsl(memberInk(name, kind))).toBeLessThan(
          luminanceOfHsl(memberAvatar(name, kind)),
        );
      }
    }
  });
});
