/**
 * Research radar (ADR 056 ingest) — shared config for dry-sweep + triage.
 * No new runtime deps; Anthropic Messages API via fetch + ANTHROPIC_API_KEY.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..');
export const radarDir = join(repoRoot, 'docs', 'research', 'radar');
export const seenPath = join(radarDir, 'seen.json');
export const promptPath = join(radarDir, 'prompts', 'radar-v1.md');

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

/** Prompt version pin — recorded on every triage report / future digest. */
export const PROMPT_VERSION = 'radar-v1';

/** Tier-1 (cheap filter) model id — recorded per run. */
export const TIER1_MODEL = 'claude-haiku-4-5';

/** Tier-2 (honest-score) model id — recorded per run. */
export const TIER2_MODEL = 'claude-sonnet-5';

/**
 * Relevance floor (0–1). Below → verdict `ignore` (never surface).
 * Diagnostic only — never a ranking of Members.
 */
export const RELEVANCE_FLOOR = 0.45;

/** Max shortlist size after tier-1 (plan §9 volume cap). */
export const SHORTLIST_MAX = 10;

/** Anthropic Messages API. */
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const LLM_TIMEOUT_MS = 60_000;
