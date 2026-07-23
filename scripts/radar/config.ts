/**
 * Research radar (ADR 056 ingest) — shared config for the M2 dry-sweep.
 * No new runtime deps; model ids / triage land in M3.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..');
export const radarDir = join(repoRoot, 'docs', 'research', 'radar');
export const seenPath = join(radarDir, 'seen.json');

/** arXiv subject categories for the weekly sweep. */
export const ARXIV_CATEGORIES = ['cs.MA', 'cs.AI', 'cs.HC'] as const;

/**
 * Keyword OR-set from research-radar-plan §4. Matched against title/abstract
 * (arXiv query + client-side HF filter).
 */
export const KEYWORD_PHRASES = [
  'multi-agent',
  'multi agent',
  'human-agent',
  'human agent',
  'human-in-the-loop',
  'human in the loop',
  'agent collaboration',
  'agent coordination',
  'agent failure',
  'failure taxonomy',
  'agent observability',
  'LLM agent',
  'agent topology',
  'multi-agent system',
] as const;

export const USER_AGENT = 'musterd-research-radar/0.1 (+https://github.com/SandRiseStudio/musterd)';

/**
 * Fetch timeout per attempt. Exploring Next used ~8s for by-id fetches; arXiv
 * search queries are slower, so the radar uses a wider budget.
 */
export const FETCH_TIMEOUT_MS = 20_000;

/** Retries after the first attempt (2 retries ⇒ 3 tries total). */
export const FETCH_RETRIES = 2;

export const MAX_ABSTRACT_CHARS = 2_000;

/** Default lookback window for a weekly job. */
export const DEFAULT_SINCE_DAYS = 7;

/** Soft cap on how many *new* candidates the CLI prints (says so if truncated). */
export const DEFAULT_PRINT_LIMIT = 50;

/** Max entries to request from arXiv per query. */
export const ARXIV_MAX_RESULTS = 100;

/** HF daily_papers page size. */
export const HF_DAILY_LIMIT = 50;
