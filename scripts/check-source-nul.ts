/*
 * Fail if any tracked TypeScript source under packages/ or scripts/ contains a literal NUL
 * byte (ADR 195). A `\x00` in a `.ts` file makes `file` report `data` and makes grep/ripgrep
 * return silence for the whole file — not an error, just an empty match set — so investigators
 * conclude the symbol is absent. Fixed twice already (enforcement.ts, host/loop.ts); the third
 * instance (toolTelemetry.ts) is why this gate exists.
 *
 *   pnpm source-nul:check
 *
 * Delimiters that need a NUL at runtime must be written as the escape `\u0000` — byte-identical
 * when the TS runs, text on disk.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const ROOTS = [join(repoRoot, 'packages'), join(repoRoot, 'scripts')];

function* walkTs(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walkTs(p);
    else if (st.isFile() && name.endsWith('.ts')) yield p;
  }
}

const hits: string[] = [];
for (const root of ROOTS) {
  for (const file of walkTs(root)) {
    const buf = readFileSync(file);
    if (buf.includes(0)) hits.push(relative(repoRoot, file));
  }
}

if (hits.length > 0) {
  console.error(
    `literal NUL byte in TypeScript source (ADR 195) — write delimiters as \\u0000 so grep/file stay honest:\n` +
      hits.map((h) => `  ${h}`).join('\n'),
  );
  process.exit(1);
}

console.log('✓ no literal NUL in packages/**/*.ts or scripts/**/*.ts');
