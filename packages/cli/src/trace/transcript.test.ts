import { describe, expect, it } from 'vitest';
import {
  CLAUDE_TRANSCRIPT_PARSER,
  CODEX_TRANSCRIPT_PARSER,
  parseClaudeTranscript,
  parseCodexTranscript,
  transcriptParserFor,
  UNKNOWN_RECORD_CAP,
} from './transcript.js';

/** A Claude Code assistant jsonl record — the real shape: one content block per LINE, the same
 *  `message.id` and `usage` repeated on every line of one API message (measured 2026-09-25). */
const claudeLine = (
  messageId: string,
  block: Record<string, unknown>,
  over: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-25T21:10:35.130Z',
    uuid: 'u-' + Math.random().toString(36).slice(2, 8),
    message: {
      id: messageId,
      model: 'claude-fable-5',
      content: [block],
      usage: {
        input_tokens: 2,
        output_tokens: 113,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 77_500,
      },
      ...over,
    },
  });

describe('parseClaudeTranscript', () => {
  it('groups one API message across lines: blocks in order, ONE usage, joined by its tool_use', () => {
    const lines = [
      claudeLine('msg_1', { type: 'thinking', thinking: 'weigh the options', signature: 'x' }),
      claudeLine('msg_1', { type: 'text', text: 'On it.' }),
      claudeLine('msg_1', { type: 'tool_use', id: 'toolu_A', name: 'Bash' }),
    ];
    const records = parseClaudeTranscript(lines);
    expect(records.map((r) => [r.kind, r.tool_use_id])).toEqual([
      ['reasoning', 'toolu_A'],
      ['assistant_text', 'toolu_A'],
      ['usage', 'toolu_A'],
    ]);
    const [reasoning, text, usage] = records;
    expect(reasoning!.text).toBe('weigh the options');
    expect(reasoning!.detail).toEqual({
      parser: CLAUDE_TRANSCRIPT_PARSER,
      reasoning_bytes: 17,
    });
    expect(text!.text).toBe('On it.');
    expect(usage!.detail).toEqual({
      parser: CLAUDE_TRANSCRIPT_PARSER,
      model: 'claude-fable-5',
      input_tokens: 2,
      output_tokens: 113,
      cache_read_tokens: 500,
      cache_creation_tokens: 77_500,
      tool_uses: 1,
    });
    expect(usage!.ts).toBe(Date.parse('2026-09-25T21:10:35.130Z'));
  });

  it('recognised non-assistant types are silent skips; a novel type is `unknown`, never dropped', () => {
    const records = parseClaudeTranscript([
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
      JSON.stringify({ type: 'brand-new-thing', payload: 1 }),
      'not json at all {{{',
    ]);
    expect(records.map((r) => [r.kind, r.detail['type'] ?? r.detail['parse_error']])).toEqual([
      ['unknown', 'brand-new-thing'],
      ['unknown', true],
    ]);
    expect(records.every((r) => typeof r.detail['bytes'] === 'number')).toBe(true);
  });

  it('caps unknown records and counts the suppressed on the last one', () => {
    const lines = Array.from({ length: UNKNOWN_RECORD_CAP + 5 }, (_, i) =>
      JSON.stringify({ type: `novel-${i}` }),
    );
    const records = parseClaudeTranscript(lines);
    expect(records).toHaveLength(UNKNOWN_RECORD_CAP);
    expect(records[records.length - 1]!.detail['suppressed']).toBe(5);
  });

  it('an empty (encrypted) thinking block still yields a structural reasoning record', () => {
    const records = parseClaudeTranscript([
      claudeLine('msg_2', { type: 'thinking', thinking: '', signature: 'sig' }),
    ]);
    expect(records.map((r) => r.kind)).toEqual(['reasoning', 'usage']);
    expect(records[0]!.text).toBeUndefined();
    expect(records[0]!.detail['reasoning_bytes']).toBe(0);
  });
});

/** A Codex rollout line (measured 2026-09-25 on a live rollout). */
const codexLine = (type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: '2026-09-25T18:44:11.273Z', type, payload });

describe('parseCodexTranscript', () => {
  it('binds reasoning to the NEXT tool call, reads summaries, and one usage per token_usage_record', () => {
    const records = parseCodexTranscript([
      codexLine('session_meta', { session_id: 's1', cwd: '/w' }),
      codexLine('response_item', {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: '**Orienting**' }],
        encrypted_content: 'gAAA...',
      }),
      codexLine('response_item', {
        type: 'custom_tool_call',
        call_id: 'call_7',
        name: 'shell',
        input: '{}',
      }),
      codexLine('token_usage_record', {
        session_id: 's1',
        usage: {
          input_tokens: 24_940,
          cached_input_tokens: 20_000,
          output_tokens: 62,
          reasoning_output_tokens: 40,
          total_tokens: 25_002,
        },
      }),
      codexLine('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done.' }],
      }),
      codexLine('event_msg', { type: 'token_count', info: {} }), // superseded — recognised skip
    ]);
    expect(records.map((r) => [r.kind, r.tool_use_id])).toEqual([
      ['reasoning', 'call_7'],
      ['usage', undefined],
      ['assistant_text', undefined],
    ]);
    expect(records[0]!.text).toBe('**Orienting**');
    expect(records[0]!.detail['encrypted']).toBe(true);
    expect(records[1]!.detail).toEqual({
      parser: CODEX_TRANSCRIPT_PARSER,
      input_tokens: 24_940,
      cache_read_tokens: 20_000,
      output_tokens: 62,
      reasoning_tokens: 40,
      total_tokens: 25_002,
    });
  });

  it('flushes unjoined reasoning at an assistant message, and surfaces novel item types', () => {
    const records = parseCodexTranscript([
      codexLine('response_item', {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'final thought' }],
      }),
      codexLine('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Answer.' }],
      }),
      codexLine('response_item', { type: 'hologram', data: 1 }),
      codexLine('world_state', { anything: true }),
    ]);
    expect(records.map((r) => [r.kind, r.tool_use_id ?? r.detail['type']])).toEqual([
      ['reasoning', undefined],
      ['assistant_text', undefined],
      ['unknown', 'response_item.hologram'],
    ]);
  });

  it('user and developer messages are recognised skips (they ride rail R1 as prompts)', () => {
    const records = parseCodexTranscript([
      codexLine('response_item', {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'instructions' }],
      }),
      codexLine('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'do the thing' }],
      }),
    ]);
    expect(records).toEqual([]);
  });
});

describe('transcriptParserFor', () => {
  it('ships Claude Code and Codex; everything else is structural-only (ADR 445 §5)', () => {
    expect(transcriptParserFor('claude-code')).toBe(parseClaudeTranscript);
    expect(transcriptParserFor('codex')).toBe(parseCodexTranscript);
    expect(transcriptParserFor('cursor')).toBeUndefined();
    expect(transcriptParserFor('grok')).toBeUndefined();
  });
});
