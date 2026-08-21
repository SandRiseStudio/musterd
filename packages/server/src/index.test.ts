import { describe, expect, it } from 'vitest';
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
