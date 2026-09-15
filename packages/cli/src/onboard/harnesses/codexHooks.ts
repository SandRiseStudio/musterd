import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { FEATURE_EPOCH } from '@musterd/protocol';
import { z } from 'zod';

export const CODEX_HOOK_MARKER = 'musterd-codex-hook:v2';

const HandlerSchema = z.object({ command: z.string().optional() }).passthrough();
const GroupSchema = z.object({ hooks: z.array(HandlerSchema) }).passthrough();
const HooksFileSchema = z
  .object({ hooks: z.record(z.array(GroupSchema)).optional() })
  .passthrough();

type HooksFile = z.infer<typeof HooksFileSchema>;

const REQUIRED = [
  ['SessionStart', 'start'],
  ['SessionEnd', 'end'],
  ['PostToolUse', 'post-tool-use'],
  ['UserPromptSubmit', 'orient-nudge'],
] as const;

type RequiredSubcommand = (typeof REQUIRED)[number][1];

function hookCommandLine(subcommand: RequiredSubcommand): string {
  if (subcommand === 'orient-nudge') {
    return `musterd session orient-nudge # ${CODEX_HOOK_MARKER} e${FEATURE_EPOCH}`;
  }
  return `musterd codex-hook ${subcommand} --stdin # ${CODEX_HOOK_MARKER} e${FEATURE_EPOCH}`;
}

/** Where this harness's project-local hooks live — exported so callers never re-derive the path. */
export function codexHooksPath(root: string): string {
  return join(root, '.codex', 'hooks.json');
}

/**
 * codex-cli resolves `.codex/hooks.json` against the git **common dir**'s root, not the directory
 * it is actually invoked in — confirmed empirically (lane 01M1JBH9CR, measured on seat gptbot,
 * 2026-09-02): a canary hook placed at a worktree's `.codex/hooks.json` never fires, the identical
 * file at the main checkout's `.codex/hooks.json` fires every time, and the `cwd` codex hands the
 * hook is still the worktree path — so a shared file at the common-dir root is both necessary
 * (worktree-local hooks are silently never read) and sufficient (per-worktree identity survives via
 * `cwd`).
 *
 * `undefined` when `worktreeRoot` is not a worktree at all (`.git` is a directory there, or absent):
 * the worktree root IS the common-dir root, so there is nothing extra to write.
 */
export function codexCommonDirRoot(worktreeRoot: string): string | undefined {
  const gitPath = join(worktreeRoot, '.git');
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(gitPath);
  } catch {
    return undefined;
  }
  if (stat.isDirectory()) return undefined;
  let contents: string;
  try {
    contents = readFileSync(gitPath, 'utf8');
  } catch {
    return undefined;
  }
  // `git worktree add` writes exactly one line: "gitdir: <main>/.git/worktrees/<name>".
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
  const gitdir = match?.[1];
  if (!gitdir) return undefined;
  const worktreeGitDir = resolve(worktreeRoot, gitdir);
  const marker = `${sep}.git${sep}worktrees${sep}`;
  const idx = worktreeGitDir.lastIndexOf(marker);
  if (idx === -1) return undefined;
  const root = worktreeGitDir.slice(0, idx);
  return root.length > 0 && root !== worktreeRoot ? root : undefined;
}

const pathFor = codexHooksPath;

function read(path: string): HooksFile | undefined {
  try {
    const result = HooksFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function owned(command: string | undefined): boolean {
  return typeof command === 'string' && command.includes(CODEX_HOOK_MARKER);
}

function requiredGroup(subcommand: RequiredSubcommand): z.infer<typeof GroupSchema> {
  return {
    hooks: [{ type: 'command', command: hookCommandLine(subcommand) }],
  };
}

function markerHandlers(file: HooksFile, event?: string): z.infer<typeof HandlerSchema>[] {
  const groups = event ? (file.hooks?.[event] ?? []) : Object.values(file.hooks ?? {}).flat();
  return groups.flatMap((group) => group.hooks.filter((handler) => owned(handler.command)));
}

/** A newer marker belongs to a newer checkout; this build must never overwrite it. */
export function hasNewerCodexHookEpoch(commands: Iterable<string | undefined>): boolean {
  return Array.from(commands)
    .map((command) => /\se(\d+)(?:\s|$)/.exec(command ?? '')?.[1])
    .flatMap((epoch) => (epoch === undefined ? [] : [Number(epoch)]))
    .some((epoch) => epoch > FEATURE_EPOCH);
}

function healthy(file: HooksFile): boolean {
  return (
    markerHandlers(file).length === REQUIRED.length &&
    REQUIRED.every(([event, subcommand]) => {
      const handlers = markerHandlers(file, event);
      return (
        handlers.length === 1 &&
        handlers[0]?.type === 'command' &&
        handlers[0].command === hookCommandLine(subcommand)
      );
    })
  );
}

/** Install only marker-owned handlers at one path; all non-musterd hook groups remain intact. */
function installCodexHooksAt(path: string): string[] {
  const exists = existsSync(path);
  const file = exists ? read(path) : {};
  if (
    !file ||
    healthy(file) ||
    hasNewerCodexHookEpoch(markerHandlers(file).map((handler) => handler.command))
  ) {
    return [];
  }

  const hooks: Record<string, z.infer<typeof GroupSchema>[]> = {};
  for (const [event, groups] of Object.entries(file.hooks ?? {})) {
    const retained = groups
      .map((group) => ({
        ...group,
        hooks: group.hooks.filter((handler) => !owned(handler.command)),
      }))
      .filter((group) => group.hooks.length > 0);
    if (retained.length > 0) hooks[event] = retained;
  }
  for (const [event, command] of REQUIRED) {
    hooks[event] = [...(hooks[event] ?? []), requiredGroup(command)];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...file, hooks }, null, 2) + '\n', 'utf8');
  return [path];
}

/**
 * Install only marker-owned handlers; all non-musterd hook groups remain intact. Also installs at
 * the git common-dir root when `root` is a worktree (`codexCommonDirRoot`) — codex-cli resolves
 * `.codex/hooks.json` there, not in the worktree it actually runs in (see `codexCommonDirRoot`'s
 * doc comment), so the worktree-only copy this wrote for years was silently never read.
 */
export function installCodexHooks(root: string): string[] {
  const commonRoot = codexCommonDirRoot(root);
  return [
    ...installCodexHooksAt(pathFor(root)),
    ...(commonRoot !== undefined ? installCodexHooksAt(pathFor(commonRoot)) : []),
  ];
}

/** Reverse only marker-owned additions at one path; never remove user-defined handlers or groups. */
function removeCodexHooksAt(path: string): string[] {
  if (!existsSync(path)) return [];
  const file = read(path);
  if (!file) return [];
  const hooks: Record<string, z.infer<typeof GroupSchema>[]> = {};
  let changed = false;
  for (const [event, groups] of Object.entries(file.hooks ?? {})) {
    const retained = groups
      .map((group) => {
        const handlers = group.hooks.filter((handler) => !owned(handler.command));
        changed ||= handlers.length !== group.hooks.length;
        return { ...group, hooks: handlers };
      })
      .filter((group) => group.hooks.length > 0);
    if (retained.length > 0) hooks[event] = retained;
  }
  if (!changed) return [];
  // `{ ...file }` still carries the stale `hooks` key from the read — the conditional spread below
  // only OVERRIDES it when non-empty, so a file that had ONLY marker-owned hooks (nothing retained)
  // silently kept its original hooks untouched. Delete first, then re-add only if non-empty.
  const next: Record<string, unknown> = { ...file };
  delete next['hooks'];
  writeFileSync(
    path,
    JSON.stringify({ ...next, ...(Object.keys(hooks).length ? { hooks } : {}) }, null, 2) + '\n',
    'utf8',
  );
  return [path];
}

/**
 * Reverse only marker-owned additions; never remove user-defined handlers or groups. Deliberately
 * does NOT touch the common-dir copy `installCodexHooks` may have written there — it is shared by
 * every worktree of this checkout, so one seat unprovisioning must not strip hooks the others still
 * need. A common-dir copy with no worktree left needing it is an orphan `musterd init --refresh-hooks`
 * repairs from any surviving worktree, not a leak this function is responsible for.
 */
export function removeCodexHooks(root: string): string[] {
  return removeCodexHooksAt(pathFor(root));
}

/** Read-only doctor state: malformed files are never repaired implicitly. */
export function inspectCodexHookDrift(root: string): string[] {
  const commonRoot = codexCommonDirRoot(root);
  // The common-dir copy is what codex actually reads (see `codexCommonDirRoot`); a worktree whose
  // own file looks healthy but whose common-dir copy is missing or stale is still silently broken,
  // so drift there must surface here too, not just the traditional worktree-local check.
  if (commonRoot !== undefined) {
    const commonPath = pathFor(commonRoot);
    if (!existsSync(commonPath)) {
      return [
        'the project-local Codex hooks are missing from the git common dir (.codex/hooks.json) — ' +
          'codex-cli reads hooks from there for a worktree, not from the worktree itself',
      ];
    }
    const commonFile = read(commonPath);
    if (!commonFile) {
      return ['the common-dir .codex/hooks.json is malformed; musterd left it untouched'];
    }
    if (!healthy(commonFile))
      return [
        driftMessage(commonFile, 'in the git common dir, which is what codex-cli actually reads'),
      ];
  }
  const path = pathFor(root);
  if (!existsSync(path))
    return ['the project-local Codex hooks are missing from .codex/hooks.json'];
  const file = read(path);
  if (!file) return ['.codex/hooks.json is malformed; musterd left it untouched'];
  return healthy(file) ? [] : [driftMessage(file)];
}

function installedEpoch(file: HooksFile): number | undefined {
  const epochs = markerHandlers(file)
    .map((handler) => /\se(\d+)(?:\s|$)/.exec(handler.command ?? '')?.[1])
    .flatMap((epoch) => (epoch === undefined ? [] : [Number(epoch)]));
  return epochs.length > 0 ? Math.max(...epochs) : undefined;
}

function driftMessage(file: HooksFile, location = ''): string {
  const suffix = location ? ` ${location}` : '';
  const epoch = installedEpoch(file);
  if (epoch !== undefined && epoch > FEATURE_EPOCH) {
    return (
      `the installed musterd Codex hook epoch e${epoch} is newer than this checkout's e${FEATURE_EPOCH}${suffix}; ` +
      'this checkout is behind — update it and do not refresh hooks'
    );
  }
  return (
    `the required musterd Codex hooks are missing or differ from the supported configuration e${FEATURE_EPOCH}${suffix}; ` +
    'run musterd init --refresh-hooks to repair marker-owned hooks'
  );
}

/** The desired musterd Codex hook commands, per event — the fragment payload (ADR 282, Task 5). */
export function codexHookCommands(): { event: string; command: string }[] {
  return REQUIRED.map(([event, command]) => ({
    event,
    command: hookCommandLine(command),
  }));
}
