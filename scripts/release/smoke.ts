/**
 * The consumer-install smoke gate for `pnpm release` (ADR 156).
 *
 * **Why this exists, precisely.** 0.4.0 reached the registry unloadable: `@musterd/mcp`'s entry
 * re-exported a module importing `@modelcontextprotocol/client`, a devDependency, so every consumer
 * hit `ERR_MODULE_NOT_FOUND` and `musterd --version` did not run at all. Nothing in the repo could
 * see it — a pnpm workspace *has* the dev deps installed, so tests, typecheck and `npm pack` all
 * pass on a package no user can import. The defect is only observable from OUTSIDE the workspace.
 *
 * A smoke was in fact suggested — printed under "Next:" *after* publishing, where it could only
 * confirm damage. npm versions cannot be replaced, so a post-publish check costs a version number
 * every time it fires. Hence this runs BEFORE the first registry write, and on `--dry-run` too, so
 * a dry run is a genuine pre-flight rather than a packaging rehearsal.
 *
 * The install is deliberately hostile to our conveniences: a clean directory, its own
 * `node_modules`, no workspace linking, and every `@musterd/*` pinned to the local tarball via
 * `overrides` — because the cross-package deps (`@musterd/cli` → `@musterd/mcp@X`) name a version
 * that does not exist on the registry yet, and letting npm reach for it would either fail or,
 * worse, silently resolve the PREVIOUS release and test the wrong code.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_DIRS, PUBLISH_ORDER, type PublishPackageName } from './helpers.ts';

/**
 * What a module-resolution failure looks like, whatever node version prints it.
 *
 * This is the whole failure class the gate exists for: the package loaded in our workspace and
 * cannot load anywhere else. Matching the *symptom* rather than a specific missing package keeps it
 * honest for the next dependency that gets mislabelled.
 */
const RESOLUTION_FAILURE = /ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module/;
/** The phrasings that actually NAME the missing package, as opposed to merely proving one is. */
const NAMES_THE_CULPRIT = /Cannot find (?:package|module)/;

/**
 * The offending line of a program's output, or null when nothing failed to resolve.
 *
 * Returns the most *informative* match, not the first. Node prints its own source line first —
 * `throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);` — which matches the
 * failure pattern while naming nothing; the line worth surfacing is
 * `Cannot find package '@modelcontextprotocol/client' imported from …`, several lines later.
 * Reporting the echo would hand whoever is mid-release a true alarm and no lead.
 */
export function resolutionFailure(output: string): string | null {
  const matches = output.split('\n').filter((l) => RESOLUTION_FAILURE.test(l));
  if (matches.length === 0) return null;
  return (matches.find((l) => NAMES_THE_CULPRIT.test(l)) ?? matches[0]!).trim();
}

/**
 * The throwaway consumer's `package.json`.
 *
 * `dependencies` names only what we actually exercise; `overrides` pins EVERY `@musterd/*` so a
 * transitive edge can never be satisfied from the registry — see the file header for why that
 * would be worse than a hard failure.
 */
export function smokeManifest(tarballs: Record<PublishPackageName, string>): object {
  const overrides = Object.fromEntries(
    PUBLISH_ORDER.map((name) => [name, `file:${tarballs[name]}`]),
  );
  return {
    name: 'musterd-release-smoke',
    version: '0.0.0',
    private: true,
    dependencies: {
      '@musterd/cli': `file:${tarballs['@musterd/cli']}`,
      '@musterd/mcp': `file:${tarballs['@musterd/mcp']}`,
    },
    overrides,
  };
}

/** A program we run against the installed package, and what its output must (not) show. */
export interface SmokeProbe {
  label: string;
  /** Path under the smoke dir's node_modules. */
  entry: string;
  args: string[];
  /** When set, the output must contain this — `musterd --version` must actually print the version. */
  expect?: string;
}

/**
 * The two probes, and why each is the one worth running.
 *
 * `cli --version` is not a token gesture: it is the exact assertion the Homebrew formula's `test do`
 * block makes, so a green here is a green `brew install`. It was also the precise command 0.4.0
 * could not complete.
 *
 * The mcp entry is run for its *loading*, not its exit code — with no binding it correctly refuses
 * with "no team", which is a program that started. Only a resolution failure counts as failure, so
 * the probe stays valid as the adapter's startup behaviour changes.
 */
export function probesFor(version: string): SmokeProbe[] {
  return [
    {
      label: 'musterd --version',
      entry: '@musterd/cli/dist/bin.js',
      args: ['--version'],
      expect: version,
    },
    { label: 'mcp adapter loads', entry: '@musterd/mcp/dist/index.js', args: [] },
  ];
}

export interface SmokeDeps {
  run: (cmd: string, args: string[], cwd: string) => string;
  log: (line: string) => void;
}

const defaultDeps: SmokeDeps = {
  // stdio pipe, not inherit: the probes' output is the assertion, and a failing probe is expected
  // to exit non-zero, so the throw must be caught rather than killing the release.
  run: (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe' }),
  log: (line) => console.log(line),
};

/**
 * Pack every package with **pnpm**, not npm.
 *
 * `pnpm publish` is already mandatory here because raw npm leaves `workspace:*` in the tarball and
 * ships broken installs; the same is true of `npm pack`. Packing with anything but pnpm would smoke
 * a tarball that is not the one we publish, which is the exact class of self-deception this gate is
 * supposed to end.
 */
function packAll(root: string, dest: string, deps: SmokeDeps): Record<PublishPackageName, string> {
  const out = {} as Record<PublishPackageName, string>;
  for (const name of PUBLISH_ORDER) {
    const dir = join(root, 'packages', PACKAGE_DIRS[name]);
    const printed = deps.run('pnpm', ['pack', '--pack-destination', dest], dir).trim();
    const file = printed.split('\n').filter(Boolean).pop()!.trim();
    out[name] = file.startsWith('/') ? file : join(dest, file);
  }
  return out;
}

/**
 * Install the packed tarballs into a clean directory and run the probes.
 *
 * Throws on the first failure — this gates a publish, so it must stop the release rather than warn.
 */
export function smokeConsumerInstall(root: string, deps: SmokeDeps = defaultDeps): void {
  // The version to assert is whatever the packed CLI actually carries — read from disk, never from
  // the caller's `--version`. On `--dry-run` no bump happens, so those two disagree, and trusting
  // the flag made the gate fail a perfectly good dry run on its own bookkeeping.
  const version = (
    JSON.parse(
      readFileSync(join(root, 'packages', PACKAGE_DIRS['@musterd/cli'], 'package.json'), 'utf8'),
    ) as { version: string }
  ).version;
  const work = mkdtempSync(join(tmpdir(), 'musterd-smoke-'));
  try {
    deps.log(`consumer smoke @ ${version} — packing…`);
    const tarballs = packAll(root, work, deps);

    const app = join(work, 'app');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify(smokeManifest(tarballs), null, 2));

    deps.log('consumer smoke — installing into a clean dir (no workspace)…');
    deps.run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], app);

    for (const probe of probesFor(version)) {
      let output: string;
      try {
        output = deps.run(
          process.execPath,
          [join(app, 'node_modules', probe.entry), ...probe.args],
          app,
        );
      } catch (e) {
        // A non-zero exit is fine on its own (the adapter refuses without a binding); what it
        // PRINTED is the evidence, so keep it and judge below.
        const err = e as { stdout?: string; stderr?: string; message?: string };
        output = `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`;
      }
      const failure = resolutionFailure(output);
      if (failure) {
        throw new Error(
          `consumer smoke FAILED — ${probe.label}\n` +
            `  ${failure}\n` +
            `  The package installs but cannot load outside this workspace. This is what shipped as\n` +
            `  0.4.0. Nothing is published yet; fix it and re-run.`,
        );
      }
      if (probe.expect !== undefined && !output.includes(probe.expect)) {
        throw new Error(
          `consumer smoke FAILED — ${probe.label} did not print ${JSON.stringify(probe.expect)}\n` +
            `  got: ${output.trim().slice(0, 200)}`,
        );
      }
      deps.log(`  ✓ ${probe.label}`);
    }
    deps.log('✓ consumer smoke passed — the tarballs load outside the workspace');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
