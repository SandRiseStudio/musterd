import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Binding } from '../config.js';
import {
  ORIENT_NUDGE_TEXT,
  orientNudgeDue,
  writeOrientStamp,
} from './session.js';

/** Mirrors the capture suite's temp-workspace idiom: never a real binding.json. */
describe('session orient stamp/nudge', () => {
  let ws: string;

  const bindingOf = (over: Partial<Binding> = {}): Binding =>
    ({
      version: 2,
      server: 'http://127.0.0.1:1',
      team: 'dawn',
      claim: { mode: 'seat', name: 'scout' },
      agent_key: 'mskey_test',
      grant: 'msgr_standing',
      model: 'claude-test-1',
      session: { harness: 'claude-code', id: 'sess-1', started_at: Date.now() },
      ...over,
    }) as Binding;

  const writeBinding = (binding: Binding): void => {
    mkdirSync(join(ws, '.musterd'), { recursive: true });
    writeFileSync(join(ws, '.musterd', 'binding.json'), JSON.stringify(binding, null, 2) + '\n');
  };

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'musterd-orient-'));
    writeBinding(bindingOf());
    delete process.env['MUSTERD_PROVENANCE'];
  });
  afterEach(() => {
    delete process.env['MUSTERD_PROVENANCE'];
  });

  it('nudge is due when no stamp exists', () => {
    expect(orientNudgeDue(ws)).toBe(true);
  });

  it('stamp writes {session_id, oriented_at} keyed to the captured slot id, and quiets the nudge', () => {
    writeOrientStamp(ws);
    const rec = JSON.parse(
      readFileSync(join(ws, '.musterd', 'orient-stamp.json'), 'utf8'),
    ) as { session_id: string; oriented_at: number };
    expect(rec.session_id).toBe('sess-1');
    expect(typeof rec.oriented_at).toBe('number');
    expect(orientNudgeDue(ws)).toBe(false);
  });

  it('a NEW captured session id makes the old stamp stale — nudge fires again', () => {
    writeOrientStamp(ws);
    writeBinding(
      bindingOf({ session: { harness: 'claude-code', id: 'sess-2', started_at: Date.now() } }),
    );
    expect(orientNudgeDue(ws)).toBe(true);
  });

  it('silent outside a seat workspace: no dir, no captured session, or no seat claim', () => {
    expect(orientNudgeDue(null)).toBe(false);
    writeBinding(bindingOf({ session: undefined }));
    expect(orientNudgeDue(ws)).toBe(false);
    writeBinding(bindingOf({ claim: undefined }));
    expect(orientNudgeDue(ws)).toBe(false);
  });

  it('the nudge text names the skill and stays one line', () => {
    expect(ORIENT_NUDGE_TEXT).toContain('musterd-orient');
    expect(ORIENT_NUDGE_TEXT).not.toContain('\n');
  });
});
