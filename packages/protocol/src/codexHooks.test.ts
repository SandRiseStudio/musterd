import { describe, expect, it } from 'vitest';
import { parseCodexHookEvent } from './codexHooks.js';

describe('Codex hook event boundary', () => {
  it('accepts SessionStart only for the start command', () => {
    expect(
      parseCodexHookEvent(
        JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/workspace' }),
        'start',
      ),
    ).toEqual({ event: 'start', session_id: 's1', cwd: '/workspace' });
  });

  it('accepts PostToolUse model evidence without a transcript', () => {
    expect(
      parseCodexHookEvent(
        JSON.stringify({
          hook_event_name: 'PostToolUse',
          session_id: 's1',
          cwd: '/workspace',
          model: 'gpt-5.6',
        }),
        'post-tool-use',
      ),
    ).toEqual({ event: 'post-tool-use', session_id: 's1', cwd: '/workspace', model: 'gpt-5.6' });
  });

  it('rejects an event/subcommand mismatch, malformed values, and unknown events', () => {
    expect(
      parseCodexHookEvent('{"hook_event_name":"SessionEnd","session_id":"s1","cwd":"/w"}', 'start'),
    ).toBeUndefined();
    expect(
      parseCodexHookEvent(
        '{"hook_event_name":"PostToolUse","session_id":"s1","cwd":"/w"}',
        'post-tool-use',
      ),
    ).toBeUndefined();
    expect(
      parseCodexHookEvent('{"hook_event_name":"Unknown","session_id":"s1","cwd":"/w"}', 'start'),
    ).toBeUndefined();
  });
});
