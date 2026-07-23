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
  /** Target version for all public packages. Default 0.3.0. */
  version: string;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseReleaseArgs(argv: string[]): ReleaseArgs {
  let dryRun = false;
  let allowDirty = false;
  let version = '0.3.0';
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
  if (!SEMVER.test(version)) {
    throw new Error(`invalid --version ${JSON.stringify(version)} (want X.Y.Z)`);
  }
  return { dryRun, allowDirty, version };
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
    `smoke: npm i -g @musterd/cli@${version} && musterd --version`,
    `smoke: brew tap SandRiseStudio/musterd && brew install musterd`,
  ];
}
