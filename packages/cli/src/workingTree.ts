import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ADR 239 — foreign paths in the working tree.
 *
 * A worktree is one directory with one HEAD shared by every session running in it, and git has no
 * notion of sessions. When a second session runs `git add -A`, it stages the *first* session's
 * uncommitted work into its own unrelated commit — the 2026-08-05 incident, where an ADR plus a
 * server implementation left one lane and merged under another, and the original PR had to be closed.
 *
 * The posture is **warn, never deny** (ADR 239 decision 1/4), and the reason is measured, not
 * squeamish: the audit ledger shows 54 same-workspace displacements in a month against one observed
 * collision. A gate priced for a daily event defending a monthly one is the gate ADR 150 warns
 * becomes the thing everyone learns to work around.
 *
 * Everything here is local and disposable (decision 2): the per-session edit index never leaves the
 * machine, writes no audit row, and degrades to *no warning* rather than a false one when it is
 * missing. Nothing in this module writes to the working tree (decision 5) — the caller's only git
 * command is `status`.
 */

/** Where the index lives inside a workspace's musterd state dir. One file per session. */
function indexFile(stateDir: string, sessionId: string): string {
  // The session id comes from the harness envelope; keep it inside the state dir regardless of shape.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '.');
  return join(stateDir, `session-edits-${safe}.txt`);
}

/**
 * Append a path this session wrote. Called from the gate's write-shaped branch, where the path has
 * already been made repo-relative — so it compares directly against `git status --porcelain`.
 *
 * Append-only and best-effort: a hook must never break the tool call it rides on, so an unwritable
 * or absent state dir is swallowed. The cost of losing a write is a possible false positive, which
 * the warning's wording is built to absorb; the cost of throwing is a wedged Edit.
 */
export function recordSessionEdit(stateDir: string, sessionId: string, path: string): void {
  if (!sessionId || !path) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(indexFile(stateDir, sessionId), `${path}\n`);
  } catch {
    // best-effort by construction (ADR 150 guard metric)
  }
}

/**
 * Has this session an index at all? The difference between "wrote nothing" and "the index could not
 * be written" is invisible in the *contents* of an absent file, and the two want opposite answers:
 * the first makes every modified path foreign, the second makes the whole comparison meaningless.
 *
 * Found by exercising the real hook (2026-08-05): with no `.musterd/` to append to, every write was
 * silently dropped and the next `git add -A` reported the session's **own** files as foreign. So the
 * absent index is treated as no-knowledge and warns about nothing — decision 2's "degrades to no
 * warning, never to a false one" is only true because of this check.
 */
export function hasSessionIndex(stateDir: string, sessionId: string): boolean {
  return Boolean(sessionId) && existsSync(indexFile(stateDir, sessionId));
}

/** The set of repo-relative paths this session is known to have written. Unknown session → empty. */
export function readSessionEdits(stateDir: string, sessionId: string): Set<string> {
  try {
    const raw = readFileSync(indexFile(stateDir, sessionId), 'utf8');
    const out = new Set<string>();
    for (const line of raw.split('\n')) {
      const p = line.trim();
      if (p) out.add(p);
    }
    return out;
  } catch {
    return new Set();
  }
}

/** Short options that consume the next token as their value, so it is never a pathspec. */
const VALUE_SHORT = 'mFCcS';
/** Long options that consume the next token as their value (the `--opt=value` form self-consumes). */
const VALUE_LONG = new Set([
  '--message',
  '--file',
  '--author',
  '--date',
  '--reuse-message',
  '--reedit-message',
  '--gpg-sign',
  '--cleanup',
  '--pathspec-from-file',
]);

/**
 * Split a command into tokens with quoted runs collapsed to a single opaque token, so a commit
 * message can never be mistaken for a pathspec. Deliberately not a shell parser: anything it cannot
 * read confidently ends up as a bare token, which makes the caller decline to match — the safe
 * direction, since a missed warning costs nothing and a wrong one is the defect being fixed.
 */
function tokenize(command: string): string[] {
  const out: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g;
  for (const m of command.match(re) ?? []) out.push(m);
  return out;
}

/**
 * Does this command stage an *implicit* path set **in this worktree**? Only those are worth a
 * `git status`, because only for those does the status we can afford to run describe the same set
 * of files the command will actually stage.
 *
 * Corrected 2026-08-05 after gptbot's outcome review found two false-positive classes, both of them
 * the same mistake: the first pass matched `normalizeCommand(command)`, and that normalizer exists
 * to answer a *different question*. It lifts off git's pre-subcommand globals (ADR 153) so the
 * enforcement matcher can classify `git -C ../main merge` as a merge — right for "what class of
 * action is this", fatal for "which tree does this touch", because it erases the very token that
 * answers it. ADR 225's shared-predicate trap, and the reason this matches the RAW command:
 *
 *  - **A pathspec narrows the command below the status.** `git add -A own/` stages only `own/`,
 *    while `git status` reports the whole tree — so a foreign file outside `own/` got named as one
 *    this command would stage, which is exactly what the warning promises it never does.
 *  - **A tree-redirecting global points somewhere else entirely.** `git -C ../main add -A` stages a
 *    sibling worktree while status runs here; the warning would describe a tree the command never
 *    touches.
 *  - **`git add .` is scoped to the shell's cwd**, which the hook cannot observe (the Bash tool's
 *    cwd persists across calls; the hook always runs at the repo root). Unknown scope, so no match.
 *
 * An env prefix is still lifted, and only that: it changes the identity of the committer, never the
 * tree that is committed to.
 */
export function isStageShaped(command: string): boolean {
  // First line only + env-assignment prefix stripped — the two passes that cannot change the tree.
  const flat = (command.split('\n', 1)[0] ?? '').trim();
  const tokens = tokenize(flat);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
  if (tokens[i] !== 'git') return false; // `cd sub && git add -A` included: not ours to guess
  i += 1;

  // Any pre-subcommand global that redirects the tree disqualifies the command outright.
  while (i < tokens.length && tokens[i]!.startsWith('-')) {
    const t = tokens[i]!;
    if (t === '-C' || t === '--git-dir' || t === '--work-tree') return false;
    if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) return false;
    i += 1;
  }

  const sub = tokens[i];
  i += 1;
  if (sub !== 'add' && sub !== 'commit') return false;

  const pathless =
    sub === 'add'
      ? new Set(['-A', '--all', '-u', '--update'])
      : new Set(['-a', '--all']);
  let sawPathless = false;

  for (; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t === '--') return false; // everything after `--` is a pathspec by definition
    if (!t.startsWith('-')) return false; // a bare token is a pathspec — unknown scope, decline
    if (pathless.has(t)) {
      sawPathless = true;
      continue;
    }
    if (t.startsWith('--')) {
      const name = t.split('=', 1)[0]!;
      if (VALUE_LONG.has(name) && !t.includes('=')) i += 1; // consumes its value
      continue;
    }
    // A short cluster: `-am` is -a + -m, and a trailing value-taking short flag eats the next token.
    const cluster = t.slice(1);
    if (sub === 'commit' && cluster.includes('a')) sawPathless = true;
    if (sub === 'add' && (cluster.includes('A') || cluster.includes('u'))) sawPathless = true;
    const last = cluster.at(-1);
    if (last && VALUE_SHORT.includes(last)) i += 1;
  }
  return sawPathless;
}

/**
 * The paths a stage-shaped command would sweep in that this session never wrote.
 *
 * Untracked files (`??`) are excluded on purpose (decision 3): a build artifact or scratch file is
 * the overwhelming majority of unknown paths, and staging one is not the incident. What is left is
 * *tracked* paths modified on disk by someone other than this session — precisely the incident's
 * signature.
 */
export function foreignModifiedPaths(porcelain: string, own: Set<string>): string[] {
  const out: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    if (status === '??' || status === '!!') continue; // untracked / ignored — never foreign
    // A rename prints `old -> new`; the destination is the path that ends up in the commit.
    const raw = line.slice(3);
    const arrow = raw.indexOf(' -> ');
    const path = (arrow >= 0 ? raw.slice(arrow + 4) : raw).trim().replace(/^"|"$/g, '');
    if (!path || own.has(path) || out.includes(path)) continue;
    out.push(path);
  }
  return out;
}

/**
 * The advisory text. Deliberately an observation to check rather than a verdict: the gate cannot see
 * a heredoc or a `sed -i`, so a path this session really did write can still look foreign. Naming
 * the paths is the whole value — the reader can tell in one glance whether they are theirs.
 */
export function foreignPathWarning(paths: string[], command: string): string {
  const list = paths.map((p) => `  ${p}`).join('\n');
  return (
    `musterd (ADR 239): \`${command}\` will stage ${paths.length} tracked ` +
    `file${paths.length === 1 ? '' : 's'} this session did not write:\n${list}\n` +
    'If another session is working in this folder, staging these takes over its uncommitted work — ' +
    'stage your own paths explicitly instead. If you wrote them through a command this gate cannot ' +
    'see (a heredoc, `sed -i`), carry on.'
  );
}
