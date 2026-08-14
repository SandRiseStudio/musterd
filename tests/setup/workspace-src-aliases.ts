/*
 * Vitest resolves @musterd/* workspace imports to SOURCE, never to gitignored dist/.
 *
 * Why this exists: each package's `exports` points at `./dist`, which is gitignored — so switching
 * refs never refreshes it, and vitest happily tests whatever build output happens to be lying
 * around. That is how a stale `packages/protocol/dist` made main look RED on someone else's lane
 * four times in two days (see running-the-gates.md and ADR 267). CI was never exposed (it builds
 * before testing); every incident was a local run testing a tree that no longer existed.
 *
 * Order matters: the subpath regex must come before the bare-name alias, or
 * `@musterd/protocol/project` would be swallowed by the `@musterd/protocol` entry.
 *
 * Deliberately NOT aliased: `@musterd/cli` (nothing imports it by name — it is spawned as a binary
 * from its dist, and those acceptance tests genuinely test the built artifact).
 *
 * tests/workspace-src-alias.test.ts is the falsifier: it fails if any alias here stops resolving
 * to the same module as the source file itself.
 */
import { fileURLToPath } from 'node:url';

const src = (pkg: string, file: string): string =>
  fileURLToPath(new URL(`../../packages/${pkg}/src/${file}`, import.meta.url));

export const workspaceSrcAliases = [
  { find: /^@musterd\/protocol\/(.+)$/, replacement: src('protocol', '$1.ts') },
  { find: /^@musterd\/protocol$/, replacement: src('protocol', 'index.ts') },
  { find: /^@musterd\/server$/, replacement: src('server', 'index.ts') },
  { find: /^@musterd\/mcp$/, replacement: src('mcp', 'index.ts') },
  { find: /^@musterd\/telemetry$/, replacement: src('telemetry', 'index.ts') },
];
