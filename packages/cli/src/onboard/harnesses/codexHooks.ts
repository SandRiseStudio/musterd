import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
] as const;

/** Where this harness's project-local hooks live — exported so callers never re-derive the path. */
export function codexHooksPath(root: string): string {
  return join(root, '.codex', 'hooks.json');
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

function requiredGroup(command: string): z.infer<typeof GroupSchema> {
  return {
    hooks: [
      { type: 'command', command: `musterd codex-hook ${command} --stdin # ${CODEX_HOOK_MARKER}` },
    ],
  };
}

function healthy(file: HooksFile): boolean {
  return REQUIRED.every(([event, command]) =>
    (file.hooks?.[event] ?? []).some((group) =>
      group.hooks.some(
        (handler) =>
          owned(handler.command) &&
          typeof handler.command === 'string' &&
          handler.command.includes(`codex-hook ${command} --stdin`) &&
          handler.type === 'command',
      ),
    ),
  );
}

/** Install only marker-owned handlers; all non-musterd hook groups remain intact. */
export function installCodexHooks(root: string): string[] {
  const path = pathFor(root);
  const exists = existsSync(path);
  const file = exists ? read(path) : {};
  if (!file || healthy(file)) return [];

  const hooks = { ...(file.hooks ?? {}) };
  for (const [event, command] of REQUIRED) {
    if (
      (hooks[event] ?? []).some((group) =>
        group.hooks.some(
          (handler) =>
            owned(handler.command) &&
            typeof handler.command === 'string' &&
            handler.command.includes(`codex-hook ${command} --stdin`),
        ),
      )
    ) {
      continue;
    }
    hooks[event] = [...(hooks[event] ?? []), requiredGroup(command)];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...file, hooks }, null, 2) + '\n', 'utf8');
  return [path];
}

/** Reverse only marker-owned additions; never remove user-defined handlers or groups. */
export function removeCodexHooks(root: string): string[] {
  const path = pathFor(root);
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
  writeFileSync(
    path,
    JSON.stringify({ ...file, ...(Object.keys(hooks).length ? { hooks } : {}) }, null, 2) + '\n',
    'utf8',
  );
  return [path];
}

/** Read-only doctor state: malformed files are never repaired implicitly. */
export function inspectCodexHookDrift(root: string): string[] {
  const path = pathFor(root);
  if (!existsSync(path))
    return ['the project-local Codex hooks are missing from .codex/hooks.json'];
  const file = read(path);
  if (!file) return ['.codex/hooks.json is malformed; musterd left it untouched'];
  return healthy(file)
    ? []
    : ['the required musterd Codex hooks are missing or differ from the supported configuration'];
}
