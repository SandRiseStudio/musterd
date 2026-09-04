import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCode } from './claudeCode.js';
import { codex } from './codex.js';
import { cursor } from './cursor.js';
import { HARNESSES } from './index.js';

function transcriptWith(model: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'musterd-obs-')), 't.jsonl');
  writeFileSync(p, JSON.stringify({ message: { role: 'assistant', model } }) + '\n', 'utf8');
  return p;
}

describe('observeModel — the even contract', () => {
  // The evenness contract, with exactly one named exception. Absence must be deliberate: a harness
  // that quietly loses its probe is a seat that silently attests a snapshot for the rest of its life,
  // which is the defect this whole slot exists to prevent. So the exception is listed here rather
  // than expressed as "some harnesses have one".
  const NO_PROBE_BY_DECISION = new Set(['cursor']); // ADR 383 — the field misreports the model

  it('EVERY harness declares the slot except the ones deliberately without one', () => {
    for (const h of HARNESSES) {
      if (NO_PROBE_BY_DECISION.has(h.id)) {
        expect(h.observeModel, `${h.id} must NOT declare observeModel (ADR 383)`).toBeUndefined();
        continue;
      }
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

  // ADR 383 supersedes ADR 198's cursor probe. Measured on cursor-agent 2026.09.02-c22c1a3: the
  // hook reported `gemini-3.8-flash` on every event while the session ran kimi-k3. A payload that
  // still carries `model_id` must now produce NOTHING — the point is that musterd stops treating
  // that field as a measurement, not that the field stopped arriving.
  it('cursor observes nothing, even when the payload carries a model_id (ADR 383)', () => {
    expect(cursor.observeModel).toBeUndefined();
    expect(
      cursor.observeModel?.({ model_id: 'gemini-3.8-flash', model: 'thinking-slug' }),
    ).toBeUndefined();
  });

  it('cursor still ignores transcript_path — Cursor JSONL has no message.model', () => {
    expect(
      cursor.observeModel?.({ transcript_path: transcriptWith('claude-opus-4-8') }),
    ).toBeUndefined();
  });
});
