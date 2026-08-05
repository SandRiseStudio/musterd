/**
 * Lockstep npm release helpers for @musterd/* (ADR 156).
 * Pure functions — the CLI driver is scripts/release.ts.
 */
export const PUBLISH_ORDER = [
  '@musterd/protocol',
  '@musterd/telemetry',
  '@musterd/server',
  '@musterd/mcp',
  '@musterd/cli',
] as const;

export type PublishPackageName = (typeof PUBLISH_ORDER)[number];

/** Map npm name → packages/<dir>. */
export const PACKAGE_DIRS: Record<PublishPackageName, string> = {
  '@musterd/protocol': 'protocol',
  '@musterd/telemetry': 'telemetry',
  '@musterd/server': 'server',
  '@musterd/mcp': 'mcp',
  '@musterd/cli': 'cli',
};

export interface ReleaseArgs {
  dryRun: boolean;
  allowDirty: boolean;
  /**
   * Target version for all public packages. **No default, deliberately.**
   *
   * It used to default to `'0.3.0'`, a literal frozen in source — stale from the moment 0.3.0
   * shipped, and wrong in principle whatever number it held: the version is the one irreversible
   * decision in a release (npm never lets a version be replaced), so it belongs to whoever is
   * making it, not to a constant. Undefined on a dry run is fine; `runRelease` demands it before
   * anything is published.
   */
  version?: string;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseReleaseArgs(argv: string[]): ReleaseArgs {
  let dryRun = false;
  let allowDirty = false;
  let version: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') dryRun = true;
    else if (a === '--allow-dirty') allowDirty = true;
    else if (a === '--version') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) throw new Error('--version requires a semver value');
      version = v;
    } else if (a.startsWith('--version=')) {
      version = a.slice('--version='.length);
    } else if (a === '--help' || a === '-h') {
      throw new Error('HELP');
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (version !== undefined && !SEMVER.test(version)) {
    throw new Error(`invalid --version ${JSON.stringify(version)} (want X.Y.Z)`);
  }
  return { dryRun, allowDirty, version };
}

/** The `X.Y.Z` core of a version, prerelease suffix discarded. */
function core(version: string): [number, number, number] {
  const [x, y, z] = version.split('-')[0]!.split('.').map(Number);
  return [x!, y!, z!];
}

/**
 * Refuse a target version that cannot be a real release, offline and before anything publishes.
 *
 * Two mistakes, and npm only protects against one of them:
 *
 * - **Same version** — the "forgot to bump" case. npm does reject it, but only when that package's
 *   turn comes; in a five-package lockstep the earlier ones have already published by then, leaving
 *   a half-released version that cannot be completed OR undone.
 * - **Lower version** — npm accepts this happily, because the number is genuinely unpublished. The
 *   result is `latest` moving BACKWARDS onto older code. Nothing but a local check catches it.
 *
 * Prereleases are compared on their core numbers only. Full semver precedence is a rabbit hole this
 * guard does not need: it exists to catch the slips we actually make, not to reimplement the spec.
 */
export function assertPublishable(target: string, current: string): void {
  if (target === current) {
    throw new Error(
      `--version ${target} is already the version in package.json — bump it, or npm will reject ` +
        `this partway through the lockstep and leave a half-published release`,
    );
  }
  const [tx, ty, tz] = core(target);
  const [cx, cy, cz] = core(current);
  const lower = tx < cx || (tx === cx && (ty < cy || (ty === cy && tz < cz)));
  if (lower) {
    throw new Error(
      `--version ${target} is lower than the current ${current}. npm would accept it and move ` +
        `\`latest\` backwards onto older code — nothing but this check refuses it`,
    );
  }
}

export function bumpPackageJson(raw: string, version: string): string {
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  pkg.version = version;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function nextStepsAfterPublish(version: string): string[] {
  return [
    `git tag v${version} && git push origin v${version}`,
    `pnpm bump-brew-formula --version ${version}   # then push SandRiseStudio/homebrew-musterd`,
    // The npm-install smoke that used to live here now runs BEFORE publishing (release/smoke.ts):
    // as a suggestion it could only ever confirm damage, and 0.4.0 is what that cost. What is left
    // here is the one path the pre-publish gate genuinely cannot exercise — brew resolves a formula
    // and a tap, neither of which exists until the steps above are done.
    `smoke: brew tap SandRiseStudio/musterd && brew install musterd   # after the formula push`,
  ];
}
