import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readModelFromTranscript, resumeWeightBytes } from './transcript-model.js';

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

describe('resumeWeightBytes (ADR 427 — what a resume replays, not what the file weighs)', () => {
  const user = (text: string) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const attachment = (kind: string, size: number) =>
    JSON.stringify({ type: 'attachment', attachment: { type: kind, content: 'x'.repeat(size) } });
  const hook = () =>
    JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', content: '' } });

  it('counts user and assistant lines and nothing else', () => {
    const conv = [user('hello'), assistant('claude-opus-5'), user('again')];
    const p = fixture([
      attachment('prompt_snapshot', 30_000),
      conv[0]!,
      attachment('deferred_tools_delta', 20_000),
      conv[1]!,
      hook(),
      conv[2]!,
      JSON.stringify({ type: 'cost-state', total: 0.4 }),
    ]);
    const expected = conv.reduce((n, l) => n + Buffer.byteLength(l, 'utf8'), 0);
    expect(resumeWeightBytes(p)).toBe(expected);
    // The file itself is dominated by the attachments — the point of the measure.
    expect(expected).toBeLessThan(60_000);
  });

  it('counts a synthesised (isMeta) user record — it rides the message array on resume', () => {
    const meta = JSON.stringify({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: 'hook' },
    });
    expect(resumeWeightBytes(fixture([meta]))).toBe(Buffer.byteLength(meta, 'utf8'));
  });

  it('skips a truncated final line instead of giving up on the file', () => {
    const p = join(tmp(), 't.jsonl');
    const whole = user('kept');
    writeFileSync(p, whole + '\n{"type":"assist', 'utf8');
    expect(resumeWeightBytes(p)).toBe(Buffer.byteLength(whole, 'utf8'));
  });

  it('is 0 for an empty file and undefined for a missing one — absent is not zero', () => {
    expect(resumeWeightBytes(fixture([]))).toBe(0);
    expect(resumeWeightBytes(join(tmp(), 'nope.jsonl'))).toBeUndefined();
  });

  it('is undefined when no line parses — a file in a shape we do not recognise', () => {
    const p = join(tmp(), 't.jsonl');
    writeFileSync(p, 'not json\nstill not\n', 'utf8');
    expect(resumeWeightBytes(p)).toBeUndefined();
  });
});
