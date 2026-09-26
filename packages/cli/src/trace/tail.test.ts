import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Binding,
  TRACE_CONTENT_MAX_BYTES,
  TRACE_POLICY_FILE,
  type TraceEvent,
} from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../client.js';
import { sessionDigest } from '../session/digest.js';
import {
  buildTailEvent,
  readTailCursor,
  readTranscriptDelta,
  TAIL_SESSION_CAP,
  tailTranscript,
  writeTailCursor,
} from './tail.js';

const binding = {
  server: 'http://127.0.0.1:1',
  team: 'revive',
  claim: { mode: 'seat', name: 'ryder' },
  agent_key: 'mskey_test_key',
  seat_credential: 'msac_test',
} as unknown as Binding;

const digest = sessionDigest('mskey_test_key', 'sess-1');

let dir: string;
let transcript: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-tail-'));
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  transcript = join(dir, 'sess-1.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const claudeLine = (messageId: string, block: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-25T21:10:35.130Z',
    message: {
      id: messageId,
      model: 'claude-fable-5',
      content: [block],
      usage: { input_tokens: 2, output_tokens: 5 },
    },
  }) + '\n';

describe('readTranscriptDelta', () => {
  it('reads whole lines from the offset and holds back a partial trailing line', () => {
    writeFileSync(transcript, 'line-one\nline-two\npartial');
    const d = readTranscriptDelta(transcript, 0)!;
    expect(d.lines).toEqual(['line-one', 'line-two']);
    expect(d.nextOffset).toBe('line-one\nline-two\n'.length);
    // Nothing new but the partial: no lines, no advance.
    const again = readTranscriptDelta(transcript, d.nextOffset)!;
    expect(again).toEqual({ lines: [], nextOffset: d.nextOffset });
    // The partial completes: one line, advanced past it.
    appendFileSync(transcript, ' now complete\n');
    const done = readTranscriptDelta(transcript, d.nextOffset)!;
    expect(done.lines).toEqual(['partial now complete']);
  });

  it('is null on an unreadable file (transient), empty at EOF', () => {
    expect(readTranscriptDelta(join(dir, 'nope.jsonl'), 0)).toBeNull();
    writeFileSync(transcript, 'a\n');
    expect(readTranscriptDelta(transcript, 2)).toEqual({ lines: [], nextOffset: 2 });
  });
});

describe('the tail cursor file', () => {
  it('round-trips, prunes to the cap by recency, and starts fresh when unreadable', () => {
    writeTailCursor(dir, digest, { path: transcript, offset: 42, updated_at: 1000 });
    expect(readTailCursor(dir, digest)).toEqual({ path: transcript, offset: 42, updated_at: 1000 });
    for (let i = 0; i < TAIL_SESSION_CAP + 4; i++) {
      writeTailCursor(dir, `d${i}`.padEnd(8, '0'), { path: 'p', offset: i, updated_at: 2000 + i });
    }
    expect(readTailCursor(dir, digest)).toBeUndefined(); // oldest, pruned
    writeFileSync(join(dir, '.musterd', 'trace-tail.json'), 'not json');
    expect(readTailCursor(dir, digest)).toBeUndefined();
  });
});

describe('buildTailEvent', () => {
  const record = {
    kind: 'reasoning' as const,
    ts: 123,
    tool_use_id: 'toolu_A',
    detail: { parser: 'claude-code@1', reasoning_bytes: 20 },
    text: 'thinking about mskey_Zq7xK2mNvB9pLw4R here',
  };

  it('carries content only when asked, scrubbed and bounded (scrub before cut)', () => {
    const structural = buildTailEvent(record, { harness: 'claude-code', digest, content: false })!;
    expect(structural.content).toBeUndefined();
    expect(structural.detail).toEqual(record.detail);

    const withContent = buildTailEvent(record, { harness: 'claude-code', digest, content: true })!;
    expect(withContent.content!.reasoning).toContain('<redacted:agent_key>');
    expect(withContent.content!.reasoning).not.toContain('Zq7xK2mNvB9pLw4R');
    expect(withContent.content!.redactions).toBe(1);

    const huge = buildTailEvent(
      { ...record, text: 'x'.repeat(TRACE_CONTENT_MAX_BYTES + 100) },
      { harness: 'claude-code', digest, content: true },
    )!;
    expect(Buffer.byteLength(huge.content!.reasoning!, 'utf8')).toBeLessThanOrEqual(
      TRACE_CONTENT_MAX_BYTES,
    );
    expect(huge.content!.truncated).toBe(true);
  });

  it('usage and unknown records never carry content, whatever the gates say', () => {
    const usage = buildTailEvent(
      { kind: 'usage', detail: { parser: 'codex@1', input_tokens: 5 } },
      { harness: 'codex', digest, content: true },
    )!;
    expect(usage.content).toBeUndefined();
    expect(usage.kind).toBe('usage');
  });
});

describe('tailTranscript', () => {
  const posted = (): TraceEvent[][] =>
    vi
      .mocked(HttpClient.prototype.postTraceEvents)
      .mock.calls.map((c) => (c[1] as { events: TraceEvent[] }).events);

  beforeEach(() => {
    vi.spyOn(HttpClient.prototype, 'postTraceEvents').mockResolvedValue({
      accepted: 1,
      content: 'off',
    });
  });

  const run = () =>
    tailTranscript({
      binding,
      dir,
      harness: 'claude-code',
      sessionId: 'sess-1',
      transcriptPath: transcript,
      env: {},
    });

  it('posts the delta, advances, and re-reads only what appended since', async () => {
    writeFileSync(transcript, claudeLine('m1', { type: 'thinking', thinking: 'first' }));
    expect(await run()).toBe(true);
    expect(posted()).toHaveLength(1);
    expect(posted()[0]!.map((e) => e.kind)).toEqual(['reasoning', 'usage']);
    expect(posted()[0]![0]!.session_digest).toBe(digest);
    expect(posted()[0]![0]!.content).toBeUndefined(); // policy never heard `on`

    appendFileSync(transcript, claudeLine('m2', { type: 'text', text: 'done' }));
    expect(await run()).toBe(true);
    expect(posted()).toHaveLength(2);
    expect(posted()[1]!.map((e) => e.kind)).toEqual(['assistant_text', 'usage']);

    // Nothing new: no post, still true (the cursor is current).
    expect(await run()).toBe(true);
    expect(posted()).toHaveLength(2);
  });

  it('sends content once the policy cache says on (the 1b gates, applied to R2)', async () => {
    writeFileSync(
      join(dir, '.musterd', TRACE_POLICY_FILE),
      JSON.stringify({ content: 'on', at: 1 }),
    );
    writeFileSync(transcript, claudeLine('m1', { type: 'thinking', thinking: 'private thought' }));
    await run();
    expect(posted()[0]![0]!.content).toEqual({
      reasoning: 'private thought',
      redactions: 0,
      truncated: false,
    });
  });

  it('does not advance the cursor when the post fails, so the next hook retries the delta', async () => {
    vi.mocked(HttpClient.prototype.postTraceEvents).mockRejectedValue(new Error('down'));
    writeFileSync(transcript, claudeLine('m1', { type: 'thinking', thinking: 'x' }));
    expect(await run()).toBe(false);
    expect(readTailCursor(dir, digest)).toBeUndefined();
    vi.mocked(HttpClient.prototype.postTraceEvents).mockResolvedValue({ accepted: 1 });
    expect(await run()).toBe(true);
    expect(readTailCursor(dir, digest)?.offset).toBeGreaterThan(0);
  });

  it('downgrades on a truncated transcript: marker event, cursor flag, then structural-only', async () => {
    writeFileSync(transcript, claudeLine('m1', { type: 'thinking', thinking: 'x' }));
    await run();
    writeFileSync(transcript, ''); // shorter than the cursor — append-only assumption gone
    expect(await run()).toBe(false);
    const marker = posted()[1]![0]!;
    expect(marker.kind).toBe('unknown');
    expect(marker.outcome).toBe('error');
    expect(marker.detail).toMatchObject({ downgraded: true, reason: 'transcript_truncated' });
    expect(readTailCursor(dir, digest)?.downgraded).toBe(true);
    // From then on the session is structural-only: the tail refuses to read it again.
    appendFileSync(transcript, claudeLine('m2', { type: 'text', text: 'y' }));
    expect(await run()).toBe(false);
    expect(posted()).toHaveLength(2);
  });

  it('traces nothing without a parser for the harness, a kill switch set, or no agent key', async () => {
    writeFileSync(transcript, claudeLine('m1', { type: 'text', text: 'x' }));
    expect(
      await tailTranscript({
        binding,
        dir,
        harness: 'grok',
        sessionId: 'sess-1',
        transcriptPath: transcript,
        env: {},
      }),
    ).toBe(false);
    expect(
      await tailTranscript({
        binding,
        dir,
        harness: 'claude-code',
        sessionId: 'sess-1',
        transcriptPath: transcript,
        env: { MUSTERD_NO_TRACE: '1' },
      }),
    ).toBe(false);
    expect(
      await tailTranscript({
        binding: { ...binding, agent_key: undefined } as unknown as Binding,
        dir,
        harness: 'claude-code',
        sessionId: 'sess-1',
        transcriptPath: transcript,
        env: {},
      }),
    ).toBe(false);
    expect(posted()).toHaveLength(0);
  });
});
