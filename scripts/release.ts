/**
 * Lockstep publish of @musterd/* (ADR 156).
 *
 *   pnpm release --dry-run              # build + pack, no registry write
 *   pnpm release                        # bump → build → npm publish (human credentials)
 *   pnpm release --version 0.3.1        # override target version
 *
 * Publish order: protocol → telemetry → server → mcp → cli.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PACKAGE_DIRS,
  PUBLISH_ORDER,
  bumpPackageJson,
  nextStepsAfterPublish,
  parseReleaseArgs,
  type PublishPackageName,
} from './release/helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function usage(): string {
  return `Usage: pnpm release [--dry-run] [--allow-dirty] [--version X.Y.Z]

Publishes @musterd/* in lockstep (ADR 156). Default version: 0.3.0.
--dry-run builds and npm-packs each package; does not bump or publish.
`;
}

function assertCleanTree(allowDirty: boolean): void {
  if (allowDirty) return;
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  if (status) {
    throw new Error(
      `working tree is dirty — commit or stash first, or pass --allow-dirty\n${status}`,
    );
  }
}

function packageJsonPath(name: PublishPackageName): string {
  return join(ROOT, 'packages', PACKAGE_DIRS[name], 'package.json');
}

function bumpAll(version: string): void {
  for (const name of PUBLISH_ORDER) {
    const path = packageJsonPath(name);
    const next = bumpPackageJson(readFileSync(path, 'utf8'), version);
    writeFileSync(path, next);
    console.log(`bumped ${name} → ${version}`);
  }
}

function buildAll(): void {
  console.log('pnpm -r build…');
  execFileSync('pnpm', ['-r', 'build'], { cwd: ROOT, stdio: 'inherit' });
}

function packOne(name: PublishPackageName): void {
  const dir = join(ROOT, 'packages', PACKAGE_DIRS[name]);
  console.log(`npm pack ${name}…`);
  execFileSync('npm', ['pack', '--dry-run'], { cwd: dir, stdio: 'inherit' });
}

function publishOne(name: PublishPackageName): void {
  const dir = join(ROOT, 'packages', PACKAGE_DIRS[name]);
  if (!existsSync(join(dir, 'dist'))) {
    throw new Error(`${name}: missing dist/ — build first`);
  }
  console.log(`npm publish ${name}…`);
  execFileSync('npm', ['publish', '--access', 'public'], { cwd: dir, stdio: 'inherit' });
}

export function runRelease(argv: string[]): number {
  let args;
  try {
    args = parseReleaseArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'HELP') {
      process.stdout.write(usage());
      return 0;
    }
    process.stderr.write(`${msg}\n${usage()}`);
    return 1;
  }

  try {
    assertCleanTree(args.allowDirty);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
    return 1;
  }

  console.log(
    args.dryRun
      ? `dry-run release @ ${args.version} (order: ${PUBLISH_ORDER.join(' → ')})`
      : `release @ ${args.version} (order: ${PUBLISH_ORDER.join(' → ')})`,
  );

  if (!args.dryRun) {
    bumpAll(args.version);
  } else {
    console.log('(dry-run) skipping version bump');
  }

  buildAll();

  for (const name of PUBLISH_ORDER) {
    if (args.dryRun) packOne(name);
    else publishOne(name);
  }

  if (args.dryRun) {
    console.log('\n✓ dry-run complete — no registry writes');
  } else {
    console.log(`\n✓ published @musterd/*@${args.version}`);
    console.log('\nNext:');
    for (const line of nextStepsAfterPublish(args.version)) {
      console.log(`  ${line}`);
    }
  }
  return 0;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href;

if (isMain) {
  process.exit(runRelease(process.argv.slice(2)));
}
