import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LineBuffer,
  canvasPath,
  companionPaths,
  parseEditorLine,
  redactEditorUrl,
  resolveCheckout,
  resolveNodeBinary,
} from './squig-mcp.mjs';

describe('squig companion launcher', () => {
  it('splits newline-delimited JSON the way the MCP stdio transport writes it', () => {
    const buf = new LineBuffer();
    expect(buf.push('{"jsonrpc":"2.0","id":1')).toEqual([]);
    expect(buf.push(',"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"pong"}\n')).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      '{"jsonrpc":"2.0","id":2,"method":"pong"}',
    ]);
  });

  it('reads the editor URL from Squig stderr and redacts the token', () => {
    const parsed = parseEditorLine(
      'Squig local file: /tmp/team.squig.json\nOpen canvas: http://127.0.0.1:4321/?local=1#token=sekret\n',
    );
    expect(parsed).toEqual({
      editorUrl: 'http://127.0.0.1:4321/?local=1#token=sekret',
      origin: 'http://127.0.0.1:4321',
      token: 'sekret',
    });
    expect(redactEditorUrl(parsed!.editorUrl)).toBe('http://127.0.0.1:4321/?local=1');
    expect(redactEditorUrl(parsed!.editorUrl)).not.toContain('sekret');
  });

  it('keeps the companion files beside the canvas', () => {
    expect(companionPaths('/tmp/team.squig.json')).toEqual({
      session: '/tmp/team.squig.json.companion.json',
      lock: '/tmp/team.squig.json.companion.lock',
    });
    expect(canvasPath()).toMatch(/docs\/wireframes\/team\.squig\.json$/);
  });

  it('finds a checkout in SQUIG_CHECKOUT, then ~/.squig/src', () => {
    const homeSrc = (path: string) =>
      path === '/home/me/.squig/src/scripts/squig.ts' ||
      path === '/home/me/.squig/src/scripts/register-loader.mjs';
    expect(resolveCheckout(undefined, '/home/me', homeSrc)?.root).toBe('/home/me/.squig/src');
    const envSrc = (path: string) => path.startsWith('/opt/squig/scripts/');
    expect(resolveCheckout('/opt/squig', '/home/me', envSrc)?.root).toBe('/opt/squig');
    expect(resolveCheckout(undefined, '/home/me', () => false)).toBeNull();
  });

  it('stays on the host Node when it is 22 or newer', () => {
    const local = '/home/me/.squig/node/bin/node';
    const brew = '/opt/homebrew/opt/node@24/bin/node';
    expect(
      resolveNodeBinary(
        undefined,
        '/home/me',
        '/usr/bin/node',
        22,
        (path) => path === local || path === '/usr/bin/node',
      ),
    ).toBe('/usr/bin/node');
    expect(
      resolveNodeBinary(undefined, '/home/me', '/usr/bin/node', 20, (path) => path === brew),
    ).toBe(brew);
    expect(
      resolveNodeBinary(
        '/custom/node',
        '/home/me',
        '/usr/bin/node',
        22,
        (path) => path === '/custom/node',
      ),
    ).toBe('/custom/node');
    expect(resolveNodeBinary('/missing', '/home/me', '/usr/bin/node', 24, () => false)).toBeNull();
    expect(
      resolveNodeBinary(
        undefined,
        '/home/me',
        '/usr/bin/node',
        24,
        (path) => path === '/usr/bin/node',
      ),
    ).toBe('/usr/bin/node');
  });

  it('commits an empty portable Squig document', () => {
    const doc = JSON.parse(readFileSync(join(canvasPath()), 'utf8')) as {
      app: string;
      version: number;
      nodes: Record<string, unknown>;
      order: unknown[];
    };
    expect(doc.app).toBe('squig');
    expect(doc.version).toBe(1);
    expect(doc.nodes).toEqual({});
    expect(doc.order).toEqual([]);
  });
});
