import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BINDING_DIR, BINDING_FILE, BindingSchema, type Binding } from '@musterd/protocol';

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
