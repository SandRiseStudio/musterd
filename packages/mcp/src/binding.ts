import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BINDING_DIR,
  BINDING_FILE,
  BindingSchema,
  WORKSPACE_SPEC_FILE,
  WorkspaceSpecSchema,
  type Binding,
  type WorkspaceSpec,
} from '@musterd/protocol';

/**
 * Locate + parse the workspace binding (ADR 018). Shares the `.musterd/binding.json` format and
 * walk-up behavior with the CLI's `findBinding`, so a single file is the source of truth for both
 * surfaces. An explicit `MUSTERD_BINDING` path wins; otherwise walk up from cwd. The schema lives
 * in `@musterd/protocol` so the two readers can't drift on shape.
 */
export function findBinding(
  startDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): Binding | null {
  const explicit = env['MUSTERD_BINDING'];
  if (explicit) return readBinding(explicit);
  let dir = startDir;
  for (;;) {
    const p = join(dir, BINDING_DIR, BINDING_FILE);
    if (existsSync(p)) return readBinding(p);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readBinding(path: string): Binding | null {
  try {
    return BindingSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Locate + parse the committed, secret-free launch spec `.musterd/workspace.json` (ADR: committed
 * launch spec). Walks up like {@link findBinding}. The adapter uses it as a base UNDER the gitignored
 * binding.json and env — so a fresh clone whose only musterd file is the committed spec (plus an
 * env-supplied key) still resolves server/team/surface/claim. Never carries a secret. Mirrors the CLI's
 * `findWorkspaceSpec` (ADR 018 duplicate-reader precedent); the shared schema locks the shape.
 */
export function findWorkspaceSpec(
  startDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): WorkspaceSpec | null {
  const explicit = env['MUSTERD_WORKSPACE_SPEC'];
  if (explicit) return readWorkspaceSpec(explicit);
  let dir = startDir;
  for (;;) {
    const p = join(dir, BINDING_DIR, WORKSPACE_SPEC_FILE);
    if (existsSync(p)) return readWorkspaceSpec(p);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readWorkspaceSpec(path: string): WorkspaceSpec | null {
  try {
    return WorkspaceSpecSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Persist the workspace binding after an in-session claim (ADR 032), so a reconnect / a shelled-out
 * `musterd` resolves to the seat this session just claimed (ADR 018's single source of truth). Holds
 * a token → 0600. Mirrors the CLI's `saveBinding`; the shared `BindingSchema` locks the shape.
 */
export function saveBinding(dir: string, binding: Binding): string {
  const bindingDir = join(dir, BINDING_DIR);
  mkdirSync(bindingDir, { recursive: true });
  const p = join(bindingDir, BINDING_FILE);
  writeFileSync(p, JSON.stringify(binding, null, 2) + '\n', 'utf8');
  try {
    chmodSync(p, 0o600);
  } catch {
    // best-effort on platforms without chmod semantics
  }
  return p;
}
