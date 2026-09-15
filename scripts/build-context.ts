/*
 * `.dockerignore` semantics, implemented so a gate can ask "would this path enter the build
 * context?" without a Docker daemon.
 *
 * This is a port of the rules Docker itself applies (moby/patternmatcher), not a glob library:
 *
 * - patterns are slash-separated and cleaned; a trailing `/` is stripped, so `.musterd/` and
 *   `.musterd` are the same pattern;
 * - `*` matches within one path segment, `?` matches one character, `**` spans segments;
 * - a leading `!` re-includes, and the LAST matching pattern wins — which is why a naive
 *   "does any pattern match" check is wrong;
 * - a path is excluded if it matches OR ANY OF ITS PARENT DIRECTORIES matches. This is the rule
 *   that makes `.musterd/` cover `.musterd/binding.json`, and the one most hand-rolled checks miss.
 *
 * Kept separate from check-build-context.ts so the semantics can be tested directly — a gate whose
 * matcher is wrong in the permissive direction reads as protection while protecting nothing.
 */

/** One parsed `.dockerignore` line. */
export interface IgnorePattern {
  /** Segments of the cleaned pattern, e.g. `['**', '.musterd']`. */
  segments: string[];
  /** `!`-prefixed: this line re-includes what an earlier line excluded. */
  negated: boolean;
  /** The line as written, for error messages that can be traced back to the file. */
  source: string;
}

/**
 * Parse a `.dockerignore` file's text. Blank lines and `#` comments are dropped, as Docker does.
 * A lone `!` is not a valid pattern and is dropped rather than throwing: this parser is used by a
 * gate, and a gate that crashes on a malformed line tells you less than one that keeps checking.
 */
export function parseDockerignore(text: string): IgnorePattern[] {
  const out: IgnorePattern[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const body = (negated ? line.slice(1) : line).trim();
    if (body === '') continue;
    const segments = body.split('/').filter((s) => s !== '' && s !== '.');
    if (segments.length === 0) continue;
    out.push({ segments, negated, source: line });
  }
  return out;
}

/** Does one `*`/`?`-bearing segment pattern match one literal path segment? */
function segmentMatches(pattern: string, segment: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === segment;
  const rx = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return '[^/]*';
      if (ch === '?') return '[^/]';
      return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${rx}$`).test(segment);
}

/** Does a parsed pattern match this exact path (no parent-directory walking)? */
export function patternMatches(pattern: IgnorePattern, path: string): boolean {
  const parts = path.split('/').filter((s) => s !== '');
  const pat = pattern.segments;

  // `**` makes this a subsequence problem, so walk it rather than zipping the two arrays.
  const memo = new Map<string, boolean>();
  const walk = (pi: number, si: number): boolean => {
    const key = `${pi}:${si}`;
    const seen = memo.get(key);
    if (seen !== undefined) return seen;
    let result: boolean;
    if (pi === pat.length) {
      result = si === parts.length;
    } else if (pat[pi] === '**') {
      // `**` matches zero or more segments.
      result = false;
      for (let skip = si; skip <= parts.length && !result; skip += 1) result = walk(pi + 1, skip);
    } else if (si === parts.length) {
      result = false;
    } else {
      result = segmentMatches(pat[pi]!, parts[si]!) && walk(pi + 1, si + 1);
    }
    memo.set(key, result);
    return result;
  };
  return walk(0, 0);
}

/**
 * Would Docker EXCLUDE this path from the build context?
 *
 * Last match wins, and a path is matched by its own name or by any ancestor directory — the two
 * rules that decide whether `.musterd/binding.json` is really covered by a `.musterd/` line.
 */
export function isExcluded(patterns: IgnorePattern[], path: string): boolean {
  const parts = path.split('/').filter((s) => s !== '');
  // The path itself and every ancestor: `a/b/c` → `a`, `a/b`, `a/b/c`.
  const candidates: string[] = [];
  for (let i = 1; i <= parts.length; i += 1) candidates.push(parts.slice(0, i).join('/'));

  let excluded = false;
  for (const pattern of patterns) {
    if (!candidates.some((c) => patternMatches(pattern, c))) continue;
    excluded = !pattern.negated;
  }
  return excluded;
}
