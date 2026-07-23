/**
 * Rewrite packaging/homebrew/musterd.rb version + sha256 after an npm publish (ADR 156).
 *
 *   pnpm bump-brew-formula --version 0.3.1
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORMULA = join(ROOT, 'packaging', 'homebrew', 'musterd.rb');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function tarballUrl(version: string): string {
  return `https://registry.npmjs.org/@musterd/cli/-/cli-${version}.tgz`;
}

export async function fetchSha256(version: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(tarballUrl(version));
  if (!res.ok) throw new Error(`failed to fetch ${tarballUrl(version)}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return createHash('sha256').update(buf).digest('hex');
}

export function bumpBrewFormula(raw: string, version: string, sha256: string): string {
  if (!SEMVER.test(version)) {
    throw new Error(`invalid version ${JSON.stringify(version)}`);
  }
  if (!/url\s+"[^"]+"/.test(raw) || !/sha256\s+"[^"]+"/.test(raw)) {
    throw new Error('formula missing url/sha256 lines');
  }
  return raw
    .replace(/url\s+"[^"]+"/, `url "${tarballUrl(version)}"`)
    .replace(/sha256\s+"[^"]+"/, `sha256 "${sha256}"`);
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

async function main(argv: string[]): Promise<number> {
  try {
    const version = parseBumpArgs(argv);
    const sha256 = await fetchSha256(version);
    const next = bumpBrewFormula(readFileSync(FORMULA, 'utf8'), version, sha256);
    writeFileSync(FORMULA, next);
    console.log(`bumped ${FORMULA} → ${version} sha256=${sha256}`);
    console.log('Copy to SandRiseStudio/homebrew-musterd Formula/musterd.rb and push.');
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
    return 1;
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href;

if (isMain) process.exit(await main(process.argv.slice(2)));
