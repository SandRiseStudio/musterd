import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { grokSessionsDirFor, parseGrokUsage, readGrokWakeUsage } from './grokUsage.js';

/** Cut from grokbot's real arm-D wake, 2026-09-21 (session 01a0c5ec…): one turn, four model calls. */
const REAL = {
  sessionId: '01a0c5ec-475f-73a2-b786-15097a6bba73',
  updatedAt: '2026-09-21T21:44:42.777092+00:00',
  session: {
    inputTokens: 284583,
    outputTokens: 3509,
    cachedReadTokens: 147456,
    cacheCreationTokens: 0,
    reasoningTokens: 3245,
    totalTokens: 288092,
    modelCalls: 4,
    costUsdTicks: 1254722400,
    turnCount: 1,
    primaryModelId: 'grok-4.7-build',
  },
  turns: [],
};

describe('parseGrokUsage (ADR 436 clause 2 — a cost reader over the artifact Grok writes)', () => {
  it('maps session totals onto WakeUsage field by field', () => {
    expect(parseGrokUsage(JSON.stringify(REAL))).toEqual({
      input_tokens: 284583,
      output_tokens: 3509,
      cached_input_tokens: 147456,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: 3245,
    });
  });
  it('is undefined on anything that is not the documented shape — never a guess', () => {
    expect(parseGrokUsage('{"session":{"inputTokens":"lots"}}')).toBeUndefined();
    expect(parseGrokUsage('not json')).toBeUndefined();
    expect(parseGrokUsage('{}')).toBeUndefined();
  });
});

describe('readGrokWakeUsage', () => {
  it('reads the newest session started at-or-after the wake under the URL-encoded cwd', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-home-'));
    const ws = '/Users/someone/agents-x';
    const dir = grokSessionsDirFor(home, ws);
    expect(dir).toBe(join(home, 'sessions', encodeURIComponent(ws)));
    const old = join(dir, 'old');
    const mine = join(dir, 'mine');
    mkdirSync(old, { recursive: true });
    mkdirSync(mine, { recursive: true });
    writeFileSync(
      join(old, 'usage.json'),
      JSON.stringify({ ...REAL, session: { ...REAL.session, inputTokens: 1 } }),
    );
    writeFileSync(join(mine, 'usage.json'), JSON.stringify(REAL));
    const startedAt = Date.now() - 60_000;
    const before = (startedAt - 3_600_000) / 1000;
    utimesSync(join(old, 'usage.json'), before, before);
    expect(readGrokWakeUsage(ws, startedAt, home)?.input_tokens).toBe(284583);
  });
  it('is undefined when no session file post-dates the wake', () => {
    const home = mkdtempSync(join(tmpdir(), 'grok-home-'));
    expect(readGrokWakeUsage('/nowhere', Date.now(), home)).toBeUndefined();
  });
});
