/**
 * cookoff git-archaeology — the pure classification engine for wasted-work predicate set v1
 * (ADR 123, docs/design/cookoff-measurement.md). Takes extracted repo facts (see git.ts) and
 * classifies every authored line exactly once, precedence W3 → W1 → W2 → W4 → survived. Pure and
 * git-free so tests can fabricate facts and the extractor stays a thin shell layer.
 *
 * Frozen v1 thresholds: a W3 hunk overlap is ≥ MIN_DUP_RUN contiguous identical normalized
 * non-blank lines, or ≥ DUP_FRACTION of the smaller side. Changing them is predicate set v2 via
 * ADR — never a runtime knob.
 */

export const PREDICATE_SET_VERSION = 'v1';
export const MIN_DUP_RUN = 8;
export const DUP_FRACTION = 0.5;

export type WasteClass = 'W1' | 'W2' | 'W3' | 'W4';

export interface AddedLine {
  /** Post-image line number (for reporting only). */
  n: number;
  text: string;
}

export interface FileChange {
  path: string;
  added: AddedLine[];
}

export interface CommitFacts {
  sha: string;
  /** Resolved actor identity (seat trailer > author email — ADR 109). */
  actor: string;
  /** Commit timestamp (epoch seconds); the later side of a duplicate pair is the waste. */
  order: number;
  /** Reachable from the delivered tip. */
  delivered: boolean;
  /** `git patch-id --stable`; null when the diff is empty. */
  patchId: string | null;
  /**
   * Non-merge commits: the commit's own added lines. Merge commits: only the churn delta
   * (actual merge result vs clean auto-merge), pre-computed by the extractor.
   */
  files: FileChange[];
  merge: boolean;
}

/** A window line added by `srcSha` and later deleted by a delivered commit's author. */
export interface DeletionProvenance {
  /** Delivered commit that deleted the line. */
  delSha: string;
  /** Window commit that added it. */
  srcSha: string;
  path: string;
  /** The added line's post-image number in srcSha. */
  srcLine: number;
}

export interface RepoFacts {
  commits: CommitFacts[];
  deletions: DeletionProvenance[];
  /** True when `ancestor` is an ancestor of `descendant` (same-branch pairs never W3-match). */
  isAncestor: (ancestor: string, descendant: string) => boolean;
}

export interface LineVerdict {
  sha: string;
  path: string;
  n: number;
  actor: string;
  cls: WasteClass | 'survived';
  /** The other side of the relation (dup source, deleting commit, …) when there is one. */
  counterpart?: string;
}

export interface ArchaeologyReport {
  predicateSet: string;
  totalAuthoredLines: number;
  wasted: Record<WasteClass, number>;
  wastedTotal: number;
  wastedPct: number;
  byActor: Record<string, { authored: number; wasted: number }>;
  lines: LineVerdict[];
}

/** Whitespace-collapsed comparison form; empty string ⇒ blank line, excluded from counting. */
export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface LineRef {
  commit: CommitFacts;
  path: string;
  idx: number; // index into the non-blank normalized sequence for this (commit, path)
  n: number;
  norm: string;
}

const keyOf = (sha: string, path: string, n: number): string => `${sha} ${path} ${n}`;

/**
 * Mark, on the LATER of two same-path line sequences, every position that participates in a
 * common contiguous run ≥ MIN_DUP_RUN — or every matched position when the total match reaches
 * DUP_FRACTION of the smaller side. Returns the matched indices of `later`.
 */
export function dupMatch(earlier: string[], later: string[]): Set<number> {
  const matched = new Set<number>();
  if (earlier.length === 0 || later.length === 0) return matched;

  // Suffix-run DP: run[i][j] = length of common run ending at earlier[i-1]/later[j-1].
  const runs: Array<{ endJ: number; len: number }> = [];
  let prev = new Array<number>(later.length + 1).fill(0);
  for (let i = 1; i <= earlier.length; i++) {
    const cur = new Array<number>(later.length + 1).fill(0);
    for (let j = 1; j <= later.length; j++) {
      if (earlier[i - 1]! === later[j - 1]!) {
        cur[j] = prev[j - 1]! + 1;
        // Record maximal runs only: a run is maximal where the next diagonal cell won't extend it.
        const extends_ =
          i < earlier.length && j < later.length && earlier[i]! === later[j]! ? true : false;
        if (!extends_) runs.push({ endJ: j - 1, len: cur[j]! });
      }
    }
    prev = cur;
  }
  for (const r of runs) {
    if (r.len >= MIN_DUP_RUN) {
      for (let j = r.endJ - r.len + 1; j <= r.endJ; j++) matched.add(j);
    }
  }

  // Fraction rule: greedy multiset intersection against the smaller side.
  const smaller = Math.min(earlier.length, later.length);
  const pool = new Map<string, number>();
  for (const t of earlier) pool.set(t, (pool.get(t) ?? 0) + 1);
  const fracMatched: number[] = [];
  for (let j = 0; j < later.length; j++) {
    const c = pool.get(later[j]!) ?? 0;
    if (c > 0) {
      pool.set(later[j]!, c - 1);
      fracMatched.push(j);
    }
  }
  if (fracMatched.length >= Math.ceil(smaller * DUP_FRACTION)) {
    for (const j of fracMatched) matched.add(j);
  }
  return matched;
}

/** Classify every authored line per predicate set v1 and roll up the report. */
export function classify(facts: RepoFacts): ArchaeologyReport {
  const verdicts = new Map<string, LineVerdict>();
  const bySha = new Map(facts.commits.map((c) => [c.sha, c]));

  // ---- Denominator with squash-dedup: patch-equivalent copies count once (the delivered copy
  // wins; among equals the earliest). Dropped copies leave the universe entirely.
  const byPatch = new Map<string, CommitFacts[]>();
  for (const c of facts.commits) {
    if (c.patchId === null) continue;
    const arr = byPatch.get(c.patchId) ?? [];
    arr.push(c);
    byPatch.set(c.patchId, arr);
  }
  const dropped = new Set<string>();
  for (const group of byPatch.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) => Number(b.delivered) - Number(a.delivered) || a.order - b.order,
    );
    const actors = new Set(group.map((c) => c.actor));
    if (actors.size > 1) continue; // cross-actor equal patches are W3 material, keep all copies
    for (const c of sorted.slice(1)) dropped.add(c.sha);
  }

  const counted = facts.commits.filter((c) => !dropped.has(c.sha));

  // Non-blank line sequences per (commit, path).
  const seqs = new Map<string, LineRef[]>();
  for (const c of counted) {
    for (const f of c.files) {
      const refs: LineRef[] = [];
      for (const l of f.added) {
        const norm = normalize(l.text);
        if (norm === '') continue;
        refs.push({ commit: c, path: f.path, idx: refs.length, n: l.n, norm });
      }
      if (refs.length > 0) seqs.set(`${c.sha} ${f.path}`, refs);
    }
  }
  const allRefs = [...seqs.values()].flat();
  for (const r of allRefs) {
    verdicts.set(keyOf(r.commit.sha, r.path, r.n), {
      sha: r.commit.sha,
      path: r.path,
      n: r.n,
      actor: r.commit.actor,
      cls: 'survived',
    });
  }
  const mark = (r: LineRef, cls: WasteClass, counterpart: string): void => {
    const v = verdicts.get(keyOf(r.commit.sha, r.path, r.n));
    if (v && v.cls === 'survived') {
      v.cls = cls;
      v.counterpart = counterpart;
    }
  };

  // ---- Squash re-land dedup + drift (runs before the predicates: denominator hygiene, not a
  // waste class). Under the ADR 106 squash workflow a multi-commit branch re-lands as one
  // delivered commit with a different patch-id. A non-delivered commit whose added lines
  // ≥ DUP_FRACTION-match a same-actor delivered commit is a re-land: the matched branch lines
  // count once (the delivered copy carries them), and the unmatched branch lines are W4 —
  // ADR 123's re-land drift (conflict rework on the way in).
  const relanded = new Set<string>();
  const deliveredNonMerge = counted.filter((c) => c.delivered && !c.merge);
  for (const c of counted) {
    if (c.delivered || c.merge) continue;
    const cRefs = [...c.files.flatMap((f) => seqs.get(`${c.sha} ${f.path}`) ?? [])];
    if (cRefs.length === 0) continue;
    for (const d of deliveredNonMerge) {
      if (d.actor !== c.actor) continue;
      const matched: LineRef[] = [];
      for (const f of c.files) {
        const cSeq = seqs.get(`${c.sha} ${f.path}`);
        const dSeq = seqs.get(`${d.sha} ${f.path}`);
        if (!cSeq || !dSeq) continue;
        const hit = dupMatch(
          dSeq.map((r) => r.norm),
          cSeq.map((r) => r.norm),
        );
        for (const j of hit) matched.push(cSeq[j]!);
      }
      if (matched.length < Math.ceil(cRefs.length * DUP_FRACTION)) continue;
      relanded.add(c.sha);
      const matchedKeys = new Set(matched.map((r) => keyOf(r.commit.sha, r.path, r.n)));
      for (const r of cRefs) {
        const k = keyOf(r.commit.sha, r.path, r.n);
        if (matchedKeys.has(k)) verdicts.delete(k);
        else mark(r, 'W4', d.sha);
      }
      break;
    }
  }

  // ---- W3 — duplicated work. Exact (patch-id across actors) then overlapping hunks.
  for (const group of byPatch.values()) {
    if (group.length < 2 || new Set(group.map((c) => c.actor)).size < 2) continue;
    const sorted = [...group].sort((a, b) => a.order - b.order);
    const first = sorted[0]!;
    for (const later of sorted.slice(1)) {
      if (later.actor === first.actor || dropped.has(later.sha)) continue;
      for (const f of later.files) {
        for (const r of seqs.get(`${later.sha} ${f.path}`) ?? []) mark(r, 'W3', first.sha);
      }
    }
  }
  const nonMerge = counted.filter((c) => !c.merge);
  for (let a = 0; a < nonMerge.length; a++) {
    for (let b = a + 1; b < nonMerge.length; b++) {
      const [x, y] = [nonMerge[a]!, nonMerge[b]!];
      if (x.actor === y.actor) continue;
      if (facts.isAncestor(x.sha, y.sha) || facts.isAncestor(y.sha, x.sha)) continue;
      const [earlier, later] = x.order <= y.order ? [x, y] : [y, x];
      for (const f of later.files) {
        const laterRefs = seqs.get(`${later.sha} ${f.path}`);
        const earlierRefs = seqs.get(`${earlier.sha} ${f.path}`);
        if (!laterRefs || !earlierRefs) continue;
        const hit = dupMatch(
          earlierRefs.map((r) => r.norm),
          laterRefs.map((r) => r.norm),
        );
        for (const j of hit) mark(laterRefs[j]!, 'W3', earlier.sha);
      }
    }
  }

  // ---- W1 — abandoned work: unreachable from delivered, no patch-equivalent survivor.
  for (const c of counted) {
    if (c.delivered || c.merge || relanded.has(c.sha)) continue;
    const survived =
      c.patchId !== null &&
      (byPatch.get(c.patchId) ?? []).some((o) => o.delivered && o.sha !== c.sha);
    if (survived) continue;
    for (const f of c.files) {
      for (const r of seqs.get(`${c.sha} ${f.path}`) ?? []) mark(r, 'W1', 'unmerged');
    }
  }

  // ---- W2 — clobbered work: cross-actor deletion of a window-authored delivered line.
  for (const d of facts.deletions) {
    const src = bySha.get(d.srcSha);
    const del = bySha.get(d.delSha);
    if (!src || !del || src.actor === del.actor) continue;
    const refs = seqs.get(`${d.srcSha} ${d.path}`) ?? [];
    const r = refs.find((x) => x.n === d.srcLine);
    if (r) mark(r, 'W2', d.delSha);
  }

  // ---- W4 — conflict churn: the extractor pre-computed merge deltas as the merge commit's files.
  for (const c of counted) {
    if (!c.merge) continue;
    for (const f of c.files) {
      for (const r of seqs.get(`${c.sha} ${f.path}`) ?? []) mark(r, 'W4', 'merge-delta');
    }
  }

  // ---- Roll-up.
  const wasted: Record<WasteClass, number> = { W1: 0, W2: 0, W3: 0, W4: 0 };
  const byActor: Record<string, { authored: number; wasted: number }> = {};
  const lines = [...verdicts.values()];
  for (const v of lines) {
    const a = (byActor[v.actor] ??= { authored: 0, wasted: 0 });
    a.authored += 1;
    if (v.cls !== 'survived') {
      wasted[v.cls] += 1;
      a.wasted += 1;
    }
  }
  const wastedTotal = wasted.W1 + wasted.W2 + wasted.W3 + wasted.W4;
  const total = lines.length;
  return {
    predicateSet: PREDICATE_SET_VERSION,
    totalAuthoredLines: total,
    wasted,
    wastedTotal,
    wastedPct: total === 0 ? 0 : (wastedTotal / total) * 100,
    byActor,
    lines,
  };
}
