/** Normalized paper candidate from arXiv or Hugging Face Papers. */
export type RadarSource = 'arxiv' | 'hf';

export interface RadarCandidate {
  source: RadarSource;
  /** Stable id: arXiv id (e.g. 2503.13657) or HF paper id (usually the same arXiv id). */
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
}
