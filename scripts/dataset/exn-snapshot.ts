/**
 * The Exploring Next sibling corpus, captured through its own front door.
 *
 * WHY THIS EXISTS. `docs/wiki/research-corpus.md` §sibling corpus: 883 facet-tagged sources +
 * ~876 episodes/scripts in one Supabase project with no export script — "one Supabase project away
 * from gone." This script is the snapshot rail lane `01M1MBV93` builds: keyset-page the versioned
 * read-only API (`workers/exploring-ingest/src/api-v1.ts` in `/Users/nick/sandrise`) into a dated,
 * checksummed directory. It reads the API the way the radar does (radar-plan §2 "Source, not
 * sink") — never direct Supabase access, so no service-role key is involved on this side.
 *
 * WHAT IT DOES NOT DO. It captures episode metadata + scripts + transcripts, never audio (lane
 * decision: the research value is the hand-labelled relevance set — radar-triage calibration data —
 * and 4.99 GB of MP3s is durability cost with no research return). It uploads nothing: where the
 * off-machine copy lands is a separate decision (nick: a second Supabase project, 2026-09-04), and
 * the API terms forbid wholesale re-hosting — this archive is nick's own corpus snapshotted for
 * research durability, recorded here as the exception, not a redistribution. The API key rides
 * `--key` / `EXPLORING_API_KEY` and is never logged, written, or echoed in errors.
 *
 *   pnpm dataset:exn-snapshot -- --out <dir> [--api <base>] [--key <key>]
 *                                  [--skip-transcripts] [--limit-pages <n>] [--dry-run] [--json]
 *
 * Runs on Node's native TypeScript (no build step, no deps), like its sibling gates.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const DEFAULT_API_BASE = 'https://ingest.sandrise.io';
export const LIST_LIMIT = 50;
export const FETCH_TIMEOUT_MS = 8000;
export const MAX_RETRIES = 2;
/**
 * The v1 metadata surface allows 120 req/min per IP. Paced well under it, with 429s
 * honored via Retry-After — a snapshot that trips the limiter aborts nothing, it waits.
 */
export const INTER_EPISODE_MS = 700;
export const MAX_RATE_LIMIT_RETRIES = 10;

export interface ExnSnapshotOptions {
  apiBase: string;
  key: string;
  out: string;
  skipTranscripts: boolean;
  limitPages: number;
  dryRun: boolean;
}

export interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ExnManifest {
  captured_at: string;
  api_base: string;
  episodes: number;
  scripts: number;
  transcripts: number;
  audio_excluded: true;
  terms: string;
  files: ManifestFile[];
}

const TERMS_NOTE =
  'Exploring Next API terms: free with attribution, no wholesale redistribution or re-hosting. ' +
  'This snapshot is the corpus owner snapshotting his own archive for research durability ' +
  '(lane 01M1MBV93, nick 2026-09-04), not a redistribution. Audio deliberately excluded.';

export function parseExnSnapshotArgs(argv: string[]): ExnSnapshotOptions & { json: boolean } {
  const opts: ExnSnapshotOptions & { json: boolean } = {
    apiBase: process.env['EXPLORING_API_BASE'] ?? DEFAULT_API_BASE,
    key: process.env['EXPLORING_API_KEY'] ?? '',
    out: '',
    skipTranscripts: false,
    limitPages: Number.POSITIVE_INFINITY,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = argv[i + 1] as string | undefined;
    if (arg === '--api' && next !== undefined) {
      opts.apiBase = next;
      i++;
    } else if (arg === '--key' && next !== undefined) {
      opts.key = next;
      i++;
    } else if (arg === '--out' && next !== undefined) {
      opts.out = next;
      i++;
    } else if (arg === '--limit-pages' && next !== undefined) {
      const n = Number.parseInt(next, 10);
      if (!Number.isFinite(n) || n < 1) throw new Error('--limit-pages must be a positive integer');
      opts.limitPages = n;
      i++;
    } else if (arg === '--skip-transcripts') {
      opts.skipTranscripts = true;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (opts.key.trim() === '') {
    throw new Error(
      'missing API key: pass --key or set EXPLORING_API_KEY (issued free on request; see sandrise.io/exploring-next/api#auth)',
    );
  }
  if (opts.out.trim() === '' && !opts.dryRun) {
    throw new Error('missing --out <dir> (not required with --dry-run)');
  }
  opts.apiBase = opts.apiBase.replace(/\/+$/, '');
  return opts;
}

/**
 * Stable, unique on-disk ref. Episode numbers are NOT unique in the source (2026-09-04 archive:
 * ep317/ep320/ep553 each name 2–3 distinct UUIDs), so the number always rides with an id
 * fragment; id-only episodes use a longer sanitized prefix.
 */
export function episodeFileRef(episode: { episodeNumber?: unknown; id?: unknown }): string {
  const rawId = typeof episode.id === 'string' ? episode.id : 'unknown';
  const clean = rawId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'unknown';
  const num = episode.episodeNumber;
  if (typeof num === 'number' && Number.isFinite(num)) return `ep${num}-${clean}`;
  const long = rawId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24) || 'unknown';
  return `id-${long}`;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

export function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Seconds to wait on a 429: Retry-After when present and sane, else growing backoff. */
export function rateLimitDelayMs(
  attempt: number,
  headers?: { get(name: string): string | null },
): number {
  const raw = headers?.get('retry-after') ?? headers?.get('Retry-After') ?? null;
  const secs = raw !== null ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(secs) && secs >= 0 && secs <= 300) return (secs + 1) * 1000;
  return Math.min(5000 * (attempt + 1), 30000);
}

async function getJson(fetchFn: FetchFn, url: string, key: string): Promise<unknown> {
  let lastStatus = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetchFn(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt === MAX_RETRIES)
        throw new Error(
          `request failed after ${MAX_RETRIES + 1} attempts: ${(err as Error).message}`,
        );
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    lastStatus = res.status;
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `API refused the key (status ${res.status}); keys are issued free on request — see sandrise.io/exploring-next/api#auth`,
      );
    }
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      await sleepMs(rateLimitDelayMs(attempt, res.headers));
      continue;
    }
    if (res.ok && res.json !== undefined) return await res.json();
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      continue;
    }
    throw new Error(`GET failed with status ${res.status} (no key material echoed)`);
  }
  throw new Error(`GET failed with status ${lastStatus} after retries`);
}

async function getText(fetchFn: FetchFn, url: string, key: string): Promise<string | null> {
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      const res = await fetchFn(url, {
        headers: { Accept: '*/*', Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        await sleepMs(rateLimitDelayMs(attempt, res.headers));
        continue;
      }
      if (!res.ok || res.text === undefined) return null;
      return await res.text();
    } catch {
      return null;
    }
  }
  return null;
}

export interface SnapshotResult {
  episodes: Array<Record<string, unknown>>;
  scriptsFetched: number;
  transcriptsFetched: number;
  files: ManifestFile[];
}

/** Page the episode list, then fetch each episode's script + transcript. Pure against fetchFn. */
export async function snapshotCorpus(
  fetchFn: FetchFn,
  opts: ExnSnapshotOptions,
  writeFile: (path: string, data: string) => void,
): Promise<SnapshotResult> {
  const episodes: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    if (pages >= opts.limitPages) break;
    const url =
      `${opts.apiBase}/v1/episodes?limit=${LIST_LIMIT}` +
      (cursor !== null ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const page = (await getJson(fetchFn, url, opts.key)) as {
      episodes?: Array<Record<string, unknown>>;
      pagination?: { nextCursor?: string | null };
    };
    const batch = Array.isArray(page.episodes) ? page.episodes : [];
    episodes.push(...batch);
    pages++;
    const next = page.pagination?.nextCursor ?? null;
    if (next === null || batch.length === 0) break;
    cursor = next;
  }

  const files: ManifestFile[] = [];
  let scriptsFetched = 0;
  let transcriptsFetched = 0;

  const episodesPath = join(opts.out, 'episodes.jsonl');
  const episodesBody =
    episodes.map((e) => JSON.stringify(e)).join('\n') + (episodes.length ? '\n' : '');
  if (!opts.dryRun) writeFile(episodesPath, episodesBody);
  files.push({
    path: 'episodes.jsonl',
    sha256: sha256Hex(episodesBody),
    bytes: Buffer.byteLength(episodesBody),
  });

  if (!opts.skipTranscripts) {
    for (const ep of episodes) {
      const ref = episodeFileRef(ep as { episodeNumber?: unknown; id?: unknown });
      const id = typeof ep['id'] === 'string' ? (ep['id'] as string) : null;
      const key =
        typeof ep['episodeNumber'] === 'number' ? String(ep['episodeNumber'] as number) : id;
      if (key === null) continue;
      const scriptUrl = `${opts.apiBase}/v1/episodes/${encodeURIComponent(key)}/script`;
      const transcriptUrl = `${opts.apiBase}/v1/episodes/${encodeURIComponent(key)}/transcript`;
      const [script, transcript] = await Promise.all([
        getJson(fetchFn, scriptUrl, opts.key).catch(() => null),
        getText(fetchFn, transcriptUrl, opts.key),
      ]);
      if (script !== null) {
        const body = JSON.stringify(script, null, 2) + '\n';
        const rel = join('scripts', `${ref}.json`);
        if (!opts.dryRun) writeFile(join(opts.out, rel), body);
        files.push({ path: rel, sha256: sha256Hex(body), bytes: Buffer.byteLength(body) });
        scriptsFetched++;
      }
      if (transcript !== null) {
        const rel = join('transcripts', `${ref}.txt`);
        if (!opts.dryRun) writeFile(join(opts.out, rel), transcript);
        files.push({
          path: rel,
          sha256: sha256Hex(transcript),
          bytes: Buffer.byteLength(transcript),
        });
        transcriptsFetched++;
      }
      // Stay under the 120 req/min metadata budget even when the server never 429s.
      if (!opts.dryRun) await sleepMs(INTER_EPISODE_MS);
    }
  }

  return { episodes, scriptsFetched, transcriptsFetched, files };
}

export function buildManifest(result: SnapshotResult, opts: ExnSnapshotOptions): ExnManifest {
  return {
    captured_at: new Date().toISOString(),
    api_base: opts.apiBase,
    episodes: result.episodes.length,
    scripts: result.scriptsFetched,
    transcripts: result.transcriptsFetched,
    audio_excluded: true,
    terms: TERMS_NOTE,
    files: result.files,
  };
}

// Only when run directly — the test imports the pure halves and must not touch the network.
const invokedAsScript =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('exn-snapshot.ts') || process.argv[1].endsWith('exn-snapshot.js'));
if (invokedAsScript) {
  const run = async (): Promise<void> => {
    const opts = parseExnSnapshotArgs(process.argv.slice(2));
    if (!opts.dryRun) {
      mkdirSync(opts.out, { recursive: true });
      mkdirSync(join(opts.out, 'scripts'), { recursive: true });
      mkdirSync(join(opts.out, 'transcripts'), { recursive: true });
    }
    const writeFile = (path: string, data: string): void => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    };
    const result = await snapshotCorpus(fetch as unknown as FetchFn, opts, writeFile);
    const manifest = buildManifest(result, opts);
    if (!opts.dryRun) {
      writeFile(join(opts.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    }
    const summary =
      `exn-snapshot — ${result.episodes.length} episode(s), ` +
      `${result.scriptsFetched} script(s), ${result.transcriptsFetched} transcript(s)` +
      (opts.dryRun ? '; nothing written' : ` → ${opts.out}`);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ...manifest, files: manifest.files.length }) + '\n');
    } else {
      process.stdout.write(summary + '\n');
    }
    // The manifest (key-free) proves the run; no key material ever touches stdout.
    if (!opts.dryRun) {
      const check = JSON.parse(
        readFileSync(join(opts.out, 'manifest.json'), 'utf8'),
      ) as ExnManifest;
      if (check.files.length !== result.files.length)
        throw new Error('manifest/file count mismatch');
    }
  };
  run().catch((err: unknown) => {
    process.stderr.write(`exn-snapshot failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
