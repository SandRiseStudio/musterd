import { describe, expect, it } from 'vitest';
import { TOKEN_PREFIXES } from './credentials.js';
import { TRACE_EVENT_KINDS } from './trace.js';
import {
  isStructuralToolName,
  normalizeTraceDetail,
  structuralToolName,
  SyncTracePushRequestSchema,
  SyncTraceRowSchema,
  TRACE_DETAIL_KEYS_BY_KIND,
  TRACE_MODEL_RE,
  TRACE_OTHER,
  TRACE_STRUCTURAL_DETAIL_KEYS,
  TRACE_TOOL_NAMESPACES,
  traceStructuralDetailSchema,
} from './traceSync.js';

/** A syntactically valid credential for each registered prefix — the value big-body asked every
 *  field to be tested against (ADR 453 §2): prefix + 43 base64url chars, as the minter shapes them. */
const credentials = Object.values(TOKEN_PREFIXES).map(
  (p) => `${p}${'A1b2C3d4'.repeat(6).slice(0, 43)}`,
);
const PROSE = ['see /Users/x/.env', 'customer project summary', 'a\nb', 'customer-project-summary'];

const row = (over: Record<string, unknown> = {}) => ({
  id: '01J8ZK6Y3W6XQ2R9F4M2N7P8QA',
  seat: 'ryder',
  session_digest: 'deadbeef0123',
  seq: 0,
  ts: 1_790_000_000_000,
  received_at: 1_790_000_000_001,
  harness: 'claude-code',
  kind: 'PostToolUse',
  tool_name: 'Bash',
  tool_use_id: '0123456789abcdef01234567',
  agent_id: null,
  parent_agent_id: null,
  duration_ms: 42,
  outcome: 'ok',
  detail: { tool_input_bytes: 120, tool_response_bytes: 900 },
  ...over,
});

describe('SyncTraceRow (ADR 453 §2) — no field can carry prose or a credential', () => {
  it('accepts a conforming row and refuses a content field outright', () => {
    expect(SyncTraceRowSchema.safeParse(row()).success).toBe(true);
    expect(SyncTraceRowSchema.safeParse(row({ content: { tool_input: 'ls' } })).success).toBe(
      false,
    );
    expect(SyncTraceRowSchema.safeParse(row({ redactions: 0 })).success).toBe(false);
  });

  it('rejects a credential-shaped value in every string field', () => {
    for (const c of credentials) {
      expect(SyncTraceRowSchema.safeParse(row({ tool_name: c })).success, c).toBe(false);
      expect(SyncTraceRowSchema.safeParse(row({ tool_use_id: c })).success, c).toBe(false);
      expect(SyncTraceRowSchema.safeParse(row({ agent_id: c })).success, c).toBe(false);
      expect(SyncTraceRowSchema.safeParse(row({ seat: c })).success, c).toBe(false);
      expect(
        SyncTraceRowSchema.safeParse(row({ kind: 'usage', detail: { model: c } })).success,
        c,
      ).toBe(false);
      expect(
        SyncTraceRowSchema.safeParse(row({ kind: 'HookOutcome', detail: { hook: c } })).success,
        c,
      ).toBe(false);
      expect(
        SyncTraceRowSchema.safeParse(row({ kind: 'unknown', detail: { type: c } })).success,
        c,
      ).toBe(false);
    }
  });

  it('the model pattern can never match a musterd credential — every prefix carries an underscore', () => {
    for (const p of Object.values(TOKEN_PREFIXES)) {
      expect(p, p).toContain('_');
      expect(TRACE_MODEL_RE.test(`${p}abc`), p).toBe(false);
    }
    expect(TRACE_MODEL_RE.test('claude-opus-5-5')).toBe(true);
    expect(TRACE_MODEL_RE.test('claude-fable-5-1')).toBe(true);
    expect(TRACE_MODEL_RE.test('gpt-6-luna')).toBe(true);
    expect(TRACE_MODEL_RE.test('Claude-Opus')).toBe(false);
  });

  it('rejects prose in tool_name and detail, and an unlisted detail key', () => {
    for (const p of PROSE) {
      expect(SyncTraceRowSchema.safeParse(row({ tool_name: p })).success, p).toBe(false);
      expect(
        SyncTraceRowSchema.safeParse(row({ kind: 'SessionEnd', detail: { reason: p } })).success,
        p,
      ).toBe(false);
    }
    expect(SyncTraceRowSchema.safeParse(row({ detail: { note: 'hi' } })).success).toBe(false);
    // a count typed as a string, a flag typed as a number
    expect(SyncTraceRowSchema.safeParse(row({ detail: { tool_input_bytes: '120' } })).success).toBe(
      false,
    );
    expect(
      SyncTraceRowSchema.safeParse(row({ kind: 'HookOutcome', detail: { raised: 1 } })).success,
    ).toBe(false);
  });

  it('accepts `other` as the sentinel for a normalized unknown, in tool_name and every enum', () => {
    expect(SyncTraceRowSchema.safeParse(row({ tool_name: TRACE_OTHER })).success).toBe(true);
    expect(
      SyncTraceRowSchema.safeParse(row({ kind: 'SessionEnd', detail: { reason: TRACE_OTHER } }))
        .success,
    ).toBe(true);
    expect(
      SyncTraceRowSchema.safeParse(
        row({ kind: 'unknown', detail: { type: TRACE_OTHER, bytes: 3 } }),
      ).success,
    ).toBe(true);
  });

  it('ids are 24-hex digests, never the harness raw form', () => {
    expect(SyncTraceRowSchema.safeParse(row({ tool_use_id: 'toolu_01ABCDEF' })).success).toBe(
      false,
    );
    expect(SyncTraceRowSchema.safeParse(row({ tool_use_id: 'call-8f3a9c' })).success).toBe(false);
    expect(SyncTraceRowSchema.safeParse(row({ tool_use_id: null })).success).toBe(true);
  });

  it('the request is strict and bounded', () => {
    expect(SyncTracePushRequestSchema.safeParse({ rows: [row()] }).success).toBe(true);
    expect(SyncTracePushRequestSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(SyncTracePushRequestSchema.safeParse({ rows: [row()], extra: 1 }).success).toBe(false);
  });
});

describe('tool_name namespaces (ADR 453 §2)', () => {
  it('passes every built-in and any mcp__<server>__<tool>; normalizes the rest to `other`', () => {
    for (const [harness, names] of Object.entries(TRACE_TOOL_NAMESPACES)) {
      for (const n of names)
        expect(structuralToolName(harness, n)).toEqual({ name: n, normalized: false });
    }
    for (const n of [
      'mcp__musterd__team_send',
      'mcp__codex_apps__github__fetch_pr',
      'mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot',
    ]) {
      expect(structuralToolName('claude-code', n)).toEqual({ name: n, normalized: false });
      expect(isStructuralToolName('codex', n)).toBe(true);
    }
    for (const n of ['customer-project-summary', 'see/this', 'a b', ...credentials]) {
      expect(structuralToolName('claude-code', n)).toEqual({ name: TRACE_OTHER, normalized: true });
      expect(isStructuralToolName('claude-code', n)).toBe(false);
    }
    // a built-in of one harness is not a name in another's namespace
    expect(structuralToolName('codex', 'ToolSearch').name).toBe(TRACE_OTHER);
    expect(structuralToolName('claude-code', null)).toEqual({ name: null, normalized: false });
    expect(isStructuralToolName('claude-code', TRACE_OTHER)).toBe(true);
  });
});

describe('per-kind structural detail (ADR 453 §2)', () => {
  it('every kind has a key list and every listed key has a type', () => {
    for (const kind of TRACE_EVENT_KINDS) {
      expect(TRACE_DETAIL_KEYS_BY_KIND[kind]).toBeDefined();
      const schema = traceStructuralDetailSchema(kind);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ nope: 1 }).success).toBe(false);
    }
    for (const key of TRACE_STRUCTURAL_DETAIL_KEYS) {
      expect(typeof key).toBe('string');
    }
  });

  it('normalizeTraceDetail drops unlisted keys and wrong types, maps unknown enums to `other`', () => {
    expect(
      normalizeTraceDetail('PostToolUse', {
        tool_input_bytes: 120,
        tool_response_bytes: '900',
        note: 'prose',
        hook_event: 'afterShellExecution',
      }),
    ).toEqual({
      detail: { tool_input_bytes: 120, hook_event: 'afterShellExecution' },
      normalized: 2,
    });
    expect(normalizeTraceDetail('SessionEnd', { reason: 'transcript truncated' })).toEqual({
      detail: { reason: TRACE_OTHER },
      normalized: 1,
    });
    expect(normalizeTraceDetail('usage', { model: 'mskey_x', input_tokens: 10 })).toEqual({
      detail: { input_tokens: 10 },
      normalized: 1,
    });
    expect(normalizeTraceDetail('usage', null)).toEqual({ detail: null, normalized: 0 });
    // what the normalizer emits always passes the per-kind schema
    for (const kind of TRACE_EVENT_KINDS) {
      const out = normalizeTraceDetail(kind, { garbage: 'x', reason: 'y', model: 'Bad_Model' });
      if (out.detail)
        expect(traceStructuralDetailSchema(kind).safeParse(out.detail).success).toBe(true);
    }
  });
});
