import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { MusterdError } from '../errors.js';
import { addMember } from './members.js';
import {
  clearMemory,
  getMemory,
  MEMORY_BODY_MAX_BYTES,
  MEMORY_HEADLINE_MAX_CHARS,
  memoryEnvelope,
  saveMemory,
} from './memory.js';
import { createTeam } from './teams.js';

function seed() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'revive' });
  const memberId = addMember(db, team, { name: 'stanley', kind: 'agent' }).row.id;
  return { db, memberId };
}

describe('seat memory (ADR 093)', () => {
  it('save → get round-trips headline/body/saved_at; envelope() has no body', () => {
    const { db, memberId } = seed();
    saveMemory(db, memberId, { headline: 'h', body: 'b' });
    const m = getMemory(db, memberId)!;
    expect(m.headline).toBe('h');
    expect(m.body).toBe('b');
    expect(typeof m.saved_at).toBe('number');
    const env = memoryEnvelope(db, memberId)!;
    expect(env).toEqual({ headline: 'h', saved_at: expect.any(Number), size_bytes: 1 });
    expect('body' in env).toBe(false);
  });

  it('is last-write-wins (single row per member)', () => {
    const { db, memberId } = seed();
    saveMemory(db, memberId, { headline: 'first', body: 'one' });
    saveMemory(db, memberId, { headline: 'second', body: 'two' });
    const m = getMemory(db, memberId)!;
    expect(m.headline).toBe('second');
    expect(m.body).toBe('two');
  });

  it('rejects a body over 8192 bytes with the named limit', () => {
    const { db, memberId } = seed();
    expect(() => saveMemory(db, memberId, { headline: 'h', body: 'x'.repeat(8193) })).toThrow(
      /8192/,
    );
    try {
      saveMemory(db, memberId, { headline: 'h', body: 'x'.repeat(8193) });
    } catch (e) {
      expect((e as MusterdError).code).toBe('bad_request');
    }
  });

  it('rejects a headline over 120 chars with the named limit', () => {
    const { db, memberId } = seed();
    expect(() => saveMemory(db, memberId, { headline: 'x'.repeat(121), body: 'b' })).toThrow(/120/);
  });

  it('rejects an empty headline', () => {
    const { db, memberId } = seed();
    expect(() => saveMemory(db, memberId, { headline: '', body: 'b' })).toThrow(MusterdError);
  });

  it('accepts a body exactly at the cap and a headline exactly at the cap', () => {
    const { db, memberId } = seed();
    expect(() =>
      saveMemory(db, memberId, {
        headline: 'x'.repeat(MEMORY_HEADLINE_MAX_CHARS),
        body: 'x'.repeat(MEMORY_BODY_MAX_BYTES),
      }),
    ).not.toThrow();
  });

  it('clear removes the row; get/envelope return null after, and reports whether a row existed', () => {
    const { db, memberId } = seed();
    saveMemory(db, memberId, { headline: 'h', body: 'b' });
    expect(clearMemory(db, memberId)).toBe(true);
    expect(getMemory(db, memberId)).toBeNull();
    expect(memoryEnvelope(db, memberId)).toBeNull();
    expect(clearMemory(db, memberId)).toBe(false); // idempotent — nothing left to clear
  });

  it('returns null for a seat that has never saved', () => {
    const { db, memberId } = seed();
    expect(getMemory(db, memberId)).toBeNull();
    expect(memoryEnvelope(db, memberId)).toBeNull();
  });

  it('size_bytes counts UTF-8 bytes, not code units', () => {
    const { db, memberId } = seed();
    saveMemory(db, memberId, { headline: 'h', body: '€€' }); // 3 bytes each → 6
    expect(memoryEnvelope(db, memberId)!.size_bytes).toBe(6);
  });

  it('caps the body on UTF-8 byte length, not code-unit length', () => {
    const { db, memberId } = seed();
    // 2731 '€' = 8193 bytes but only 2731 code units — must still reject on the byte cap.
    expect(() => saveMemory(db, memberId, { headline: 'h', body: '€'.repeat(2731) })).toThrow(
      /8192/,
    );
  });
});
