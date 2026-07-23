/**
 * Rewrite packaging/homebrew/musterd.rb `version` after an npm publish (ADR 156).
 *
 *   pnpm bump-brew-formula --version 0.3.0
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORMULA = join(ROOT, 'packaging', 'homebrew', 'musterd.rb');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function bumpBrewFormula(raw: string, version: string): string {
  if (!SEMVER.test(version)) {
    throw new Error(`invalid version ${JSON.stringify(version)}`);
  }
  if (!/version\s+"[^"]+"/.test(raw)) {
    throw new Error('formula missing version "…" line');
  }
  return raw.replace(/version\s+"[^"]+"/, `version "${version}"`);
}

export function parseBumpArgs(argv: string[]): string {
  let version: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--version') {
      version = argv[++i];
    } else if (a.startsWith('--version=')) {
      version = a.slice('--version='.length);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!version) throw new Error('Usage: pnpm bump-brew-formula --version X.Y.Z');
  return version;
}

function main(argv: string[]): number {
  try {
    const version = parseBumpArgs(argv);
    const next = bumpBrewFormula(readFileSync(FORMULA, 'utf8'), version);
    writeFileSync(FORMULA, next);
    console.log(`bumped ${FORMULA} → version "${version}"`);
    console.log('Copy to SandRiseStudio/homebrew-musterd Formula/musterd.rb and push.');
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href;

if (isMain) process.exit(main(process.argv.slice(2)));
