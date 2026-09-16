import { describe, expect, it } from 'vitest';
import { emptyPoolCopy, emptyPoolFromCandidates, emptyPoolHint } from './lanes.js';

describe('emptyPoolFromCandidates (ADR 404)', () => {
  it('is null when a reviewer was selected', () => {
    expect(
      emptyPoolFromCandidates({ reviewer: 'miley' }, [
        { member: 'wanderer', exclusion: 'self' },
        { member: 'miley' },
      ]),
    ).toBeNull();
  });

  it('no_live_member when everyone else is out, a service, or the worker', () => {
    expect(
      emptyPoolFromCandidates(null, [
        { member: 'wanderer', exclusion: 'self' },
        { member: 'guardian', exclusion: 'service_or_observer' },
        { member: 'izzo', exclusion: 'no_live_presence' },
      ]),
    ).toEqual({ kind: 'no_live_member' });
  });

  it('live_ineligible names busy live seats', () => {
    expect(
      emptyPoolFromCandidates(null, [
        { member: 'wanderer', exclusion: 'self' },
        { member: 'miley', exclusion: 'busy' },
        { member: 'stanley', exclusion: 'busy' },
        { member: 'big-body', exclusion: 'no_live_presence' },
      ]),
    ).toEqual({
      kind: 'live_ineligible',
      live: [
        { member: 'miley', exclusion: 'busy' },
        { member: 'stanley', exclusion: 'busy' },
      ],
    });
  });

  it('a live human alone is live_ineligible, not an empty room', () => {
    expect(
      emptyPoolFromCandidates(null, [
        { member: 'wanderer', exclusion: 'self' },
        { member: 'nick', exclusion: 'not_agent' },
      ]),
    ).toEqual({
      kind: 'live_ineligible',
      live: [{ member: 'nick', exclusion: 'not_agent' }],
    });
  });
});

describe('emptyPoolCopy', () => {
  it('names the empty room', () => {
    expect(emptyPoolCopy({ kind: 'no_live_member' })).toBe('no other member is live');
  });

  it('groups live exclusions', () => {
    expect(
      emptyPoolCopy({
        kind: 'live_ineligible',
        live: [
          { member: 'miley', exclusion: 'busy' },
          { member: 'stanley', exclusion: 'busy' },
          { member: 'nick', exclusion: 'not_agent' },
        ],
      }),
    ).toBe('live seats were ineligible (busy: miley, stanley; not_agent: nick)');
  });
});

describe('emptyPoolHint', () => {
  it('keeps the historical sentence when the daemon omitted the field', () => {
    expect(emptyPoolHint(undefined)).toBe('no eligible acceptor is live');
    expect(emptyPoolHint(null)).toBe('no eligible acceptor is live');
  });

  it('defers to emptyPoolCopy when the field is present', () => {
    expect(emptyPoolHint({ kind: 'no_live_member' })).toBe('no other member is live');
  });
});
