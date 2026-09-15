import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptSurface,
  declineSurface,
  declinedPath,
  isDeclined,
  readDeclined,
} from './declined.js';

describe('declined surfaces (ADR 332 — the tombstone)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-declined-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a folder with no file has no refusals', () => {
    expect(readDeclined(dir)).toEqual([]);
    expect(isDeclined(dir, 'claude-code:statusLine')).toBe(false);
  });

  it('records a refusal that survives a re-read, and names who and when', () => {
    expect(declineSurface(dir, 'claude-code:statusLine', 'nick')).toBe(true);
    expect(isDeclined(dir, 'claude-code:statusLine')).toBe(true);
    const [t] = readDeclined(dir);
    expect(t?.by).toBe('nick');
    expect(Number.isNaN(Date.parse(t?.at ?? ''))).toBe(false);
  });

  it('refuses one surface without refusing its neighbours', () => {
    declineSurface(dir, 'claude-code:statusLine');
    expect(isDeclined(dir, 'claude-code:PostToolUse')).toBe(false);
  });

  // The date a resurrection line prints has to be when the user DECIDED, not when they last typed
  // the command — otherwise re-running `decline` quietly rewrites the record of their own history.
  it('is idempotent and keeps the original date', () => {
    declineSurface(dir, 'claude-code:statusLine');
    const first = readDeclined(dir)[0]?.at;
    expect(declineSurface(dir, 'claude-code:statusLine')).toBe(false);
    expect(readDeclined(dir)).toHaveLength(1);
    expect(readDeclined(dir)[0]?.at).toBe(first);
  });

  it('accept clears the refusal and hands back the tombstone it removed', () => {
    declineSurface(dir, 'claude-code:statusLine', 'nick');
    const removed = acceptSurface(dir, 'claude-code:statusLine');
    expect(removed?.by).toBe('nick');
    expect(isDeclined(dir, 'claude-code:statusLine')).toBe(false);
    // Accepting something never declined is a no-op, not an error.
    expect(acceptSurface(dir, 'claude-code:statusLine')).toBeUndefined();
  });

  // Fails OPEN, and the asymmetry is the point: a surface wrongly coming back is visible and
  // recoverable, while a surface silently missing with no record of why is the defect this ends.
  it('treats an unreadable or malformed file as no refusals, never as one', () => {
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    for (const junk of ['{not json', '[]', '{"version":1}', '{"declined":[{"surface":7}]}']) {
      writeFileSync(declinedPath(dir), junk);
      expect(readDeclined(dir)).toEqual([]);
      expect(isDeclined(dir, 'claude-code:statusLine')).toBe(false);
    }
  });

  it('writes a versioned file a human can read and hand-edit', () => {
    declineSurface(dir, 'claude-code:statusLine', 'nick');
    const raw: unknown = JSON.parse(readFileSync(declinedPath(dir), 'utf8'));
    expect(raw).toMatchObject({ version: 1, declined: [{ surface: 'claude-code:statusLine' }] });
  });
});
