import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LOG_CAP_BYTES, logCapBytes, trimLog, trimServiceLogs } from './logTrim.js';

/**
 * ADR 224 — size-capped retention for the service logs. The behaviour that matters: an over-cap log
 * keeps its history in `<name>.1` and comes back empty-but-explained, an under-cap log is not
 * touched at all (this runs every 2 minutes), and the bound is two generations rather than an
 * ever-growing chain.
 */
describe('service log trim', () => {
  let dir: string;
  const write = (rel: string, bytes: number) => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, 'x'.repeat(bytes));
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'logtrim-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('leaves a log that is under the cap completely alone', () => {
    const p = write('daemon.log', 100);
    const before = statSync(p).mtimeMs;
    expect(trimLog(p, 1000)).toBeNull();
    expect(statSync(p).size).toBe(100);
    expect(statSync(p).mtimeMs).toBe(before);
  });

  it('moves an over-cap log to .1 and leaves the live file empty but explained', () => {
    const p = write('daemon.log', 5000);
    const hit = trimLog(p, 1000);
    expect(hit).toEqual({ path: p, before: 5000 });
    expect(readFileSync(`${p}.1`, 'utf8')).toHaveLength(5000); // history preserved, in full
    const live = readFileSync(p, 'utf8');
    expect(live.split('\n').filter(Boolean)).toHaveLength(1); // just the marker
    expect(live).toContain('trimmed by musterd');
    expect(live).toContain(`${p}.1`);
    expect(live).toContain('ADR 224');
  });

  // Two generations, not a chain: the bound only holds if `.1` is never itself rotated.
  it('never rotates a .1 — that is what bounds total retention at 2x the cap', () => {
    write('daemon.log', 50);
    write('daemon.log.1', 9999);
    expect(trimServiceLogs(dir, 1000).map((t) => t.path)).toEqual([]);
    expect(statSync(join(dir, 'daemon.log.1')).size).toBe(9999);
  });

  it('re-trimming an already-rotated log overwrites .1 rather than growing a chain', () => {
    const p = write('daemon.log', 5000);
    trimLog(p, 1000);
    appendFileSync(p, 'y'.repeat(5000));
    trimLog(p, 1000);
    expect(readFileSync(`${p}.1`, 'utf8')).toContain('y');
    expect(statSync(`${p}.1`).size).toBeLessThan(6000); // one generation, not two concatenated
  });

  it('reaches the logs in subdirectories — live/, autorefresh/ and research/ each hold one', () => {
    write('daemon.log', 5000);
    write('live/build.log', 5000);
    write('autorefresh/refresh.log', 5000);
    write('live/viewer.log', 10); // under cap
    const trimmed = trimServiceLogs(dir, 1000)
      .map((t) => t.path.slice(dir.length + 1))
      .sort();
    expect(trimmed).toEqual(['autorefresh/refresh.log', 'daemon.log', 'live/build.log']);
  });

  // The blast radius IS the list. `dirname(configPath())` is the real ~/.musterd in production but
  // a shared temp dir under the ADR 162/190 test isolation — a `*.log` glob there would truncate
  // whatever another process left lying around. We touch only names musterd itself writes.
  it('touches nothing outside its own known log set, however log-shaped it looks', () => {
    write('musterd.db', 5000);
    write('autorefresh/.attempted-sha', 5000);
    write('some-other-app.log', 5000); // the one that matters
    write('live/vite-debug.log', 5000);
    expect(trimServiceLogs(dir, 1000)).toEqual([]);
    expect(statSync(join(dir, 'some-other-app.log')).size).toBe(5000);
    expect(statSync(join(dir, 'musterd.db')).size).toBe(5000);
  });

  it('is a no-op on a missing directory or a vanished file, never a throw', () => {
    expect(trimServiceLogs(join(dir, 'nope'), 1000)).toEqual([]);
    expect(trimLog(join(dir, 'gone.log'), 1000)).toBeNull();
  });

  // An operator who wants deep history must be able to say so, and to turn it off outright.
  it('honours MUSTERD_LOG_CAP_MB, and 0 disables trimming entirely', () => {
    expect(logCapBytes({})).toBe(DEFAULT_LOG_CAP_BYTES);
    expect(logCapBytes({ MUSTERD_LOG_CAP_MB: '32' })).toBe(32 * 1024 * 1024);
    expect(logCapBytes({ MUSTERD_LOG_CAP_MB: 'nonsense' })).toBe(DEFAULT_LOG_CAP_BYTES);
    const p = write('daemon.log', 5000);
    expect(trimLog(p, 0)).toBeNull();
    expect(statSync(p).size).toBe(5000);
  });
});
