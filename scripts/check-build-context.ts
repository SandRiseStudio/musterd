/*
 * Fail if a Docker build context would carry seat-local state or a credential.
 *
 *   pnpm build-context:check
 *
 * Every image that builds musterd from source is `COPY . .` from the repo root — three of them, a
 * count this gate discovered rather than assumed — so `.dockerignore` is the only thing between a
 * developer's working tree and a published image layer. `.musterd/binding.json` is the seat's binding and holds a live credential at mode 600:
 * before #1433, deploying the cloud seat from any seat worktree copied that key into the image at
 * /app/.musterd/binding.json, world-readable inside the container. ADR 390's least-privilege pass
 * hunted exactly that class ("the hub's team agent key as a live Fly secret") and missed it,
 * because nobody read `.dockerignore`.
 *
 * `.gitignore` keeps these files out of commits. Docker does not read `.gitignore`, and the two
 * lists drift silently — the failure is invisible until someone unpacks an image. So this gate
 * asserts the Docker half directly, using Docker's own matching rules (see build-context.ts).
 *
 * Three rules, each able to fail on its own:
 *
 *   A. every hazard path is excluded — the representative files a real seat worktree holds;
 *   B. the set of Dockerfiles that copy their whole context is KNOWN, so the next one cannot
 *      arrive unread — nothing in a Dockerfile records the context it is invoked with;
 *   C. nothing under a seat-state root in THIS working tree would enter the context — a local-run
 *      strengthener that catches a harness writing some new file we have not thought of.
 *
 * Rule C is vacuous on a clean CI checkout by construction. That is fine: A and B are the gate,
 * and C is what fires on the machine where the dangerous files actually exist.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExcluded, parseDockerignore, type IgnorePattern } from './build-context.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/**
 * Representative paths a real seat worktree holds. Not an exhaustive list of secrets — an
 * exhaustive list is exactly the thing that drifts — but one file per class, each of which really
 * exists in a bound worktree, so a `.dockerignore` weakened to a per-file list fails here.
 */
export const HAZARD_PATHS = [
  // The seat binding: a live credential, mode 600. The reason this gate exists.
  '.musterd/binding.json',
  // Same file one package deep — a worktree is not the only place a binding can sit, and a
  // pattern without `**` would pass the line above while missing this one.
  'packages/cli/.musterd/binding.json',
  // The rest of the seat's local state: not credentials, but per-seat and never wanted in an image.
  '.musterd/continuity.json',
  '.musterd/pending/01ABC.json',
  '.musterd/workspace.json',
  // Harness-provisioned, per-workspace and personal (ADR 085). `.codex/auth.json` can hold auth.
  '.claude/settings.local.json',
  '.codex/auth.json',
  '.codex/config.toml',
] as const;

/** Paths that MUST still reach the image — the falsifier for an over-broad `.dockerignore`. */
export const REQUIRED_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'packages/cli/src/bin.ts',
  'packages/mcp/src/tools/inboxCheck.ts',
  'deploy/cloud-seat/entrypoint.sh',
] as const;

/** Directories whose entire contents are seat-local. Rule C walks these in the working tree. */
const SEAT_STATE_ROOTS = ['.musterd', '.claude', '.codex'] as const;

/**
 * Dockerfiles known to copy their whole build context, each confirmed to be invoked with the repo
 * root as that context (each says so in its own header). Rule B fails on any other, because
 * nothing inside a Dockerfile records where it is run from — a human has to look.
 */
export const KNOWN_WHOLE_CONTEXT: readonly string[] = [
  'deploy/cloud-seat/Dockerfile',
  'scripts/broadcast/hosted.Dockerfile',
  'scripts/perf/broadcast-bench.Dockerfile',
];

/** Rule A — every hazard path is excluded. Returns the ones that would enter the context. */
export function ruleA(patterns: IgnorePattern[], hazards: readonly string[] = HAZARD_PATHS) {
  return hazards.filter((p) => !isExcluded(patterns, p));
}

/** Rule A's falsifier — a path the build NEEDS must not be excluded. Returns the over-broad hits. */
export function ruleAOverBroad(
  patterns: IgnorePattern[],
  required: readonly string[] = REQUIRED_PATHS,
) {
  return required.filter((p) => isExcluded(patterns, p));
}

/**
 * Rule B — does this Dockerfile copy its whole build context?
 *
 * `COPY . .`, `COPY . /app`, `COPY --chown=x:y . .` and `ADD . .` all do. A Dockerfile that only
 * copies named subtrees carries no whole-tree hazard, so it does not need the guarantee.
 */
export function copiesWholeContext(dockerfile: string): boolean {
  for (const raw of dockerfile.split('\n')) {
    const line = raw.trim();
    if (!/^(COPY|ADD)\b/i.test(line)) continue;
    // Drop the verb and any --flags, then look at the first source operand.
    const operands = line
      .replace(/^(COPY|ADD)\b/i, '')
      .trim()
      .split(/\s+/)
      .filter((t) => !t.startsWith('--'));
    if (operands.length >= 2 && (operands[0] === '.' || operands[0] === './')) return true;
  }
  return false;
}

function* walk(dir: string, skip: ReadonlySet<string>): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(p, skip);
    else if (st.isFile()) yield p;
  }
}

function main(): void {
  const failures: string[] = [];

  const ignorePath = join(repoRoot, '.dockerignore');
  if (!existsSync(ignorePath)) {
    console.error(
      'no .dockerignore at the repo root — every Dockerfile here copies the whole tree, so without it\n' +
        'a seat binding (a live credential) lands in the image. See #1433.',
    );
    process.exit(1);
  }
  const patterns = parseDockerignore(readFileSync(ignorePath, 'utf8'));

  // Rule A.
  const leaked = ruleA(patterns);
  if (leaked.length > 0) {
    failures.push(
      'these would ENTER a build context from the repo root — .dockerignore does not exclude them:\n' +
        leaked.map((p) => `  ${p}`).join('\n') +
        '\n  (.musterd/ holds the seat binding: a live credential at mode 600. See #1433.)',
    );
  }

  const overBroad = ruleAOverBroad(patterns);
  if (overBroad.length > 0) {
    failures.push(
      'these are EXCLUDED but the image needs them — .dockerignore is too broad:\n' +
        overBroad.map((p) => `  ${p}`).join('\n'),
    );
  }

  // Rule B — the set of whole-context Dockerfiles is known, so the NEXT one cannot arrive
  // unnoticed. The root `.dockerignore` only protects a build actually run from the repo root;
  // nothing in a Dockerfile says where it is invoked from, so a new one has to be read by a human
  // before it is trusted. Failing on an unknown file is the only honest enforcement available.
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage', '.turbo', '.vite']);
  const dockerfiles = [...walk(repoRoot, skip)].filter((p) => /(^|\/|\.)Dockerfile$/.test(p));
  const wholeContext = dockerfiles
    .filter((p) => copiesWholeContext(readFileSync(p, 'utf8')))
    .map((p) => relative(repoRoot, p))
    .sort();
  const unknown = wholeContext.filter((p) => !KNOWN_WHOLE_CONTEXT.includes(p));
  const missing = KNOWN_WHOLE_CONTEXT.filter((p) => !wholeContext.includes(p));
  if (unknown.length > 0) {
    failures.push(
      'a Dockerfile copies its WHOLE build context and this gate has never seen it:\n' +
        unknown.map((p) => `  ${p}`).join('\n') +
        '\n  Confirm it is invoked with the repo root as its context (so the root .dockerignore\n' +
        '  applies), or give it its own .dockerignore — then add it to KNOWN_WHOLE_CONTEXT.',
    );
  }
  if (missing.length > 0) {
    failures.push(
      'KNOWN_WHOLE_CONTEXT names a Dockerfile that no longer copies its whole context:\n' +
        missing.map((p) => `  ${p}`).join('\n') +
        '\n  Good news, probably — drop it from the list so this gate keeps meaning something.',
    );
  }

  // Rule C — real files in THIS working tree that would enter the context.
  const present: string[] = [];
  for (const root of SEAT_STATE_ROOTS) {
    const dir = join(repoRoot, root);
    if (!existsSync(dir)) continue;
    for (const file of walk(dir, skip)) {
      const rel = relative(repoRoot, file);
      if (!isExcluded(patterns, rel)) present.push(rel);
    }
  }
  if (present.length > 0) {
    failures.push(
      `${present.length} seat-local file(s) in this working tree would enter a build context:\n` +
        present
          .slice(0, 10)
          .map((p) => `  ${p}`)
          .join('\n') +
        (present.length > 10 ? `\n  … and ${present.length - 10} more` : ''),
    );
  }

  if (failures.length > 0) {
    console.error(`build context would carry what it must not:\n\n${failures.join('\n\n')}`);
    process.exit(1);
  }

  console.log(
    `✓ build context clean — ${HAZARD_PATHS.length} hazard path(s) excluded, ` +
      `${REQUIRED_PATHS.length} required path(s) kept, ` +
      `${dockerfiles.length} Dockerfile(s) governed by .dockerignore`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
