import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The build stamp — **Node-only**, and deliberately *not* exported from the package barrel.
 *
 * This reads the filesystem (ADR 135), so it can never be part of `@musterd/protocol`'s main entry: the
 * barrel is imported by the **browser** (`@musterd/web`), and `export * from './version.js'` was enough to
 * drag `node:fs` into the client bundle. Vite externalises node builtins and throws the moment the import
 * binding is touched, so a single value-import of *anything* from protocol took the whole web app down with
 * "Module node:fs has been externalized for browser compatibility".
 *
 * That is exactly what happened: `live/format.ts` switched from a type-only import (erased at compile) to a
 * value import (`resolvePosture`), and the dev server died — while production stayed green, because the
 * bundler tree-shook it. A trap that only fires in dev is worse than one that fires everywhere, so the fix
 * is structural rather than a lint rule: **the node-only surface lives behind its own entry point**, and
 * the barrel stays browser-safe by construction.
 *
 * Node consumers import it explicitly:
 *
 * ```ts
 * import { readBuildStamp } from '@musterd/protocol/build-stamp';
 * ```
 */

/**
 * Read the calling package's own `dist/build.json` stamp — the git SHA its dist was built from
 * (ADR 135; written by `scripts/stamp-build.mjs` as the tail of every package build).
 *
 * Pass **your own** `import.meta.url` — the caller's package root is found by walking up from it to
 * the nearest `package.json`, so it works from any nesting depth and from both `src/` (tests) and
 * `dist/` (runtime). A zero-arg helper would resolve relative to *this* file and report protocol's
 * stamp for every caller — the exact wrong-package bug this signature prevents.
 *
 * Returns `undefined` when the stamp is missing, unreadable, or was written outside a git checkout
 * (`ref: null`) — consumers degrade to silence, never to a guessed ref.
 */
export function readBuildStamp(metaUrl: string): string | undefined {
  try {
    let dir = dirname(fileURLToPath(metaUrl));
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, 'package.json'))) {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, 'dist', 'build.json'), 'utf8'));
        const ref = (parsed as { ref?: unknown }).ref;
        return typeof ref === 'string' && ref.length > 0 ? ref.slice(0, 64) : undefined;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
