import { describe, expect, it } from 'vitest';
import { coerceToolArgs } from './coerce.js';

/**
 * Every case here is a shape observed in live telemetry between 2026-07-15 and 2026-07-24 (the
 * `tool_call_stats` bounce rows joined to the harness transcripts that produced them) — the rule
 * table is measured, so its tests are too. The "deliberately not coerced" block is the other half
 * of the contract: forgiveness that invents meaning is worse than a bounce.
 */

describe('lane id aliases', () => {
  // 70% of every bounce in the window, from 5 seats across 2 harnesses. Our own results and prose
  // say "lane" while the schema said `id` — agents pattern-matched us and paid a turn for it.
  it('accepts `lane` for `id` (izzo, miley, ryder, stanley)', () => {
    const { args, applied } = coerceToolArgs('lane_claim', { lane: '01KYAG1M52' });
    expect(args).toEqual({ id: '01KYAG1M52' });
    expect(applied).toEqual(['lane→id']);
  });

  it('accepts `lane_id` for `id` (gptbot/Codex, izzo)', () => {
    const { args, applied } = coerceToolArgs('lane_claim', { lane_id: '01KY0MATE2' });
    expect(args).toEqual({ id: '01KY0MATE2' });
    expect(applied).toEqual(['lane_id→id']);
  });

  it('carries the rest of the call through untouched', () => {
    const { args } = coerceToolArgs('lane_claim', {
      lane: '01KYAG1M52',
      branch: 'design/model-attestation-truth',
    });
    expect(args).toEqual({ id: '01KYAG1M52', branch: 'design/model-attestation-truth' });
  });

  it('applies to every lane tool that takes an id', () => {
    for (const tool of ['lane_claim', 'lane_handoff', 'lane_update', 'lane_resolve']) {
      expect(coerceToolArgs(tool, { lane_id: 'x' }).args).toEqual({ id: 'x' });
    }
  });

  it('lets an explicit `id` win over an alias — a caller that sends both meant the real one', () => {
    const { args, applied } = coerceToolArgs('lane_claim', { id: 'real', lane: 'stale' });
    expect(args).toEqual({ id: 'real', lane: 'stale' });
    expect(applied).toEqual([]);
  });
});

describe('team_send recipient shapes', () => {
  it('unwraps a single-element array (gptbot: to:["nick"])', () => {
    const { args, applied } = coerceToolArgs('team_send', { act: 'status_update', to: ['nick'] });
    expect(args['to']).toBe('nick');
    expect(applied).toEqual(['to:[one]→string']);
  });

  it('drops an empty array so the schema default (@team) applies (gptbot: to:[])', () => {
    const { args, applied } = coerceToolArgs('team_send', { act: 'status_update', to: [] });
    expect('to' in args).toBe(false);
    expect(applied).toEqual(['to:[]→default']);
  });

  it('converts a wire Recipient back to the string form (gptbot: to:{kind:"team"})', () => {
    expect(coerceToolArgs('team_send', { to: { kind: 'team' } }).args['to']).toBe('@team');
    expect(coerceToolArgs('team_send', { to: { kind: 'broadcast' } }).args['to']).toBe(
      '@broadcast',
    );
    expect(coerceToolArgs('team_send', { to: { kind: 'member', name: 'nick' } }).args['to']).toBe(
      'nick',
    );
  });

  it('leaves a multi-recipient array to bounce — dropping recipients would lose a message', () => {
    const { args, applied } = coerceToolArgs('team_send', { to: ['nick', 'stanley'] });
    expect(args['to']).toEqual(['nick', 'stanley']);
    expect(applied).toEqual([]);
  });
});

describe('team_send body aliases', () => {
  it('accepts text/content/message for body (gptbot sent all three over two days)', () => {
    expect(coerceToolArgs('team_send', { act: 'status_update', text: 'a' }).args['body']).toBe('a');
    expect(coerceToolArgs('team_send', { act: 'status_update', content: 'b' }).args['body']).toBe(
      'b',
    );
    expect(coerceToolArgs('team_send', { act: 'message', message: 'c' }).args['body']).toBe('c');
  });

  it('does not overwrite a body that is already there', () => {
    const { args } = coerceToolArgs('team_send', { body: 'real', text: 'stale' });
    expect(args['body']).toBe('real');
  });
});

describe('lane_resolve pr', () => {
  it('coerces an unambiguous numeric string', () => {
    expect(coerceToolArgs('lane_resolve', { id: 'x', pr: '343' }).args['pr']).toBe(343);
    expect(coerceToolArgs('lane_resolve', { id: 'x', pr: '#343' }).args['pr']).toBe(343);
  });

  it('leaves pr:"local" alone — attesting a PR that never existed would corrupt the audit join', () => {
    const { args, applied } = coerceToolArgs('lane_resolve', { id: 'x', pr: 'local' });
    expect(args['pr']).toBe('local');
    expect(applied).toEqual([]);
  });

  it('leaves a real number alone', () => {
    expect(coerceToolArgs('lane_resolve', { id: 'x', pr: 343 }).args['pr']).toBe(343);
  });
});

describe('team_memory_save headline derivation', () => {
  // Every measured team_memory_save bounce: a long, carefully-written body rejected over a missing
  // one-line subject. Deriving is lossless here — the body keeps every word.
  it('derives the headline from the first line of the body', () => {
    const { args, applied } = coerceToolArgs('team_memory_save', {
      body: 'Cell-D compliance step-2 parked\n\nDetail follows.',
    });
    expect(args['headline']).toBe('Cell-D compliance step-2 parked');
    expect(applied).toEqual(['headline←body']);
  });

  it('strips markdown ornament from the derived line', () => {
    const { args } = coerceToolArgs('team_memory_save', {
      body: '## Office visual arc — session wrap\nbody text',
    });
    expect(args['headline']).toBe('Office visual arc — session wrap');
  });

  it('clips a long derived headline inside the 120-char cap, on a word boundary', () => {
    const long = 'word '.repeat(60).trim();
    const { args } = coerceToolArgs('team_memory_save', { body: long });
    const headline = args['headline'] as string;
    expect(headline.length).toBeLessThanOrEqual(120);
    expect(headline.endsWith('…')).toBe(true);
    expect(headline).not.toContain('wor…'); // clipped between words, not mid-word
  });

  it('never touches an explicit headline — over the cap it must bounce, not lose the words', () => {
    const over = 'x'.repeat(130);
    const { args, applied } = coerceToolArgs('team_memory_save', { headline: over, body: 'b' });
    expect(args['headline']).toBe(over);
    expect(applied).toEqual([]);
  });

  it('cannot derive from an absent or blank body', () => {
    expect(coerceToolArgs('team_memory_save', {}).applied).toEqual([]);
    expect(coerceToolArgs('team_memory_save', { body: '   \n\n' }).applied).toEqual([]);
  });
});

describe('normalization vs coercion', () => {
  it('trims strings silently — whitespace is not a mistake worth measuring', () => {
    const { args, applied } = coerceToolArgs('lane_claim', { id: '  01KYAG1M52 \n' });
    expect(args['id']).toBe('01KYAG1M52');
    expect(applied).toEqual([]);
  });

  it('is a no-op for tools with no rules, and never mutates the caller object', () => {
    const original = { anything: 1 };
    const { args, applied } = coerceToolArgs('team_status', original);
    expect(applied).toEqual([]);
    expect(args).not.toBe(original);
    expect(original).toEqual({ anything: 1 });
  });

  it('reports nothing applied for an already-valid call', () => {
    expect(
      coerceToolArgs('team_send', { act: 'status_update', body: 'x', to: 'nick' }).applied,
    ).toEqual([]);
  });
});
