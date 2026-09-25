import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from './db/open.js';
import { createServer } from './index.js';

/**
 * `db` on `/health` exists so a client can confirm WHICH database this daemon serves — http.ts:1203
 * says so, and guardian acts on it (`dbPathExpected` → the `wrong_db` alert class). It was reported
 * from `config.dbPath`, the path the daemon INTENDED to open, while `opts.db` bypasses that path
 * entirely. So a daemon running wholly in memory named the operator's real database.
 *
 * In production the two agree — `openDb(path)` opens exactly `path` — which is what kept this
 * invisible: the value was accidentally right, derived from the intention rather than the fact.
 */
describe('the daemon reports the database it actually opened', () => {
  it('names the injected handle, not the config default it never opened', async () => {
    const server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    try {
      expect(server.dbPath).toBe(':memory:');
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = (await res.json()) as { db: string };
      expect(body.db).toBe(':memory:');
    } finally {
      await server.close();
    }
  });
});

/**
 * Hard rule 5 at the wire: a token in a request path must reach neither daemon.log (the
 * `http_request` line) nor the 404 body the unmatched-route fallback echoes back. The remote MCP
 * connector URL (`/mcp/<token>`) is the first path that carries a secret; this holds before it lands.
 */
describe('the request log never carries a token from the path', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('redacts /mcp/<token> and credential-shaped segments in log lines and error bodies', async () => {
    vi.stubEnv('MUSTERD_SILENT', '0');
    const lines: string[] = [];
    const capture = (chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);

    const server = createServer({ db: openDb(':memory:'), port: 0 });
    const { port } = await server.listen();
    const secret = 'mscr_' + 'f'.repeat(40);
    const bodies: string[] = [];
    try {
      for (const path of [`/mcp/${secret}`, `/nope/${secret}`, `/mcp/${secret}?q=1`]) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        bodies.push(await res.text());
      }
    } finally {
      await server.close();
    }

    const requestLines = lines.filter((l) => l.includes('"http_request"'));
    expect(requestLines).toHaveLength(3);
    expect(requestLines.join('')).toContain('/mcp/[redacted]');
    expect(lines.join('')).not.toContain(secret);
    expect(bodies.join('')).not.toContain(secret);
  });
});
