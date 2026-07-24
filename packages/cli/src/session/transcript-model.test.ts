import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readModelFromTranscript } from './transcript-model.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'musterd-transcript-'));
}

function fixture(lines: string[]): string {
  const p = join(tmp(), 'transcript.jsonl');
  writeFileSync(p, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  return p;
}

const assistant = (model: string) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', model } });

describe('readModelFromTranscript', () => {
  it('reads the model from the NEWEST assistant message', () => {
    const p = fixture([
      assistant('claude-sonnet-5'),
      JSON.stringify({ type: 'user', message: { role: 'user' } }),
      assistant('claude-opus-4-8'),
    ]);
    expect(readModelFromTranscript(p)).toBe('claude-opus-4-8');
  });

  it('skips the <synthetic> sentinel — it is not a model a seat can run', () => {
    // Real transcripts carry this for synthetic turns; attesting it would be a lie.
    const p = fixture([assistant('claude-opus-4-8'), assistant('<synthetic>')]);
    expect(readModelFromTranscript(p)).toBe('claude-opus-4-8');
  });

  it('tolerates a truncated final line (the harness is mid-write)', () => {
    const p = join(tmp(), 't.jsonl');
    writeFileSync(p, assistant('claude-opus-4-8') + '\n{"type":"assist', 'utf8');
    expect(readModelFromTranscript(p)).toBe('claude-opus-4-8');
  });

  it('returns undefined for an empty file', () => {
    expect(readModelFromTranscript(fixture([]))).toBeUndefined();
  });

  it('returns undefined when no line carries a model (the format moved)', () => {
    const p = fixture([JSON.stringify({ type: 'assistant', message: { role: 'assistant' } })]);
    expect(readModelFromTranscript(p)).toBeUndefined();
  });

  it('returns undefined for a missing file rather than throwing — a hook must never fail', () => {
    expect(readModelFromTranscript('/nonexistent/nope.jsonl')).toBeUndefined();
  });

  it('returns undefined for a directory rather than throwing', () => {
    expect(readModelFromTranscript(tmp())).toBeUndefined();
  });

  it('caps a pathological id at the 120-char wire limit', () => {
    const p = fixture([assistant('x'.repeat(400))]);
    expect(readModelFromTranscript(p)).toHaveLength(120);
  });

  it('finds the newest model in a transcript larger than the tail window', () => {
    // Only the tail is read (transcripts grow unbounded); the newest turn is always at the end.
    const filler = Array.from({ length: 4000 }, () =>
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(200) } }),
    );
    const p = fixture([assistant('claude-sonnet-5'), ...filler, assistant('claude-opus-4-8')]);
    expect(readModelFromTranscript(p)).toBe('claude-opus-4-8');
  });
});
