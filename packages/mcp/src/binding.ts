import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
 * The workspace directory this session's identity is anchored to — where {@link saveBinding} must
 * write back a claimed seat, and where an in-session binding repair is re-read from. It is the dir of
 * the `.musterd/` that seeded this config, resolved with the same precedence as {@link findBinding} /
 * {@link findWorkspaceSpec}: an explicit `MUSTERD_BINDING` path (→ its workspace root), else the
 * nearest ancestor holding `.musterd/binding.json`, else the nearest holding `.musterd/workspace.json`.
 *
 * Falls back to `startDir` only when no musterd file exists on the walk-up path. This is the fix for
 * the ambient-cwd clobber (ADR 018): persisting to `process.cwd()` let an adapter whose cwd happened
 * to be a *sibling* worktree overwrite that worktree's binding.json with its own seat. Anchoring to
 * the resolved dir keeps a claim's write inside the workspace it was actually resolved from.
 */
export function resolveBindingDir(
  startDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env['MUSTERD_BINDING'];
  // MUSTERD_BINDING names the binding *file* (<root>/.musterd/binding.json); its workspace root is two
  // levels up. dirname twice is robust to the fixed `.musterd/binding.json` suffix saveBinding writes.
  if (explicit) return dirname(dirname(explicit));
  for (let dir = startDir; ; ) {
    if (existsSync(join(dir, BINDING_DIR, BINDING_FILE))) return dir;
    if (existsSync(join(dir, BINDING_DIR, WORKSPACE_SPEC_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
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
 *
 * Merge-guard on `session` (ADR 131 §5, increment 4): `persistBinding` rebuilds the binding from
 * boot-time config, and on every wake the SessionStart hook writes `binding.session` moments before
 * this adapter's first-tool-call autojoin persists — without the guard, every wake's capture would
 * be clobbered on arrival (the exact ADR 101 model-wipe failure shape). Re-read the on-disk file
 * and carry its `session` through unless the caller explicitly set one. This is NOT the adapter
 * *reading* `binding.session` (the no-boot-race contract): it never consumes the value, it only
 * refuses to destroy another writer's field. Tmp-file + rename keeps the concurrent-hook write
 * untorn (and 0600 from the first byte).
 */
export function saveBinding(dir: string, binding: Binding): string {
  const bindingDir = join(dir, BINDING_DIR);
  mkdirSync(bindingDir, { recursive: true });
  const p = join(bindingDir, BINDING_FILE);
  const onDisk = readBinding(p);
  const merged: Binding =
    binding.session === undefined && onDisk?.session !== undefined
      ? { ...binding, session: onDisk.session }
      : binding;
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort on platforms without chmod semantics
  }
  renameSync(tmp, p);
  return p;
}
