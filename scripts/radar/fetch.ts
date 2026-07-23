import {
  ARXIV_CATEGORIES,
  ARXIV_MAX_RESULTS,
  FETCH_RETRIES,
  FETCH_TIMEOUT_MS,
  HF_DAILY_LIMIT,
  KEYWORD_PHRASES,
  MAX_ABSTRACT_CHARS,
  USER_AGENT,
} from './config.ts';
import type { RadarCandidate } from './types.ts';

/** Word-boundary truncation (Exploring Next `truncateDescription` spirit). */
export function truncateDescription(text: string, max = MAX_ABSTRACT_CHARS): string {
  if (text.length <= max) return text;
  const truncated = text.slice(0, max);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > max * 0.6 ? truncated.slice(0, lastSpace) : truncated;
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Strip version suffix: 2503.13657v2 → 2503.13657 */
export function normalizeArxivId(raw: string): string {
  const m = raw.match(/(\d{4}\.\d{4,5})(?:v\d+)?/);
  return m?.[1] ?? raw.trim();
}

export function matchesKeywordFilter(text: string): boolean {
  const lower = text.toLowerCase();
  return KEYWORD_PHRASES.some((p) => lower.includes(p.toLowerCase()));
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function fetchWithRetry(
  url: string,
  init: RequestInit | undefined,
  fetchFn: FetchFn,
): Promise<Response> {
  let lastErr: unknown;
  let lastRes: Response | undefined;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchFn(url, {
        ...init,
        signal: ctrl.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          ...(init?.headers ?? {}),
        },
      });
      clearTimeout(timer);
      // Retry rate-limits / transient 5xx with simple backoff
      if ((res.status === 429 || res.status >= 500) && attempt < FETCH_RETRIES) {
        lastRes = res;
        await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt === FETCH_RETRIES) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  if (lastRes) return lastRes;
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function tagContent(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? collapseWs(unescapeXml(m[1]!)) : undefined;
}

function allTagContents(block: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    out.push(collapseWs(unescapeXml(m[1]!)));
  }
  return out;
}

/** Parse arXiv Atom XML into candidates (regex — no XML dependency). */
export function parseArxivAtom(xml: string): RadarCandidate[] {
  const entries = xml.match(/<entry>([\s\S]*?)<\/entry>/gi) ?? [];
  const out: RadarCandidate[] = [];
  for (const entry of entries) {
    const idUrl = tagContent(entry, 'id') ?? '';
    const idMatch =
      idUrl.match(/arxiv\.org\/abs\/([^\s/?#]+)/i) ?? idUrl.match(/(\d{4}\.\d{4,5})(?:v\d+)?/);
    if (!idMatch) continue;
    const id = normalizeArxivId(idMatch[1]!);
    const title = tagContent(entry, 'title');
    if (!title) continue;
    const summary = tagContent(entry, 'summary');
    const publishedRaw = tagContent(entry, 'published') ?? tagContent(entry, 'updated') ?? '';
    const published = publishedRaw.slice(0, 10);
    const categories = [...entry.matchAll(/<category[^>]*term="([^"]+)"/gi)].map((m) => m[1]!);
    // Also pick primary category tags without attributes if present
    for (const c of allTagContents(entry, 'arxiv:primary_category')) {
      if (c) categories.push(c);
    }
    out.push({
      source: 'arxiv',
      id,
      title,
      url: `https://arxiv.org/abs/${id}`,
      published,
      abstract: summary ? truncateDescription(summary) : undefined,
      categories: categories.length ? [...new Set(categories)] : undefined,
    });
  }
  return out;
}

/** Build arXiv API search_query for the category OR-set (keywords filtered client-side). */
export function buildArxivSearchQuery(): string {
  return ARXIV_CATEGORIES.map((c) => `cat:${c}`).join(' OR ');
}

export async function sweepArxiv(opts: {
  sinceDays: number;
  fetchFn?: FetchFn;
}): Promise<{ candidates: RadarCandidate[]; warning?: string }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const query = buildArxivSearchQuery();
  const params = new URLSearchParams({
    search_query: query,
    start: '0',
    max_results: String(ARXIV_MAX_RESULTS),
    sortBy: 'submittedDate',
    sortOrder: 'descending',
  });
  const url = `https://export.arxiv.org/api/query?${params.toString()}`;
  try {
    const res = await fetchWithRetry(url, { headers: { Accept: 'application/atom+xml' } }, fetchFn);
    if (!res.ok) {
      return { candidates: [], warning: `arXiv API returned ${res.status}` };
    }
    const xml = await res.text();
    const parsed = parseArxivAtom(xml).filter((c) =>
      matchesKeywordFilter(`${c.title} ${c.abstract ?? ''}`),
    );
    const cutoff = Date.now() - opts.sinceDays * 86_400_000;
    const filtered = parsed.filter((c) => {
      if (!c.published) return true;
      const t = Date.parse(c.published);
      return Number.isNaN(t) || t >= cutoff;
    });
    return { candidates: filtered };
  } catch (err) {
    return {
      candidates: [],
      warning: `arXiv sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function fetchArxivPaper(
  paperId: string,
  fetchFn: FetchFn = fetch,
): Promise<RadarCandidate | null> {
  const id = normalizeArxivId(paperId);
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
  try {
    const res = await fetchWithRetry(url, {}, fetchFn);
    if (!res.ok) return null;
    const xml = await res.text();
    return parseArxivAtom(xml)[0] ?? null;
  } catch {
    return null;
  }
}

/** ISO week string like 2026-W30 for HF daily_papers?week= */
export function isoWeekString(d: Date): string {
  // Copy — UTC Thursday week algorithm
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function eachIsoWeekInWindow(sinceDays: number, now = new Date()): string[] {
  const weeks = new Set<string>();
  for (let i = 0; i <= sinceDays; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    weeks.add(isoWeekString(d));
  }
  return [...weeks];
}

interface HfDailyRow {
  paper?: {
    id?: string;
    title?: string;
    summary?: string;
    publishedAt?: string;
  };
  title?: string;
  summary?: string;
}

function candidateFromHfPaper(paper: {
  id?: string;
  title?: string;
  summary?: string;
  publishedAt?: string;
}): RadarCandidate | null {
  if (!paper.id || !paper.title) return null;
  const id = normalizeArxivId(paper.id);
  const abstract = paper.summary ? truncateDescription(collapseWs(paper.summary)) : undefined;
  const haystack = `${paper.title} ${paper.summary ?? ''}`;
  if (!matchesKeywordFilter(haystack)) return null;
  const published = (paper.publishedAt ?? '').slice(0, 10);
  return {
    source: 'hf',
    id,
    title: collapseWs(paper.title),
    url: `https://huggingface.co/papers/${id}`,
    published,
    abstract,
  };
}

/** Parse HF daily_papers JSON (array or { results }). */
export function parseHfDailyPapers(data: unknown): RadarCandidate[] {
  const rows: HfDailyRow[] = Array.isArray(data)
    ? (data as HfDailyRow[])
    : data && typeof data === 'object' && Array.isArray((data as { results?: unknown }).results)
      ? (data as { results: HfDailyRow[] }).results
      : [];
  const out: RadarCandidate[] = [];
  for (const row of rows) {
    const paper = row.paper ?? {
      id: typeof (row as { id?: unknown }).id === 'string' ? (row as { id: string }).id : undefined,
      title: row.title,
      summary: row.summary,
    };
    const c = candidateFromHfPaper(paper);
    if (c) out.push(c);
  }
  return out;
}

export async function sweepHf(opts: {
  sinceDays: number;
  fetchFn?: FetchFn;
}): Promise<{ candidates: RadarCandidate[]; warning?: string }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const weeks = eachIsoWeekInWindow(opts.sinceDays);
  const byId = new Map<string, RadarCandidate>();
  const warnings: string[] = [];
  for (const week of weeks) {
    const params = new URLSearchParams({
      week,
      limit: String(HF_DAILY_LIMIT),
      sort: 'publishedAt',
    });
    const url = `https://huggingface.co/api/daily_papers?${params.toString()}`;
    try {
      const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } }, fetchFn);
      if (!res.ok) {
        warnings.push(`HF daily_papers week=${week} returned ${res.status}`);
        continue;
      }
      const data: unknown = await res.json();
      for (const c of parseHfDailyPapers(data)) {
        byId.set(c.id, c);
      }
    } catch (err) {
      warnings.push(`HF week=${week} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const cutoff = Date.now() - opts.sinceDays * 86_400_000;
  const candidates = [...byId.values()].filter((c) => {
    if (!c.published) return true;
    const t = Date.parse(c.published);
    return Number.isNaN(t) || t >= cutoff;
  });
  return {
    candidates,
    warning: warnings.length ? warnings.join('; ') : undefined,
  };
}

export async function fetchHuggingFacePaper(
  paperId: string,
  fetchFn: FetchFn = fetch,
): Promise<RadarCandidate | null> {
  const id = normalizeArxivId(paperId);
  const url = `https://huggingface.co/api/papers/${encodeURIComponent(id)}`;
  try {
    const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } }, fetchFn);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      id?: string;
      title?: string;
      summary?: string;
      publishedAt?: string;
    };
    return candidateFromHfPaper({
      id: data.id ?? id,
      title: data.title,
      summary: data.summary,
      publishedAt: data.publishedAt,
    });
  } catch {
    return null;
  }
}
