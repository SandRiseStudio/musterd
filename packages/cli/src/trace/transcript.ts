/**
 * Rail R2, the transcript parsers (ADR 445 §2, increment 2). Each harness persists its sessions in
 * its own on-disk shape; these turn a batch of transcript lines into the three R2 record kinds —
 * `reasoning`, `assistant_text`, `usage` — plus `unknown` for anything unrecognised.
 *
 * Three properties are the contract, per the ADR:
 *
 * - **Version-stamped.** Every record carries `detail.parser` (`claude-code@1`, `codex@1`), so a
 *   reader can tell which parser's idea of the format produced a row after the format shifts.
 * - **Tolerant, never silent.** The harness's on-disk format is NOT a contract (Anthropic says so).
 *   A line that fails to parse, or a record type this parser has never seen, is emitted as
 *   `{kind:'unknown', detail:{bytes,…}}` — never dropped. Types the parser KNOWS and deliberately
 *   does not emit (a user message R1 already saw as a prompt, a tool_result R1 carries as
 *   tool_response) are recognised skips, so `unknown` stays a real signal.
 * - **Text is separate from structure.** A record's prose (`text`) is returned raw here and gated,
 *   scrubbed and bounded by the tail (`tail.ts`) — the parser never decides whether content flows.
 */

/** Parser stamps — bump the suffix when the parse logic changes shape, not on refactors. */
export const CLAUDE_TRANSCRIPT_PARSER = 'claude-code@1';
export const CODEX_TRANSCRIPT_PARSER = 'codex@1';

/** How many `unknown` records one parse may emit — a novel benign type must surface, not flood.
 *  The last one carries `detail.suppressed` with the count that hit the cap. */
export const UNKNOWN_RECORD_CAP = 8;

/** One R2 record, parsed but not yet an event: the tail owns ts fallback, content gating, digest. */
export interface TranscriptRecord {
  kind: 'reasoning' | 'assistant_text' | 'usage' | 'unknown';
  /** The record's own timestamp (epoch ms) when the transcript carries one. */
  ts?: number;
  /** Join key to rail R1 when derivable (the tool call this reasoning/message led to). */
  tool_use_id?: string;
  detail: Record<string, string | number | boolean | null>;
  /** Raw prose (reasoning / assistant text) — unscrubbed, unbounded; the tail gates it. */
  text?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function isoToMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Emit an `unknown` under the cap; count what the cap suppressed onto the last emitted one. */
class UnknownBudget {
  private emitted = 0;
  private suppressed = 0;
  private last: TranscriptRecord | undefined;

  push(out: TranscriptRecord[], record: TranscriptRecord): void {
    if (this.emitted < UNKNOWN_RECORD_CAP) {
      this.emitted++;
      this.last = record;
      out.push(record);
      return;
    }
    this.suppressed++;
    if (this.last) this.last.detail['suppressed'] = this.suppressed;
  }
}

/* -------------------------------- Claude Code ~/.claude/projects -------------------------------- */

/** Top-level record types the Claude parser KNOWS and deliberately never emits: user turns and tool
 *  results ride rail R1 (prompt / tool_response), the rest is harness bookkeeping. Measured on live
 *  transcripts 2026-09-25; a type outside this set and `assistant` is `unknown` by contract. */
const CLAUDE_SKIP_TYPES = new Set([
  'user',
  'system',
  'summary',
  'progress',
  'attachment',
  'file-history-snapshot',
  'mode',
  'permission-mode',
  'ai-title',
  'atis-latch',
  'bridge-session',
  'last-prompt',
  'queued-command',
  'compact-boundary',
  'todo',
  'plan',
]);

interface ClaudeGroup {
  ts?: number | undefined;
  model?: string | undefined;
  usage?: Record<string, unknown> | undefined;
  toolUseIds: string[];
  /** In content-block order across the group's lines: thinking and text blocks. */
  blocks: { kind: 'reasoning' | 'assistant_text'; text: string }[];
}

/**
 * Parse a delta of Claude Code transcript lines. One API message arrives as SEVERAL jsonl records —
 * same `message.id`, one content block each, the same `usage` repeated on every one — so records are
 * grouped by `message.id` first: one `usage` per message (not per line), and the message's first
 * `tool_use` block's id joins every record of the group to rail R1.
 */
export function parseClaudeTranscript(lines: readonly string[]): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  const unknowns = new UnknownBudget();
  const groups = new Map<string, ClaudeGroup>();
  const order: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      const json: unknown = JSON.parse(line);
      if (typeof json !== 'object' || json === null) throw new Error('not an object');
      o = json as Record<string, unknown>;
    } catch {
      unknowns.push(out, {
        kind: 'unknown',
        detail: { parser: CLAUDE_TRANSCRIPT_PARSER, bytes: bytes(line), parse_error: true },
      });
      continue;
    }
    const type = str(o['type']);
    if (type === 'assistant') {
      collectClaudeAssistant(o, groups, order);
      continue;
    }
    if (type !== undefined && CLAUDE_SKIP_TYPES.has(type)) continue;
    unknowns.push(out, {
      kind: 'unknown',
      detail: {
        parser: CLAUDE_TRANSCRIPT_PARSER,
        bytes: bytes(line),
        ...(type ? { type: type.slice(0, 64) } : {}),
      },
    });
  }

  for (const id of order) {
    const g = groups.get(id)!;
    const join = g.toolUseIds[0];
    for (const block of g.blocks) {
      out.push({
        kind: block.kind,
        ...(g.ts !== undefined ? { ts: g.ts } : {}),
        ...(join ? { tool_use_id: join } : {}),
        detail: {
          parser: CLAUDE_TRANSCRIPT_PARSER,
          [block.kind === 'reasoning' ? 'reasoning_bytes' : 'assistant_bytes']: bytes(block.text),
        },
        ...(block.text ? { text: block.text } : {}),
      });
    }
    const u = g.usage;
    if (u) {
      out.push({
        kind: 'usage',
        ...(g.ts !== undefined ? { ts: g.ts } : {}),
        ...(join ? { tool_use_id: join } : {}),
        detail: {
          parser: CLAUDE_TRANSCRIPT_PARSER,
          ...(g.model ? { model: g.model.slice(0, 128) } : {}),
          ...pickTokens(u, {
            input_tokens: 'input_tokens',
            output_tokens: 'output_tokens',
            cache_read_tokens: 'cache_read_input_tokens',
            cache_creation_tokens: 'cache_creation_input_tokens',
          }),
          tool_uses: g.toolUseIds.length,
        },
      });
    }
  }
  return out;
}

function collectClaudeAssistant(
  o: Record<string, unknown>,
  groups: Map<string, ClaudeGroup>,
  order: string[],
): void {
  const message = o['message'];
  if (typeof message !== 'object' || message === null) return;
  const m = message as Record<string, unknown>;
  // A message with no id still groups — by line, which loses only the usage dedupe.
  const id = str(m['id']) ?? `line-${order.length}-${groups.size}`;
  let g = groups.get(id);
  if (!g) {
    g = { toolUseIds: [], blocks: [] };
    groups.set(id, g);
    order.push(id);
  }
  g.ts ??= isoToMs(o['timestamp']);
  g.model ??= str(m['model']);
  const usage = m['usage'];
  if (g.usage === undefined && typeof usage === 'object' && usage !== null) {
    g.usage = usage as Record<string, unknown>;
  }
  const content = m['content'];
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    const type = str(b['type']);
    if (type === 'thinking') {
      g.blocks.push({ kind: 'reasoning', text: str(b['thinking']) ?? '' });
    } else if (type === 'text') {
      g.blocks.push({ kind: 'assistant_text', text: str(b['text']) ?? '' });
    } else if (type === 'tool_use') {
      const toolId = str(b['id']);
      if (toolId) g.toolUseIds.push(toolId);
    }
    // redacted_thinking, server_tool_use, … — recognised structure inside a known record type;
    // nothing to emit and nothing unknown about the LINE, so no `unknown` record either.
  }
}

/** Copy the token counters a usage object carries onto detail under our column spellings. */
function pickTokens(
  usage: Record<string, unknown>,
  map: Record<string, string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ours, theirs] of Object.entries(map)) {
    const v = num(usage[theirs]);
    if (v !== undefined) out[ours] = v;
  }
  return out;
}

/* ---------------------------------- Codex ~/.codex/sessions ---------------------------------- */

/** Top-level rollout types the Codex parser knows and never emits. `event_msg` is handled apart
 *  (its `token_count` is superseded by `token_usage_record`, which carries the same counters plus
 *  turn identity — emitting both would double every usage row). */
const CODEX_SKIP_TYPES = new Set([
  'session_meta',
  'turn_context',
  'compacted',
  'world_state',
  'event_msg',
]);

/** `response_item` payload types recognised and skipped: the call and its output ride rail R1. */
const CODEX_SKIP_ITEMS = new Set([
  'custom_tool_call',
  'custom_tool_call_output',
  'function_call',
  'function_call_output',
  'web_search_call',
  'local_shell_call',
  'local_shell_call_output',
]);

/**
 * Parse a delta of Codex rollout lines. Codex writes reasoning and the tool call it led to as
 * SEPARATE `response_item` records, so the join is positional: a reasoning item binds to the next
 * tool call's `call_id` in the same delta (flushed unjoined at an assistant message or the delta's
 * end). Reasoning bodies are encrypted at rest — what the rollout has in the clear is the summary,
 * and that is what `text` carries; `detail.encrypted` says when a body existed that we cannot read.
 */
export function parseCodexTranscript(lines: readonly string[]): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  const unknowns = new UnknownBudget();
  /** Reasoning records waiting for the tool call that follows them. */
  let pending: TranscriptRecord[] = [];
  const flush = (toolUseId?: string): void => {
    for (const r of pending) {
      if (toolUseId) r.tool_use_id = toolUseId;
      out.push(r);
    }
    pending = [];
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      const json: unknown = JSON.parse(line);
      if (typeof json !== 'object' || json === null) throw new Error('not an object');
      o = json as Record<string, unknown>;
    } catch {
      unknowns.push(out, {
        kind: 'unknown',
        detail: { parser: CODEX_TRANSCRIPT_PARSER, bytes: bytes(line), parse_error: true },
      });
      continue;
    }
    const type = str(o['type']);
    const ts = isoToMs(o['timestamp']);
    const payload =
      typeof o['payload'] === 'object' && o['payload'] !== null
        ? (o['payload'] as Record<string, unknown>)
        : undefined;

    if (type === 'response_item' && payload) {
      const itemType = str(payload['type']);
      if (itemType === 'reasoning') {
        const summary = Array.isArray(payload['summary']) ? payload['summary'] : [];
        const text = summary
          .map((s) =>
            typeof s === 'object' && s !== null
              ? (str((s as Record<string, unknown>)['text']) ?? '')
              : '',
          )
          .filter(Boolean)
          .join('\n\n');
        pending.push({
          kind: 'reasoning',
          ...(ts !== undefined ? { ts } : {}),
          detail: {
            parser: CODEX_TRANSCRIPT_PARSER,
            reasoning_bytes: bytes(text),
            encrypted: str(payload['encrypted_content']) !== undefined,
          },
          ...(text ? { text } : {}),
        });
        continue;
      }
      if (itemType === 'message') {
        if (str(payload['role']) === 'assistant') {
          flush();
          const content = Array.isArray(payload['content']) ? payload['content'] : [];
          for (const block of content) {
            if (typeof block !== 'object' || block === null) continue;
            const text = str((block as Record<string, unknown>)['text']) ?? '';
            out.push({
              kind: 'assistant_text',
              ...(ts !== undefined ? { ts } : {}),
              detail: { parser: CODEX_TRANSCRIPT_PARSER, assistant_bytes: bytes(text) },
              ...(text ? { text } : {}),
            });
          }
        }
        continue; // user/developer messages ride rail R1 as prompts — recognised skips
      }
      if (itemType !== undefined && CODEX_SKIP_ITEMS.has(itemType)) {
        const callId = str(payload['call_id']);
        if (callId && (itemType === 'custom_tool_call' || itemType === 'function_call')) {
          flush(callId);
        }
        continue;
      }
      unknowns.push(out, {
        kind: 'unknown',
        detail: {
          parser: CODEX_TRANSCRIPT_PARSER,
          bytes: bytes(line),
          ...(itemType ? { type: `response_item.${itemType}`.slice(0, 64) } : {}),
        },
      });
      continue;
    }

    if (type === 'token_usage_record' && payload) {
      const usage =
        typeof payload['usage'] === 'object' && payload['usage'] !== null
          ? (payload['usage'] as Record<string, unknown>)
          : {};
      out.push({
        kind: 'usage',
        ...(ts !== undefined ? { ts } : {}),
        detail: {
          parser: CODEX_TRANSCRIPT_PARSER,
          ...pickTokens(usage, {
            input_tokens: 'input_tokens',
            output_tokens: 'output_tokens',
            cache_read_tokens: 'cached_input_tokens',
            reasoning_tokens: 'reasoning_output_tokens',
            total_tokens: 'total_tokens',
          }),
        },
      });
      continue;
    }

    if (type !== undefined && CODEX_SKIP_TYPES.has(type)) continue;
    unknowns.push(out, {
      kind: 'unknown',
      detail: {
        parser: CODEX_TRANSCRIPT_PARSER,
        bytes: bytes(line),
        ...(type ? { type: type.slice(0, 64) } : {}),
      },
    });
  }
  flush();
  return out;
}

/** The parser for a harness, or undefined — R2 ships Claude Code and Codex first (ADR 445 §5). */
export function transcriptParserFor(
  harness: string,
): ((lines: readonly string[]) => TranscriptRecord[]) | undefined {
  if (harness === 'claude-code') return parseClaudeTranscript;
  if (harness === 'codex') return parseCodexTranscript;
  return undefined;
}
