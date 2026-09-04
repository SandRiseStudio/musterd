/**
 * The ExN snapshot rail, as a test: pagination must exhaust, refs must be stable and
 * filesystem-safe, failures must degrade per-episode (never abort the corpus), and key material
 * must appear in no error, no manifest, and no stdout.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildManifest,
  episodeFileRef,
  parseExnSnapshotArgs,
  rateLimitDelayMs,
  sha256Hex,
  snapshotCorpus,
  type ExnSnapshotOptions,
} from './exn-snapshot.ts';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'exn-snapshot-'));
  dirs.push(d);
  return d;
}

function opts(over: Partial<ExnSnapshotOptions> = {}): ExnSnapshotOptions {
  return {
    apiBase: 'https://example.test',
    key: 'test-key',
    out: tmp(),
    skipTranscripts: false,
    limitPages: Number.POSITIVE_INFINITY,
    dryRun: false,
    ...over,
  };
}

type StubResponse = { ok: boolean; status: number; body: unknown };

/** A three-episode corpus across two pages; episode 2's transcript 404s; episode 3 has no number. */
function stubFetch() {
  const calls: string[] = [];
  const pages: Record<string, StubResponse> = {
    '/v1/episodes?limit=50': {
      ok: true,
      status: 200,
      body: {
        episodes: [
          { id: 'uuid-1', episodeNumber: 7, title: 'Seven' },
          { id: 'uuid-2', episodeNumber: 8, title: 'Eight' },
        ],
        pagination: { nextCursor: 'cursor-1', limit: 50 },
      },
    },
    '/v1/episodes?limit=50&cursor=cursor-1': {
      ok: true,
      status: 200,
      body: {
        episodes: [{ id: 'uuid-3!!!', title: 'No number' }],
        pagination: { nextCursor: null, limit: 50 },
      },
    },
  };
  const fetchFn = async (
    url: string,
  ): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }> => {
    calls.push(url);
    const path = url.replace('https://example.test', '');
    if (path in pages) {
      const p = pages[path] as StubResponse;
      return {
        ok: p.ok,
        status: p.status,
        json: async () => p.body,
        text: async () => JSON.stringify(p.body),
      };
    }
    if (path === '/v1/episodes/8/transcript') {
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    }
    if (path.endsWith('/script')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ segments: [] }),
        text: async () => '{}',
      };
    }
    if (path.endsWith('/transcript')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => 'hello transcript',
      };
    }
    throw new Error(`unexpected url ${url}`);
  };
  return { fetchFn, calls };
}

describe('episodeFileRef', () => {
  it('prefers the episode number', () => {
    expect(episodeFileRef({ episodeNumber: 42, id: 'x' })).toBe('ep42');
  });
  it('falls back to a sanitized id prefix', () => {
    expect(episodeFileRef({ id: 'uuid-3!!!' })).toBe('id-uuid-3');
  });
  it('never returns empty', () => {
    expect(episodeFileRef({})).toBe('id-unknown');
  });
});

describe('parseExnSnapshotArgs', () => {
  it('requires a key and an out dir', () => {
    expect(() => parseExnSnapshotArgs([])).toThrow(/API key/);
    expect(() => parseExnSnapshotArgs(['--key', 'k'])).toThrow(/--out/);
  });
  it('rejects unknown flags and bad page limits', () => {
    expect(() => parseExnSnapshotArgs(['--key', 'k', '--out', 'o', '--nope'])).toThrow(
      /unknown argument/,
    );
    expect(() => parseExnSnapshotArgs(['--key', 'k', '--out', 'o', '--limit-pages', '0'])).toThrow(
      /positive integer/,
    );
  });
  it('reads env and strips trailing slashes', () => {
    const o = parseExnSnapshotArgs([
      '--key',
      'k',
      '--out',
      'o',
      '--api',
      'https://h.test///',
      '--skip-transcripts',
      '--dry-run',
      '--json',
    ]);
    expect(o.apiBase).toBe('https://h.test');
    expect(o.skipTranscripts).toBe(true);
    expect(o.dryRun).toBe(true);
    expect(o.json).toBe(true);
  });
});

describe('snapshotCorpus', () => {
  it('exhausts keyset pages and degrades per-episode', async () => {
    const { fetchFn, calls } = stubFetch();
    const o = opts();
    const written = new Map<string, string>();
    const result = await snapshotCorpus(fetchFn, o, (p, d) => void written.set(p, d));
    expect(result.episodes.length).toBe(3);
    expect(result.scriptsFetched).toBe(3);
    // Episode 8's transcript 404s: the corpus still completes with 2 transcripts.
    expect(result.transcriptsFetched).toBe(2);
    expect(calls.filter((c) => c.includes('/v1/episodes?')).length).toBe(2);
    // Files: episodes.jsonl + 3 scripts + 2 transcripts.
    expect(result.files.length).toBe(6);
    for (const f of result.files) {
      expect(f.sha256).toBe(sha256Hex(written.get(join(o.out, f.path)) as string));
    }
  });

  it('dry-run computes checksums but writes nothing', async () => {
    const { fetchFn } = stubFetch();
    const o = opts({ dryRun: true });
    const written = new Map<string, string>();
    const result = await snapshotCorpus(fetchFn, o, (p, d) => void written.set(p, d));
    expect(written.size).toBe(0);
    expect(result.episodes.length).toBe(3);
  });

  it('respects limit-pages and skip-transcripts', async () => {
    const { fetchFn, calls } = stubFetch();
    const o = opts({ limitPages: 1, skipTranscripts: true });
    const result = await snapshotCorpus(fetchFn, o, () => {});
    expect(result.episodes.length).toBe(2);
    expect(result.scriptsFetched).toBe(0);
    expect(calls.some((c) => c.includes('/script'))).toBe(false);
  });

  it('a refused key fails loudly without echoing it', async () => {
    const bad = async (): Promise<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
      text: () => Promise<string>;
    }> => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '',
    });
    await expect(snapshotCorpus(bad, opts(), () => {})).rejects.toThrow(/refused the key/);
    await expect(snapshotCorpus(bad, opts(), () => {})).rejects.not.toThrow(/test-key/);
  });
});

describe('rate limiting', () => {
  it('honors Retry-After seconds when sane', () => {
    expect(rateLimitDelayMs(0, { get: () => '2' })).toBe(3000);
  });
  it('clamps insane values and falls back to growing backoff', () => {
    expect(rateLimitDelayMs(0, { get: () => '9999' })).toBe(5000);
    expect(rateLimitDelayMs(0, { get: () => null })).toBe(5000);
    expect(rateLimitDelayMs(3, { get: () => null })).toBe(20000);
    expect(rateLimitDelayMs(99, { get: () => null })).toBe(30000);
  });
  it('a 429 retries and then succeeds', async () => {
    let calls = 0;
    const flaky = async (): Promise<{
      ok: boolean;
      status: number;
      headers: { get: () => string | null };
      json: () => Promise<unknown>;
      text: () => Promise<string>;
    }> => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 429,
          headers: { get: () => '0' },
          json: async () => ({}),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ episodes: [], pagination: { nextCursor: null } }),
        text: async () => '',
      };
    };
    const result = await snapshotCorpus(flaky, opts({ skipTranscripts: true }), () => {});
    expect(calls).toBe(2);
    expect(result.episodes.length).toBe(0);
  });
});

describe('buildManifest', () => {
  it('names the corpus and carries the terms exception', async () => {
    const { fetchFn } = stubFetch();
    const o = opts();
    const result = await snapshotCorpus(fetchFn, o, () => {});
    const m = buildManifest(result, o);
    expect(m.episodes).toBe(3);
    expect(m.audio_excluded).toBe(true);
    expect(m.terms).toMatch(/no wholesale/);
    expect(JSON.stringify(m)).not.toMatch(/test-key/);
    // The manifest round-trips through disk in the runner; check the shape here.
    const dir = tmp();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(m));
    const back = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as typeof m;
    expect(back.files.length).toBe(6);
  });
});
