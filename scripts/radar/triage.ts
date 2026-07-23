/**
 * Research radar M3 — two-tier LLM triage (ADR 056 ingest).
 * Tier-1 cheap filter → shortlist; tier-2 honest-score + verdict ladder.
 */
import { readFileSync } from 'node:fs';
import {
  PROMPT_VERSION,
  RELEVANCE_FLOOR,
  SHORTLIST_MAX,
  TIER1_MODEL,
  TIER2_MODEL,
  promptPath,
} from './config.ts';
import type { FetchFn } from './fetch.ts';
import { completeAnthropic, extractJson } from './llm.ts';
import type {
  RadarCandidate,
  RelevanceDimension,
  Tier1Hit,
  Tier2Result,
  TriageReport,
  TriageVerdict,
} from './types.ts';

const DIMENSIONS: RelevanceDimension[] = [
  'coordination-layer',
  'human-agent-loop',
  'notification-reachability',
  'agent-eval-observability',
  'failure-taxonomies',
  'multi-agent-topology',
];

export type CompleteFn = typeof completeAnthropic;

export interface TriageArgs {
  candidates: RadarCandidate[];
  apiKey: string;
  fetchFn?: FetchFn;
  completeFn?: CompleteFn;
  promptBody?: string;
  shortlistMax?: number;
  relevanceFloor?: number;
  tier1Model?: string;
  tier2Model?: string;
}

export function loadPromptBody(path = promptPath): string {
  return readFileSync(path, 'utf8');
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function candidateBlock(c: RadarCandidate): string {
  return [
    `id: ${c.id}`,
    `source: ${c.source}`,
    `title: ${c.title}`,
    `url: ${c.url}`,
    `published: ${c.published || 'unknown'}`,
    `categories: ${(c.categories ?? []).join(', ') || 'n/a'}`,
    `abstract: ${(c.abstract ?? '').slice(0, 1200) || '(none)'}`,
  ].join('\n');
}

export function buildTier1System(promptBody: string): string {
  return `${promptBody}

# Tier-1 task (coarse filter)

You are the cheap first pass. For EACH candidate, decide keep vs drop for musterd's thesis.
Scores are diagnostic only — never rank people or Members.

Return ONLY a JSON array (no prose) of objects:
{ "id": "<paper id>", "keep": boolean, "score": number 0-1, "reason": "≤20 words" }

Keep papers that plausibly touch any relevance dimension. Drop clearly off-thesis work.
`;
}

export function buildTier2System(promptBody: string, floor: number): string {
  return `${promptBody}

# Tier-2 task (honest score + verdict)

You are the expensive second pass on a shortlist. For EACH paper, produce a weighted relevance
score (0–1), per-dimension scores (same 0–1), brutal-honesty gut-check, and a verdict.

Verdict ladder:
- "ignore" — below relevance floor ${floor} OR clearly off-thesis / pure hype / already fully covered with nothing new
- "record-as-evidence" — supports or nuances an existing musterd claim (research-foundation)
- "consider-ADR" — would change a decision; human may draft an ADR

Dimensions (keys): ${DIMENSIONS.join(', ')}

Return ONLY a JSON array (no prose) of objects:
{
  "id": "<paper id>",
  "score": number 0-1,
  "dimensions": { "<dimension>": number 0-1, ... },
  "one_line": "what it is",
  "why_musterd": "which dimension / ADR it touches",
  "gut_check": "2–3 ruthless sentences",
  "confidence": number 0-1,
  "verdict": "ignore" | "record-as-evidence" | "consider-ADR"
}
`;
}

function parseTier1(raw: unknown, candidates: RadarCandidate[]): Tier1Hit[] {
  if (!Array.isArray(raw)) throw new Error('tier-1 reply was not a JSON array');
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const hits: Tier1Hit[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = String(r.id ?? '');
    if (!byId.has(id)) continue;
    hits.push({
      id,
      keep: Boolean(r.keep),
      score: clamp01(Number(r.score)),
      reason: String(r.reason ?? '').slice(0, 200),
    });
  }
  return hits;
}

function parseVerdict(v: unknown): TriageVerdict {
  if (v === 'record-as-evidence' || v === 'consider-ADR' || v === 'ignore') return v;
  return 'ignore';
}

function parseTier2(raw: unknown, candidates: RadarCandidate[], floor: number): Tier2Result[] {
  if (!Array.isArray(raw)) throw new Error('tier-2 reply was not a JSON array');
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: Tier2Result[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = String(r.id ?? '');
    const c = byId.get(id);
    if (!c) continue;
    const score = clamp01(Number(r.score));
    const dimsRaw =
      r.dimensions && typeof r.dimensions === 'object'
        ? (r.dimensions as Record<string, unknown>)
        : {};
    const dimensions: Partial<Record<RelevanceDimension, number>> = {};
    for (const d of DIMENSIONS) {
      if (d in dimsRaw) dimensions[d] = clamp01(Number(dimsRaw[d]));
    }
    let verdict = parseVerdict(r.verdict);
    if (score < floor) verdict = 'ignore';
    out.push({
      id,
      title: c.title,
      url: c.url,
      score,
      dimensions,
      one_line: String(r.one_line ?? '').slice(0, 300),
      why_musterd: String(r.why_musterd ?? '').slice(0, 500),
      gut_check: String(r.gut_check ?? '').slice(0, 800),
      confidence: clamp01(Number(r.confidence)),
      verdict,
    });
  }
  return out;
}

/** Pick shortlist: keep=true, highest score first, capped. */
export function selectShortlist(
  candidates: RadarCandidate[],
  tier1: Tier1Hit[],
  max = SHORTLIST_MAX,
): { shortlist: RadarCandidate[]; truncated: boolean } {
  const scoreById = new Map(tier1.map((h) => [h.id, h]));
  const kept = candidates
    .filter((c) => scoreById.get(c.id)?.keep)
    .sort((a, b) => (scoreById.get(b.id)?.score ?? 0) - (scoreById.get(a.id)?.score ?? 0));
  return {
    shortlist: kept.slice(0, max),
    truncated: kept.length > max,
  };
}

export async function runTriage(args: TriageArgs): Promise<TriageReport> {
  const warnings: string[] = [];
  const promptBody = args.promptBody ?? loadPromptBody();
  const floor = args.relevanceFloor ?? RELEVANCE_FLOOR;
  const shortlistMax = args.shortlistMax ?? SHORTLIST_MAX;
  const tier1Model = args.tier1Model ?? TIER1_MODEL;
  const tier2Model = args.tier2Model ?? TIER2_MODEL;
  const complete = args.completeFn ?? completeAnthropic;

  if (args.candidates.length === 0) {
    return {
      prompt_version: PROMPT_VERSION,
      tier1_model: tier1Model,
      tier2_model: tier2Model,
      relevance_floor: floor,
      candidates_in: 0,
      shortlisted: 0,
      shortlist_truncated: false,
      tier1: [],
      surfaced: [],
      tier2: [],
      warnings,
    };
  }

  const tier1User = `Candidates (${args.candidates.length}):\n\n${args.candidates
    .map(candidateBlock)
    .join('\n\n---\n\n')}`;

  let tier1: Tier1Hit[] = [];
  try {
    const reply = await complete({
      model: tier1Model,
      system: buildTier1System(promptBody),
      messages: [{ role: 'user', content: tier1User }],
      maxTokens: 4096,
      apiKey: args.apiKey,
      fetchFn: args.fetchFn,
    });
    tier1 = parseTier1(extractJson(reply.text), args.candidates);
  } catch (err) {
    warnings.push(`tier-1 failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      prompt_version: PROMPT_VERSION,
      tier1_model: tier1Model,
      tier2_model: tier2Model,
      relevance_floor: floor,
      candidates_in: args.candidates.length,
      shortlisted: 0,
      shortlist_truncated: false,
      tier1: [],
      surfaced: [],
      tier2: [],
      warnings,
    };
  }

  // Fill missing candidates as drop
  const hitIds = new Set(tier1.map((h) => h.id));
  for (const c of args.candidates) {
    if (!hitIds.has(c.id)) {
      tier1.push({ id: c.id, keep: false, score: 0, reason: 'tier-1 omitted' });
    }
  }

  const { shortlist, truncated } = selectShortlist(args.candidates, tier1, shortlistMax);
  if (truncated) {
    warnings.push(`shortlist truncated to ${shortlistMax} (tier-1 keep set larger)`);
  }

  if (shortlist.length === 0) {
    return {
      prompt_version: PROMPT_VERSION,
      tier1_model: tier1Model,
      tier2_model: tier2Model,
      relevance_floor: floor,
      candidates_in: args.candidates.length,
      shortlisted: 0,
      shortlist_truncated: truncated,
      tier1,
      surfaced: [],
      tier2: [],
      warnings,
    };
  }

  const tier2User = `Shortlist (${shortlist.length}):\n\n${shortlist
    .map(candidateBlock)
    .join('\n\n---\n\n')}`;

  let tier2: Tier2Result[] = [];
  try {
    const reply = await complete({
      model: tier2Model,
      system: buildTier2System(promptBody, floor),
      messages: [{ role: 'user', content: tier2User }],
      maxTokens: 8192,
      apiKey: args.apiKey,
      fetchFn: args.fetchFn,
    });
    tier2 = parseTier2(extractJson(reply.text), shortlist, floor);
  } catch (err) {
    warnings.push(`tier-2 failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const surfaced = tier2.filter((t) => t.verdict !== 'ignore').sort((a, b) => b.score - a.score);

  return {
    prompt_version: PROMPT_VERSION,
    tier1_model: tier1Model,
    tier2_model: tier2Model,
    relevance_floor: floor,
    candidates_in: args.candidates.length,
    shortlisted: shortlist.length,
    shortlist_truncated: truncated,
    tier1,
    surfaced,
    tier2,
    warnings,
  };
}
