import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ADR 239 — foreign paths in the working tree, as decided by its 2026-08-06 verdict.
 *
 * A worktree is one directory with one HEAD shared by every session running in it, and git has no
 * notion of sessions. When a second session runs `git add -A`, it stages the *first* session's
 * uncommitted work into its own unrelated commit — the 2026-08-05 incident, where an ADR plus a
 * server implementation left one lane and merged under another, and the original PR had to be closed.
 *
 * **Why this lives in the working tree and nowhere cheaper.** The obvious alternative is to ask the
 * daemon whether another session is live in this folder. It cannot answer. ADR 068 single-active
 * means the second session EVICTS the first, and `touchAmbientPresence` no-ops while the winner
 * holds a socket — so the evicted-but-still-working session (ADR 237's whole subject, and precisely
 * the dangerous actor) is invisible to the coordination layer by construction. The tree is the only
 * place it can be observed.
 *
 * **Why the predicate is mtime and not an edit set.** The first implementation asked "is this path
 * in the set this session wrote", built from Edit/Write tool calls. Its negative space was unbounded:
 * every write through Bash — a heredoc, `sed -i`, an interpreter's own I/O — was invisible, and
 * therefore became an accusation. Day one measured four false positives from exactly that, and its
 * one true positive was overridden by an engineer whom the false ones had taught to dismiss it.
 *
 * This asks a question with no unbounded negative space: **was this path last modified before this
 * session began?** If so it cannot be this session's work — not "was not observed to be", but cannot
 * be. Certainty replaces inference, the whole false-positive class disappears by construction rather
 * than by teaching the gate about every write channel, and the tool-call index is gone entirely.
 *
 * The accepted cost is recall: a genuinely concurrent writer is no longer caught, which means the
 * motivating incident itself would not be. That trade is deliberate and is argued in the ADR — a
 * warning nobody believes prevents nothing, and credibility was the resource in shortest supply.
 *
 * Posture is unchanged: **warn, never deny**, and nothing here writes to the working tree.
 */

/** The per-session marker whose mtime IS the session's start. One file, written once, never read
 *  across sessions. Replaces the append-per-edit index the verdict removed. */
function markerFile(stateDir: string, sessionId: string): string {
  // The session id comes from the harness envelope; keep it inside the state dir regardless of shape.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '.');
  return join(stateDir, `session-start-${safe}`);
}

/**
 * Stamp this session's start, if it has not been stamped. Returns true when this call CREATED it —
 * the caller needs that, because a marker created by the very command being judged carries no
 * information (everything on disk would predate it) and must stay silent.
 *
 * Best-effort: a hook must never break the tool call it rides on, so an unwritable state dir is
 * swallowed and simply leaves the session unmarked, which means no warning ever.
 */
export function markSessionStart(stateDir: string, sessionId: string): boolean {
  if (!sessionId) return false;
  try {
    mkdirSync(stateDir, { recursive: true });
    // `wx` fails if it exists — the atomic "create only" that keeps a resumed session's original start.
    closeSync(openSync(markerFile(stateDir, sessionId), 'wx'));
    return true;
  } catch {
    return false;
  }
}

/** When this session began, or undefined if it was never marked (→ no knowledge → no warning). */
export function sessionStartedAt(stateDir: string, sessionId: string): number | undefined {
  if (!sessionId) return undefined;
  try {
    return statSync(markerFile(stateDir, sessionId)).mtimeMs;
  } catch {
    return undefined;
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

  // Any pre-subcommand global that redirects the tree disqualifies the command outright. The
  // *attached* forms (`--git-dir=x`) are the load-bearing half: git requires a separate token for
  // `-C <path>` and `--git-dir <path>`, and that token then fails the subcommand check below. The
  // separated forms are named here anyway, because a reader should not have to derive that
  // second-order argument to know the redirect is handled — mutation testing shows those two
  // literals are redundant, and they are kept deliberately as the statement of intent.
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
    sub === 'add' ? new Set(['-A', '--all', '-u', '--update']) : new Set(['-a', '--all']);
  let sawPathless = false;

  for (; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t === '--') return false; // everything after `--` is a pathspec by definition
    // The one rule the whole check rests on: any token that is not a flag (and not a flag's
    // consumed value) is a pathspec, and a pathspec means the command stages less than `git status`
    // reports. `.` needs no special case — it lands here, which is why it is excluded.
    if (!t.startsWith('-')) return false;
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
 * Every path in `git status --porcelain` whose file was last modified BEFORE this session began —
 * i.e. every path this session provably did not write.
 *
 * Untracked paths are included now, and the mtime test is what makes that safe. The first pass
 * excluded them because build output and scratch files would have swamped the signal; but ignored
 * files never appear in porcelain at all, and real build output is rewritten constantly so its mtime
 * is recent. What survives the filter is a leftover from before this session existed — which is
 * exactly the case that did the most damage on day one (a foreign session's index, untracked,
 * swept onto main by a `git add -A` that could not be warned about).
 *
 * Reads only. Nothing here touches the working tree.
 */
export function pathsPredatingSession(startedAt: number): string[] {
  let porcelain: string;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return []; // not a repo, git missing, or slow — never warn on a guess
  }
  const out: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue;
    if (line.slice(0, 2) === '!!') continue; // ignored (porcelain omits these unless asked, belt-and-braces)
    // A rename prints `old -> new`; the destination is the path that ends up in the commit.
    const raw = line.slice(3);
    const arrow = raw.indexOf(' -> ');
    const path = (arrow >= 0 ? raw.slice(arrow + 4) : raw).trim().replace(/^"|"$/g, '');
    if (!path || out.includes(path)) continue;
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue; // deleted, or unreadable — no evidence either way, so say nothing
    }
    if (mtime < startedAt) out.push(path);
  }
  return out;
}

/**
 * The advisory. It states a certainty rather than a suspicion, and — deliberately — offers no
 * escape hatch. The first version ended "if you wrote them through a command this gate cannot see,
 * carry on", and that sentence is how a correct warning got waved through: it was true three times
 * running, so it was reached for a fourth time when it did not apply. The predicate now guarantees
 * these paths are not this session's, so there is nothing to excuse them with.
 */
export function stalePathWarning(paths: string[], command: string): string {
  const list = paths.map((p) => `  ${p}`).join('\n');
  return (
    `musterd (ADR 239): \`${command}\` will stage ${paths.length} ` +
    `file${paths.length === 1 ? '' : 's'} last modified before this session began:\n${list}\n` +
    "This session did not write them — they are another session's uncommitted work, or a leftover " +
    'from an earlier one. Staging them takes them over. Stage your own paths explicitly instead.'
  );
}
