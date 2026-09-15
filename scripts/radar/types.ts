/** Normalized candidate from arXiv, Hugging Face Papers, or the Exploring Next feed (exn). */
export type RadarSource = 'arxiv' | 'hf' | 'exn';

export interface RadarCandidate {
  source: RadarSource;
  /** Stable id: arXiv id (e.g. 2503.13657), HF paper id (usually the same), or exn row uuid. */
  id: string;
  title: string;
  url: string;
  /** ISO date (YYYY-MM-DD) when known. */
  published: string;
  abstract?: string;
  categories?: string[];
}

export interface SeenLedger {
  arxiv: string[];
  hf: string[];
  /** Exploring Next feed row uuids (source added 2026-08-24; legacy files default to []). */
  exn: string[];
}

export type TriageVerdict = 'ignore' | 'record-as-evidence' | 'consider-ADR';

export type RelevanceDimension =
  | 'coordination-layer'
  | 'human-agent-loop'
  | 'notification-reachability'
  | 'agent-eval-observability'
  | 'failure-taxonomies'
  | 'multi-agent-topology';

/** Tier-1 coarse keep/drop for one candidate. */
export interface Tier1Hit {
  id: string;
  keep: boolean;
  /** 0–1 coarse relevance. */
  score: number;
  reason: string;
}

/** Tier-2 honest score + verdict for a shortlisted paper. */
export interface Tier2Result {
  id: string;
  title: string;
  url: string;
  /** 0–1 weighted overall; below floor ⇒ ignore. */
  score: number;
  dimensions: Partial<Record<RelevanceDimension, number>>;
  one_line: string;
  why_musterd: string;
  gut_check: string;
  confidence: number;
  verdict: TriageVerdict;
}

export interface TriageReport {
  prompt_version: string;
  tier1_model: string;
  tier2_model: string;
  relevance_floor: number;
  candidates_in: number;
  shortlisted: number;
  shortlist_truncated: boolean;
  tier1: Tier1Hit[];
  /** Surfaced results only (verdict ≠ ignore). */
  surfaced: Tier2Result[];
  /** Full shortlist including ignores (for eval / debugging). */
  tier2: Tier2Result[];
  warnings: string[];
}

export interface SweepReport {
  generated: string;
  since_days: number;
  candidates_fetched: number;
  already_seen: number;
  new_count: number;
  printed: number;
  truncated: boolean;
  new: RadarCandidate[];
  warnings: string[];
  /** Present when `--triage` ran. */
  triage?: TriageReport;
}
