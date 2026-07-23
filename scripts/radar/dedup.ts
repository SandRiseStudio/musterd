import { readFileSync } from 'node:fs';
import { seenPath } from './config.ts';
import type { RadarCandidate, SeenLedger } from './types.ts';

export function loadSeen(path = seenPath): SeenLedger {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SeenLedger>;
  return {
    arxiv: Array.isArray(raw.arxiv) ? raw.arxiv.map(String) : [],
    hf: Array.isArray(raw.hf) ? raw.hf.map(String) : [],
  };
}

export function partitionBySeen(
  candidates: RadarCandidate[],
  seen: SeenLedger,
): { fresh: RadarCandidate[]; alreadySeen: RadarCandidate[] } {
  const arxiv = new Set(seen.arxiv);
  const hf = new Set(seen.hf);
  const fresh: RadarCandidate[] = [];
  const alreadySeen: RadarCandidate[] = [];
  const seenPair = new Set<string>();
  for (const c of candidates) {
    const key = `${c.source}:${c.id}`;
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    const known = c.source === 'arxiv' ? arxiv.has(c.id) : hf.has(c.id);
    // Cross-source: an HF paper with the same arXiv id already in arxiv ledger counts as seen
    const cross = arxiv.has(c.id) || hf.has(c.id);
    if (known || cross) alreadySeen.push(c);
    else fresh.push(c);
  }
  return { fresh, alreadySeen };
}

/** Merge + dedupe candidates by id (prefer arxiv over hf when both present). */
export function mergeCandidates(groups: RadarCandidate[][]): RadarCandidate[] {
  const byId = new Map<string, RadarCandidate>();
  for (const group of groups) {
    for (const c of group) {
      const prev = byId.get(c.id);
      if (!prev || (prev.source === 'hf' && c.source === 'arxiv')) {
        byId.set(c.id, c);
      }
    }
  }
  return [...byId.values()].sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0));
}
