import { describe, expect, it } from 'vitest';
import { boardUrl, buildOpenCommand, signinUrl, surfaceUrl } from './board.js';

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

/**
 * ADR 222 — the same one-shot nonce signs you into either surface. `musterd live` exists because the
 * board is a page you must decide to visit, and the record says that does not happen: the ADR 170
 * handoff was redeemed once, on release day, and never again. The office is the surface a human
 * actually leaves open, so it is the one that has to be signable-into.
 */
describe('signinUrl / surfaceUrl across surfaces (ADR 222)', () => {
  it('signs into either surface with the same nonce, in the fragment either way', () => {
    expect(signinUrl('http://h:1', 'revive', 'n1', 'board')).toBe(
      'http://h:1/board?team=revive#s=n1',
    );
    expect(signinUrl('http://h:1', 'revive', 'n1', 'live')).toBe(
      'http://h:1/live?team=revive#s=n1',
    );
    for (const surface of ['board', 'live'] as const) {
      expect(
        new URL(signinUrl('http://h:1', 'revive', 'n1', surface)).searchParams.get('s'),
      ).toBeNull();
    }
  });

  it('defaults to the board, so every existing ADR 170 call site is unchanged', () => {
    expect(signinUrl('http://h:1', 'revive', 'n1')).toBe('http://h:1/board?team=revive#s=n1');
  });

  it('prints a nonce-free URL for either surface — scrollback stays clean on both', () => {
    expect(surfaceUrl('http://h:1', 'a b', 'live')).toBe('http://h:1/live?team=a%20b');
    expect(surfaceUrl('http://h:1/', 'revive', 'live')).toBe('http://h:1/live?team=revive');
    expect(surfaceUrl('http://h:1', 'revive', 'live')).not.toContain('#');
  });

  it('boardUrl stays the board — the old name keeps its old meaning', () => {
    expect(boardUrl('http://h:1', 'revive')).toBe(surfaceUrl('http://h:1', 'revive', 'board'));
  });
});
