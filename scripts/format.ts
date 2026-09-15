/*
 * Run Prettier over the one governed scope (ADR 284).
 *
 *   node scripts/format.ts --write   (pnpm format)
 *   node scripts/format.ts --check   (pnpm format:check)
 *
 * A four-line shell-out that exists for one reason: it makes both scripts read the SAME list from
 * `./format-scope.ts`. Two globs in two package.json scripts is what let the writer outgrow the
 * checker by 207 files — see that file's header for the incident.
 */
import { spawnSync } from 'node:child_process';
import { FORMAT_GLOBS } from './format-scope.ts';

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') {
  console.error('usage: node scripts/format.ts --write|--check');
  process.exit(2);
}

// `prettier` resolves from node_modules/.bin via the package manager's PATH; `shell: true` on
// win32 for the .cmd shim.
const r = spawnSync('prettier', [mode, ...FORMAT_GLOBS], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
process.exit(r.status ?? 1);
