import { describe, expect, it } from 'vitest';
import { bounceRepair, closestOption, parseIssues } from './repair.js';

/** A bounce exactly as the SDK renders it at the transport seam: the McpError prefix wrapping
 * `ZodError.message`, which is the pretty-printed JSON array of issues (zod v3). */
function sdkBounce(issues: unknown[]): string {
  return (
    'MCP error -32602: Input validation error: Invalid arguments for tool team_send: ' +
    JSON.stringify(issues, null, 2)
  );
}

const enumIssue = {
  received: 'statusupdate',
  code: 'invalid_enum_value',
  options: ['message', 'status_update', 'request_help', 'handoff'],
  path: ['act'],
  message:
    "Invalid enum value. Expected 'message' | 'status_update' | 'request_help' | 'handoff', received 'statusupdate'",
};

const missingIssue = {
  code: 'invalid_type',
  expected: 'string',
  received: 'undefined',
  path: ['body'],
  message: 'Required',
};

describe('parseIssues', () => {
  it('extracts the zod issues array from the SDK bounce text', () => {
    const issues = parseIssues(sdkBounce([enumIssue, missingIssue]));
    expect(issues).toHaveLength(2);
    expect(issues![0]!.code).toBe('invalid_enum_value');
  });

  it('returns null when there is no parseable array', () => {
    expect(parseIssues('Input validation error: something went wrong')).toBeNull();
    expect(parseIssues('Input validation error: [not json')).toBeNull();
  });
});

describe('closestOption', () => {
  it('finds the nearest enum value to a typo', () => {
    expect(closestOption('statusupdate', enumIssue.options)).toBe('status_update');
    expect(closestOption('hand_off', enumIssue.options)).toBe('handoff');
  });

  it('refuses to suggest when nothing is close', () => {
    expect(closestOption('xyzzy-completely-off', enumIssue.options)).toBeUndefined();
  });
});

describe('bounceRepair', () => {
  it('names the valid enum values and the closest one to what was sent', () => {
    const repair = bounceRepair(sdkBounce([enumIssue]));
    expect(repair).toContain('act must be one of message|status_update|request_help|handoff');
    expect(repair).toContain("closest to what you sent is 'status_update'");
    expect(repair).toContain('fix and retry the same call');
  });

  it('names a missing required field', () => {
    expect(bounceRepair(sdkBounce([missingIssue]))).toContain(
      "missing required field 'body' (string)",
    );
  });

  it('covers several issues in one line, capped', () => {
    const repair = bounceRepair(sdkBounce([enumIssue, missingIssue]));
    expect(repair).toContain('act must be one of');
    expect(repair).toContain("missing required field 'body'");
  });

  it('falls back to a generic retry line when the issues are unparseable', () => {
    expect(bounceRepair('Input validation error: mangled')).toContain(
      'check the fields against the tool input schema',
    );
  });

  it('returns nothing for a non-bounce result', () => {
    expect(bounceRepair('error: server exploded')).toBe('');
    // A handler's own prose mentioning validation mid-text must not trigger (start-anchored).
    expect(bounceRepair('note: Input validation error: nope')).toBe('');
  });
});
