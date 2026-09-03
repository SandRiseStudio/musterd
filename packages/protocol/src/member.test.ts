import { describe, expect, it } from 'vitest';
import { MemberSchema, MemberSummarySchema } from './member.js';

const base = {
  id: '01M',
  team: 'revive',
  name: 'miley',
  kind: 'agent',
  created_at: 1,
};

describe('Member.hue (ADR 374)', () => {
  it('carries an integer hue on the wheel, and the summary inherits it', () => {
    expect(MemberSchema.parse({ ...base, hue: 212 }).hue).toBe(212);
    expect(MemberSummarySchema.parse({ ...base, hue: 0, presence: 'offline' }).hue).toBe(0);
  });

  it('is nullish for back-compat — an older daemon omits it, a file without one projects null', () => {
    expect(MemberSchema.parse(base).hue).toBeUndefined();
    expect(MemberSchema.parse({ ...base, hue: null }).hue).toBeNull();
  });

  it('refuses a hue off the wheel', () => {
    expect(() => MemberSchema.parse({ ...base, hue: 360 })).toThrow();
    expect(() => MemberSchema.parse({ ...base, hue: -1 })).toThrow();
    expect(() => MemberSchema.parse({ ...base, hue: 1.5 })).toThrow();
  });
});
