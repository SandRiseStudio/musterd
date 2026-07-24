import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESSES } from './index.js';
import { claudeCode } from './claudeCode.js';
import { codex } from './codex.js';
import { cursor } from './cursor.js';

function transcriptWith(model: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'musterd-obs-')), 't.jsonl');
  writeFileSync(p, JSON.stringify({ message: { role: 'assistant', model } }) + '\n', 'utf8');
  return p;
}

describe('observeModel — the even contract', () => {
  it('EVERY harness declares the slot (same contract, whatever its fidelity)', () => {
    for (const h of HARNESSES) {
      expect(typeof h.observeModel, `${h.id} must declare observeModel`).toBe('function');
    }
  });

  it('every harness returns undefined for an empty payload rather than throwing', () => {
    for (const h of HARNESSES) {
      expect(() => h.observeModel?.({})).not.toThrow();
      expect(h.observeModel?.({})).toBeUndefined();
    }
  });

  it('every harness returns undefined for an unreadable transcript rather than throwing', () => {
    for (const h of HARNESSES) {
      expect(() => h.observeModel?.({ transcript_path: '/nonexistent/n.jsonl' })).not.toThrow();
      expect(h.observeModel?.({ transcript_path: '/nonexistent/n.jsonl' })).toBeUndefined();
    }
  });

  it('claude-code observes the model from its transcript', () => {
    expect(claudeCode.observeModel?.({ transcript_path: transcriptWith('claude-opus-4-8') })).toBe(
      'claude-opus-4-8',
    );
  });

  it('codex observes the model from its rollout log', () => {
    expect(codex.observeModel?.({ transcript_path: transcriptWith('gpt-5.2-codex') })).toBe(
      'gpt-5.2-codex',
    );
  });

  it('cursor declares its gap explicitly — no probe, so nothing is claimed', () => {
    // Cursor runs no hooks and exposes no per-session record. Returning undefined here is the honest
    // answer: this seat falls back to the declared tier and the doctor says the declaration is all
    // we have, rather than pretending to knowledge musterd does not have.
    expect(
      cursor.observeModel?.({ transcript_path: transcriptWith('claude-opus-4-8') }),
    ).toBeUndefined();
  });
});
