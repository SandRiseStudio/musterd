import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOwnSubagent, recordSubagent, spawnedAgentId } from './subagentLedger.js';

describe('subagent ledger (ADR 442)', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'musterd-subagents-'));

  it('records an id and recognizes only that session’s own subagent', () => {
    const state = dir();
    recordSubagent(state, 's1', 'a1d089450115fa8d2');
    expect(isOwnSubagent(state, 's1', 'a1d089450115fa8d2')).toBe(true);
    expect(isOwnSubagent(state, 's1', 'dolly')).toBe(false);
    expect(isOwnSubagent(state, 's2', 'a1d089450115fa8d2')).toBe(false);
  });

  it('a missing or corrupt file is empty, not an error', () => {
    const state = dir();
    expect(isOwnSubagent(state, 's1', 'x')).toBe(false);
    recordSubagent(state, 's1', 'agent-abc');
    const file = join(state, 'subagents', readdirSync(join(state, 'subagents'))[0]!);
    writeFileSync(file, '{');
    expect(isOwnSubagent(state, 's1', 'agent-abc')).toBe(false);
  });

  it('reads agentId out of the measured Agent tool_response text', () => {
    const raw = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's1',
      tool_response:
        "Async agent launched successfully.\nagentId: a1d089450115fa8d2 (internal ID — Use SendMessage with to: 'a1d089450115fa8d2')",
    });
    expect(spawnedAgentId(raw)).toBe('a1d089450115fa8d2');
  });

  it('reads a JSON tool_response.agentId when a harness exposes one', () => {
    expect(spawnedAgentId(JSON.stringify({ tool_response: { agentId: 'agent-abc' } }))).toBe(
      'agent-abc',
    );
  });
});
