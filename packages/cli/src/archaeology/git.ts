/**
 * cookoff git-archaeology — the git reference collector (ADR 123 / ADR 122 §5). Extracts
 * RepoFacts for the pure engine from git alone: no daemon, no musterd state. Actor identity is
 * git attribution (ADR 109): a `Co-authored-by: <seat> <seat@<team>.musterd>` trailer wins over
 * the author email, so seat identity survives the squash.
 */

import { execFileSync } from 'node:child_process';
import type { CommitFacts, DeletionProvenance, FileChange, RepoFacts } from './engine.js';

export interface ExtractOptions {
  repo: string;
  /** The kickoff commit — the pinned starting SHA; the window is everything after it. */
  start: string;
  /** The delivered ref (integration branch tip at run end). Default HEAD. */
  delivered?: string;
  /** Exclusion globs on repo-relative paths (lockfiles, dist, …). */
  exclude?: string[];
}

export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/*.lock',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/*.snap',
];

function git(args: string[], cwd: string, input?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
}

/** Minimal glob → RegExp: `**` any path, `*` any segment chars. Anchored both ends. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      out += '.*';
      i += 2;
    } else if (glob[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else {
      const ch = glob[i]!;
      out += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

interface ParsedDiff {
  files: FileChange[];
  /** Pre-image deleted line numbers per path (against the first parent). */
  deleted: Map<string, number[]>;
}

/** Parse `--unified=0 --no-renames` diff text into added/deleted lines with line numbers. */
export function parseDiff(text: string, excluded: (path: string) => boolean): ParsedDiff {
  const files: FileChange[] = [];
  const deleted = new Map<string, number[]>();
  let path: string | null = null;
  let cur: FileChange | null = null;
  let oldN = 0;
  let newN = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      path = p === '/dev/null' ? path : p.replace(/^b\//, '');
      if (path !== null && !excluded(path)) {
        cur = { path, added: [] };
        files.push(cur);
      } else {
        cur = null;
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      path = p === '/dev/null' ? null : p.replace(/^a\//, '');
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldN = Number(hunk[1]);
      newN = Number(hunk[2]);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      cur?.added.push({ n: newN, text: line.slice(1) });
      newN += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      if (cur !== null && path !== null) {
        const arr = deleted.get(path) ?? [];
        arr.push(oldN);
        deleted.set(path, arr);
      }
      oldN += 1;
    }
  }
  return { files, deleted };
}

/** Seat trailer email beats author email (ADR 109 — the trailer survives the squash). */
export function resolveActor(authorEmail: string, body: string): string {
  for (const m of body.matchAll(/^Co-authored-by:.*<([^>]+)>\s*$/gim)) {
    if (m[1] !== undefined && /\.musterd$/i.test(m[1])) return m[1].toLowerCase();
  }
  return authorEmail.toLowerCase();
}

const SEP = '\x00';

/** Extract RepoFacts for the engine. Read-only; every fact comes from git plumbing. */
export function extractFacts(opts: ExtractOptions): RepoFacts {
  const { repo, start } = opts;
  const delivered = opts.delivered ?? 'HEAD';
  const regexes = (opts.exclude ?? DEFAULT_EXCLUDES).map(globToRegExp);
  const excluded = (p: string): boolean => regexes.some((r) => r.test(p));

  const windowShas = git(['rev-list', '--all', '--not', start], repo).split('\n').filter(Boolean);
  const deliveredSet = new Set(
    git(['rev-list', delivered, '--not', start], repo).split('\n').filter(Boolean),
  );

  const windowSet = new Set(windowShas);
  const commits: CommitFacts[] = [];
  const deletions: DeletionProvenance[] = [];

  for (const sha of windowShas) {
    const meta = git(['show', '-s', '--format=%ae%x00%ct%x00%P%x00%B', sha], repo);
    const [ae = '', ct = '', parents = '', ...bodyParts] = meta.split(SEP);
    const body = bodyParts.join(SEP);
    const parentList = parents.trim().split(' ').filter(Boolean);
    const merge = parentList.length > 1;
    const actor = resolveActor(ae.trim(), body);
    const order = Number(ct.trim());

    let files: FileChange[] = [];
    let patchId: string | null = null;

    if (!merge) {
      const diffText = git(
        ['show', sha, '--format=', '--unified=0', '--no-renames', '--no-color'],
        repo,
      );
      const parsed = parseDiff(diffText, excluded);
      files = parsed.files.filter((f) => f.added.length > 0);
      if (diffText.trim() !== '') {
        const out = git(['patch-id', '--stable'], repo, diffText);
        patchId = out.split(' ')[0]?.trim() || null;
      }
      // W2 provenance: blame each deleted line of a *delivered* commit against its first parent.
      if (deliveredSet.has(sha) && parentList.length === 1) {
        for (const [path, nums] of parsed.deleted) {
          for (const range of toRanges(nums)) {
            let blame = '';
            try {
              blame = git(
                ['blame', '--porcelain', '-L', `${range[0]},${range[1]}`, `${sha}^`, '--', path],
                repo,
              );
            } catch {
              continue; // path absent in the parent (rename/mode edge) — skip, warn-never-block
            }
            for (const m of blame.matchAll(/^([0-9a-f]{40}) (\d+) \d+(?: \d+)?$/gm)) {
              const srcSha = m[1]!;
              if (windowSet.has(srcSha) && srcSha !== sha) {
                deletions.push({ delSha: sha, srcSha, path, srcLine: Number(m[2]!) });
              }
            }
          }
        }
      }
    } else if (deliveredSet.has(sha)) {
      // W4: replay the auto-merge and diff it against the actual merge result.
      try {
        const auto = git(['merge-tree', '--write-tree', parentList[0]!, parentList[1]!], repo)
          .split('\n')[0]!
          .trim();
        const delta = git(
          ['diff', '--unified=0', '--no-renames', '--no-color', auto, `${sha}^{tree}`],
          repo,
        );
        files = parseDiff(delta, excluded).files.filter((f) => f.added.length > 0);
      } catch {
        // merge-tree exits non-zero on conflicts but still prints the tree on stdout; older git
        // lacks --write-tree entirely. Either way: no churn data beats a crash.
        files = [];
      }
    }

    commits.push({ sha, actor, order, delivered: deliveredSet.has(sha), patchId, files, merge });
  }

  const ancestryCache = new Map<string, boolean>();
  const isAncestor = (a: string, b: string): boolean => {
    const k = `${a} ${b}`;
    const hit = ancestryCache.get(k);
    if (hit !== undefined) return hit;
    let v = false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo });
      v = true;
    } catch {
      v = false;
    }
    ancestryCache.set(k, v);
    return v;
  };

  return { commits, deletions, isAncestor };
}

/** Collapse sorted line numbers into inclusive [from,to] ranges for batched blame calls. */
export function toRanges(nums: number[]): Array<[number, number]> {
  const sorted = [...nums].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else if (!last || n > last[1]) out.push([n, n]);
  }
  return out;
}
