import { describe, expect, it } from 'vitest';
import { redactPath } from './log.js';

/**
 * Hard rule 5: a secret never reaches a log. The request log records `path`, and a remote MCP
 * connector URL carries its credential or team in the path (`/mcp/<token>`, ADR 446's `/mcp/:team`),
 * so the path itself must be redacted before it is logged or echoed in an error body.
 */
describe('redactPath', () => {
  it('redacts everything under /mcp/', () => {
    expect(redactPath('/mcp/mscr_abc123')).toBe('/mcp/[redacted]');
    expect(redactPath('/mcp/revive/extra')).toBe('/mcp/[redacted]/[redacted]');
    expect(redactPath('/.well-known/oauth-protected-resource/mcp/revive')).toBe(
      '/.well-known/oauth-protected-resource/mcp/[redacted]',
    );
  });

  it('keeps the bare /mcp mount visible', () => {
    expect(redactPath('/mcp')).toBe('/mcp');
    expect(redactPath('/mcp/')).toBe('/mcp/');
  });

  it('redacts any credential-shaped segment, anywhere, including percent-encoded', () => {
    expect(redactPath('/teams/revive/join/msgr_deadbeef')).toBe('/teams/revive/join/[redacted]');
    expect(redactPath('/x/MSKEY_upper')).toBe('/x/[redacted]');
    expect(redactPath('/x/%6Dscr_encoded')).toBe('/x/[redacted]');
  });

  it('leaves ordinary paths alone', () => {
    expect(redactPath('/teams/revive/lanes')).toBe('/teams/revive/lanes');
    expect(redactPath('/')).toBe('/');
    expect(redactPath('/x/%E0%A4%A')).toBe('/x/%E0%A4%A');
  });
});
