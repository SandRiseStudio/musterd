import { describe, expect, it } from 'vitest';
import { boardUrl, buildOpenCommand, signinUrl } from './board.js';

/**
 * `musterd board` (ADR 170). The two properties worth pinning are both about the secret: the nonce
 * rides the **fragment** (so it never reaches the server or its logs), and the URL the terminal
 * prints carries no nonce at all (so scrollback is clean even though the browser got a live link).
 */
describe('signinUrl / boardUrl (ADR 170)', () => {
  it('puts the nonce in the fragment, never the query string', () => {
    const url = signinUrl('http://127.0.0.1:4849', 'revive', 'nonce123');
    expect(url).toBe('http://127.0.0.1:4849/board?team=revive#s=nonce123');
    const parsed = new URL(url);
    expect(parsed.search).toBe('?team=revive');
    expect(parsed.hash).toBe('#s=nonce123');
    // The nonce must not be reachable as a query parameter — that is what would hit the access log.
    expect(parsed.searchParams.get('s')).toBeNull();
  });

  it('the URL the terminal prints carries no nonce — scrollback stays clean', () => {
    expect(boardUrl('http://127.0.0.1:4849', 'revive')).toBe(
      'http://127.0.0.1:4849/board?team=revive',
    );
    expect(boardUrl('http://127.0.0.1:4849', 'revive')).not.toContain('#');
  });

  it('encodes a team slug that needs it, in both forms', () => {
    expect(signinUrl('http://h:1', 'a b', 'n')).toBe('http://h:1/board?team=a%20b#s=n');
    expect(boardUrl('http://h:1', 'a b')).toBe('http://h:1/board?team=a%20b');
  });

  it('encodes a nonce containing URL-significant characters (base64url is safe, but do not assume)', () => {
    expect(signinUrl('http://h:1', 't', 'a+b/c=')).toBe('http://h:1/board?team=t#s=a%2Bb%2Fc%3D');
  });

  it('tolerates a server with a trailing slash', () => {
    expect(boardUrl('http://127.0.0.1:4849/', 'revive')).toBe(
      'http://127.0.0.1:4849/board?team=revive',
    );
  });
});

describe('buildOpenCommand — the platform opener, argv-shaped for testability', () => {
  it('uses `open` on macOS', () => {
    expect(buildOpenCommand('darwin', 'http://x/y#s=n')).toEqual({
      cmd: 'open',
      args: ['http://x/y#s=n'],
    });
  });

  it('uses `xdg-open` on Linux', () => {
    expect(buildOpenCommand('linux', 'http://x/y')).toEqual({
      cmd: 'xdg-open',
      args: ['http://x/y'],
    });
  });

  it('uses `start` on Windows, with the empty-title argument cmd requires', () => {
    expect(buildOpenCommand('win32', 'http://x/y')).toEqual({
      cmd: 'cmd',
      args: ['/c', 'start', '', 'http://x/y'],
    });
  });

  it('returns null on a platform with no opener, so the caller falls back to printing', () => {
    expect(buildOpenCommand('freebsd', 'http://x/y')).toBeNull();
  });
});
