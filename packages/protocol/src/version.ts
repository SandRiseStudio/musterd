import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The protocol version string carried by every envelope and handshake. */
export const PROTOCOL_VERSION = 'musterd/0.3' as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

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
