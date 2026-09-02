import { describe, expect, it } from 'vitest';
import {
  FULL_MAX,
  GLANCE_MAX,
  GLANCE_MAX_STATUS,
  shapeSpeech,
  speechAddressee,
  speechLength,
  speechTokens,
  stripNoise,
  truncateSpeech,
  typeCadence,
} from './speech';

describe('truncateSpeech', () => {
  it('passes short text through, collapsing whitespace', () => {
    expect(truncateSpeech('hello   there\nfriend')).toBe('hello there friend');
  });
  it('cuts long text on a word boundary with an ellipsis', () => {
    const out = truncateSpeech('the quick brown fox jumps over the lazy dog and keeps on running along', 30);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(31);
    expect(out).not.toMatch(/\s…$/); // no dangling space before the ellipsis
  });
  it('hard-cuts a single very long word (no early boundary)', () => {
    const out = truncateSpeech('supercalifragilisticexpialidocious', 10);
    expect(out).toBe('supercalif…');
  });
  it('prefers a sentence boundary when one lands deep in the window', () => {
    const out = truncateSpeech('The deploy is green and the suite passed. Opening the PR now.', 50);
    expect(out).toBe('The deploy is green and the suite passed.'); // whole sentence, no ellipsis
  });
});

describe('stripNoise', () => {
  it('strips headers and single-char emphasis, keeps strong/code markers for the token renderer', () => {
    expect(stripNoise('## Title\n**bold** and _em_ and `code`')).toBe('Title **bold** and em and `code`');
  });
  it('collapses a fenced code block to a compact token', () => {
    expect(stripNoise('before\n```ts\nconst x = 1;\n```\nafter')).toBe('before ⟨code⟩ after');
  });
  it('reduces a bare URL to an arrow + hostname', () => {
    expect(stripNoise('see https://github.com/foo/bar/pull/9 now')).toBe('see ↗ github.com now');
  });
  it('keeps a markdown link label, drops the target', () => {
    expect(stripNoise('open the [PR](https://github.com/x) please')).toBe('open the PR please');
  });
  it('drops leading list bullets and blockquotes', () => {
    expect(stripNoise('- one\n- two\n> quoted')).toBe('one two quoted');
  });
  it('unwraps a lane envelope into a plain-language clause (first-five-seconds §3)', () => {
    expect(stripNoise('[lane] resolved "Re-font body: Fraunces → Inter"')).toBe(
      'finished: Re-font body: Fraunces → Inter',
    );
    expect(stripNoise('[lane] claimed "Delight B"')).toBe('took on: Delight B');
    expect(stripNoise('[lane] handed "Delight B"')).toBe('handing over: Delight B');
  });
  it('unwraps a goal envelope the same way', () => {
    expect(stripNoise('[goal] declared "Work items, board & insight layer (web)"')).toBe(
      'declared: Work items, board & insight layer (web)',
    );
  });
  it('keeps content trailing the quoted title', () => {
    expect(stripNoise('[lane] surface overlaps "Daemon refresh" (owner miley): ROADMAP.md ∩ ROADMAP.md')).toBe(
      'overlaps with: Daemon refresh (owner miley): ROADMAP.md ∩ ROADMAP.md',
    );
  });
  it('unwraps a state-transition envelope into plain language', () => {
    expect(stripNoise('[lane] "cookoff run ladder" → active')).toBe('working on: cookoff run ladder');
    expect(stripNoise('[lane] "cookoff run ladder" → awaiting_acceptance')).toBe(
      'ready for review: cookoff run ladder',
    );
    expect(stripNoise('[lane] "cookoff run ladder" → done')).toBe('finished: cookoff run ladder');
  });

  it('still drops a bare envelope tag before an unknown shape', () => {
    expect(stripNoise('[lane] something unusual entirely')).toBe('something unusual entirely');
  });
  it('unwraps a whole-line quoted title with no verb', () => {
    expect(stripNoise('"just a quoted title"')).toBe('just a quoted title');
  });
  it('leaves refs, paths, flags, arrows, and short hashes intact', () => {
    const s = 'Shipped PR #343 as 17cc546: service --auto in ROADMAP.md → done';
    expect(stripNoise(s)).toBe(s);
  });
});

describe('speechTokens', () => {
  it('emits a lead token for an unwrapped plain-language verb', () => {
    const t = speechTokens('finished: Re-font body — calmer UI');
    expect(t[0]).toEqual({ kind: 'lead', text: 'finished' });
    expect(t[1]).toEqual({ kind: 'text', text: 'Re-font body — calmer UI' });
    expect(speechTokens('working on: X')[0]).toEqual({ kind: 'lead', text: 'working on' });
    expect(speechTokens('ready for review: X')[0]).toEqual({ kind: 'lead', text: 'ready for review' });
  });
  it('passes plain prose through as a single text token', () => {
    expect(speechTokens('on it — checking the deploy')).toEqual([
      { kind: 'text', text: 'on it — checking the deploy' },
    ]);
  });
  it('tokenizes refs, code, and collapses a ULID', () => {
    const t = speechTokens('Shipped `service --auto` in #343 (lane 01KY1F9DXYVTRXH4FM2SBC23TX)');
    expect(t).toContainEqual({ kind: 'code', text: 'service --auto' });
    expect(t).toContainEqual({ kind: 'ref', text: '#343' });
    expect(t).toContainEqual({
      kind: 'id',
      text: '01KY1F…23TX',
      title: '01KY1F9DXYVTRXH4FM2SBC23TX',
    });
  });
  it('does not mistake mid-sentence verbs for a lead', () => {
    const t = speechTokens('I opened the door');
    expect(t[0]!.kind).toBe('text');
  });
  it('speechLength counts visible chars across tokens', () => {
    const t = speechTokens('see #343 now');
    expect(speechLength(t)).toBe('see #343 now'.length);
  });
});

describe('shapeSpeech', () => {
  it('shapes a short line into an unclamped glance == full', () => {
    const s = shapeSpeech('on it — checking the deploy');
    expect(s.glance).toBe('on it — checking the deploy');
    expect(s.full).toBe(s.glance);
    expect(s.clamped).toBe(false);
  });
  it('clamps a long body: glance shorter than full, clamped flag set', () => {
    const raw = 'x'.repeat(400);
    const s = shapeSpeech(raw);
    expect(s.glance.length).toBeLessThanOrEqual(GLANCE_MAX + 1);
    expect(s.clamped).toBe(true);
    expect(s.full.length).toBeGreaterThan(s.glance.length);
  });
  it('gives status_update a tighter glance budget', () => {
    const raw = 'word '.repeat(60).trim();
    const status = shapeSpeech(raw, 'status_update');
    const message = shapeSpeech(raw, 'message');
    expect(status.glance.length).toBeLessThanOrEqual(GLANCE_MAX_STATUS + 1);
    expect(message.glance.length).toBeGreaterThan(status.glance.length);
  });
  it('caps full text at FULL_MAX', () => {
    const s = shapeSpeech('y'.repeat(FULL_MAX + 500));
    expect(s.full.length).toBeLessThanOrEqual(FULL_MAX + 1);
  });
  it('passes a body-less act label through untouched', () => {
    const s = shapeSpeech('accepted the handoff');
    expect(s.glance).toBe('accepted the handoff');
    expect(s.clamped).toBe(false);
  });
});

describe('typeCadence', () => {
  it('is clamped to a comfortable per-char range', () => {
    expect(typeCadence(1)).toBe(55); // very short → slowest allowed
    expect(typeCadence(1000)).toBe(16); // very long → fastest allowed
    const mid = typeCadence(50);
    expect(mid).toBeGreaterThanOrEqual(16);
    expect(mid).toBeLessThanOrEqual(55);
  });
  it('types a full glance in roughly three seconds', () => {
    const total = GLANCE_MAX * typeCadence(GLANCE_MAX);
    expect(total).toBeGreaterThan(2200);
    expect(total).toBeLessThan(3800);
  });
});

describe('speechAddressee', () => {
  it('names the member a directed act is aimed at', () => {
    // The bug this fixes: "You were right, I will take the handoff…" floating with no "you".
    expect(speechAddressee({ kind: 'member', name: 'ryder' }, 'miley')).toEqual({
      names: ['ryder'],
      label: 'ryder',
      tether: true,
    });
  });

  it('says nothing for a team act — team is the default, so a chip on every bubble is noise', () => {
    expect(speechAddressee({ kind: 'team' }, 'miley')).toBeNull();
  });

  it('says nothing for a broadcast act', () => {
    expect(speechAddressee({ kind: 'broadcast' }, 'miley')).toBeNull();
  });

  it('keeps the chip but drops the tether when a seat addresses itself', () => {
    // A zero-length arc from a desk back to the same desk is a smudge, not a signal.
    expect(speechAddressee({ kind: 'member', name: 'miley' }, 'miley')).toEqual({
      names: ['miley'],
      label: 'miley',
      tether: false,
    });
  });

  it('is case-sensitive about self-addressing only on an exact seat-name match', () => {
    // Seat names are exact identifiers; "Miley" is not "miley" and must not be collapsed.
    expect(speechAddressee({ kind: 'member', name: 'Miley' }, 'miley')).toEqual({
      names: ['Miley'],
      label: 'Miley',
      tether: true,
    });
  });
});

/**
 * ADR 254 eligible sets. An act addressed to 2-4 seats travels as `to: {kind:'team'}` with the
 * names in `meta.eligible`, so every surface reading `to` alone saw it as unaddressed — 35 acts in
 * the live corpus, 28 of them review routing, drawn as a megaphone to nobody while the CLI printed
 * the names. These cases are the whole of what makes the chip and trace fire for them.
 */
describe('speechAddressee — the eligible set', () => {
  const TEAM = { kind: 'team' } as const;

  it('names every seat in the set, not one of them', () => {
    // eligible[0] would be a single addressee the ledger does not have: any of them discharges it.
    expect(speechAddressee(TEAM, 'miley', ['ryder', 'sloane'])).toEqual({
      names: ['ryder', 'sloane'],
      label: 'ryder or sloane',
      tether: true,
    });
  });

  it('reads as a list at the cap of four', () => {
    expect(speechAddressee(TEAM, 'miley', ['ryder', 'sloane', 'dolly', 'stanley'])?.label).toBe(
      'ryder, sloane, dolly or stanley',
    );
  });

  it('keeps the sender in the label but never lets a lone self-address stand', () => {
    // A set that names the sender alongside others is honest — they really are eligible — but a
    // "set" whose only other member is the sender has no arc worth drawing.
    expect(speechAddressee(TEAM, 'miley', ['miley', 'ryder'])?.names).toEqual(['miley', 'ryder']);
    expect(speechAddressee(TEAM, 'miley', ['miley', 'miley'])).toBeNull();
  });

  it('ignores a one-name set — that is a member act that took the wrong road', () => {
    expect(speechAddressee(TEAM, 'miley', ['ryder'])).toBeNull();
  });

  it('still says nothing for a plain team or broadcast act', () => {
    // The default audience. Only an eligible set earns a chip on a non-member act.
    expect(speechAddressee(TEAM, 'miley', null)).toBeNull();
    expect(speechAddressee(TEAM, 'miley')).toBeNull();
    expect(speechAddressee({ kind: 'broadcast' }, 'miley', ['ryder', 'sloane'])?.label).toBe(
      'ryder or sloane',
    );
  });

  it('lets a member recipient win over any eligible set on the same envelope', () => {
    // Both shapes present is a protocol contradiction; `to` is the routed truth, so it decides.
    expect(speechAddressee({ kind: 'member', name: 'ryder' }, 'miley', ['dolly', 'sloane'])).toEqual(
      { names: ['ryder'], label: 'ryder', tether: true },
    );
  });
});
