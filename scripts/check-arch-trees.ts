/*
 * Check that the `## File tree `packages/<pkg>/src/`` blocks in the architecture docs
 * list exactly the real source files — no missing entries, no stale ones (ADR 043).
 *
 *   pnpm arch-trees:check   — fail (exit 1) on any drift between a doc tree and src/
 *
 * Why a CHECKER and not a generator: each tree line carries a curated, load-bearing
 * description (the `// …` comment) that belongs next to the architecture prose. We enforce
 * the *structure* (the set of files) and leave the *description* hand-authored — so a new
 * file fails the check until a human documents it with a real line, never a blank generated
 * one. This is the `roadmap:check` half of ADR 041 applied to the file trees. Runs on Node's
 * native TypeScript (no build step, no deps).
 *
 * Auto-discovery: any doc under docs/ with a ``## File tree `packages/<pkg>/src/` `` heading
 * followed by a fenced block is picked up automatically — add a new package doc and it's checked.
 *
 * Coverage rule: a tree must list every `*.ts` file under its `src/` EXCEPT `*.test.ts`
 * (tests are never in the trees). Adjust IGNORE below if a deliberate exclusion arises.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const DOCS_DIR = join(repoRoot, 'docs');

/** A file is ignored (not required in a doc tree) if this returns true. */
function isIgnored(relPath: string): boolean {
  return relPath.endsWith('.test.ts');
}

/** Every doc with a `## File tree `<pkgSrc>`` heading + a following fenced block. */
function findDocsWithTrees(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.md')) out.push(full);
    }
  };
  walk(DOCS_DIR);
  return out.sort();
}

/** Parse an indentation tree fence into the set of file paths it declares (relative to its src root). */
function parseTreeFence(fence: string): string[] {
  const files: string[] = [];
  const stack: { indent: number; path: string }[] = [];
  for (const raw of fence.split('\n')) {
    // Strip the trailing `// description`. Filenames never contain `//`, so the first `//` is the comment.
    const code = raw.split('//')[0] ?? '';
    if (code.trim() === '') continue; // blank line or comment-continuation line (no filename)
    const indent = code.length - code.trimStart().length;
    const name = code.trim();
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1]!.path : null;
    const isDir = name.endsWith('/');
    const clean = isDir ? name.slice(0, -1) : name;
    const path = parent ? `${parent}/${clean}` : clean;
    if (isDir) stack.push({ indent, path });
    else files.push(path);
  }
  return files;
}

/** Extract each (pkgSrc, declaredFiles) pair from a doc. A tree heading names the src root it documents. */
function treesInDoc(docText: string): { pkgSrc: string; declared: string[] }[] {
  const out: { pkgSrc: string; declared: string[] }[] = [];
  // Heading like:  ## File tree `packages/server/src/`
  const headingRe = /^#{1,6}\s+File tree\s+`([^`]+)`/gm;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(docText)) !== null) {
    const pkgSrc = m[1]!.replace(/\/$/, ''); // strip trailing slash → packages/server/src
    // Find the first fenced block after the heading.
    const rest = docText.slice(m.index);
    const fenceMatch = rest.match(/```[^\n]*\n([\s\S]*?)\n```/);
    if (!fenceMatch) continue;
    out.push({ pkgSrc, declared: parseTreeFence(fenceMatch[1]!) });
  }
  return out;
}

/** All non-ignored source files actually under a src root, as `src/...`-rooted relative paths. */
function actualFiles(pkgSrc: string): string[] {
  const abs = join(repoRoot, pkgSrc);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) {
        const rel = relative(repoRoot, full);
        if (!isIgnored(rel)) found.push(rel);
      }
    }
  };
  walk(abs);
  return found;
}

/** Map a doc-declared path (rooted at `src/...`) to a repo-relative path under the package. */
function declaredToRepoPath(pkgSrc: string, declared: string): string {
  // declared looks like `src/db/open.ts`; pkgSrc is `packages/server/src`. Replace the leading `src`.
  const withoutSrc = declared.replace(/^src\/?/, '');
  return withoutSrc ? `${pkgSrc}/${withoutSrc}` : pkgSrc;
}

let drift = false;
const docs = findDocsWithTrees();
for (const doc of docs) {
  const text = readFileSync(doc, 'utf8');
  for (const { pkgSrc, declared } of treesInDoc(text)) {
    const declaredSet = new Set(declared.map((d) => declaredToRepoPath(pkgSrc, d)));
    const actualSet = new Set(actualFiles(pkgSrc));
    const missing = [...actualSet].filter((f) => !declaredSet.has(f)).sort(); // in src, not in doc
    const stale = [...declaredSet].filter((f) => !actualSet.has(f)).sort(); // in doc, not in src
    const rel = relative(repoRoot, doc);
    if (missing.length === 0 && stale.length === 0) {
      process.stdout.write(`✓ ${rel} — \`${pkgSrc}/\` tree matches (${actualSet.size} files)\n`);
      continue;
    }
    drift = true;
    process.stderr.write(`✗ ${rel} — \`${pkgSrc}/\` tree out of sync:\n`);
    for (const f of missing) process.stderr.write(`    missing from doc:  ${f}\n`);
    for (const f of stale) process.stderr.write(`    stale in doc:      ${f}\n`);
  }
}

if (drift) {
  process.stderr.write(
    '\nArchitecture file trees are out of sync with the source. Add a described line for each ' +
      'missing file (or remove the stale entry) in the doc tree above.\n',
  );
  process.exit(1);
}
process.stdout.write('All architecture file trees are in sync with the source.\n');
