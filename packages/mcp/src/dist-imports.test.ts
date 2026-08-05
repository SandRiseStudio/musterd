import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The published runtime graph may only touch declared `dependencies`.
 *
 * This exists because 0.4.0 shipped unloadable. `index.ts` re-exported `measureToolSurface`, whose
 * module imports `@modelcontextprotocol/client` — a devDependency — so every consumer hit
 * `ERR_MODULE_NOT_FOUND` on import, while the workspace stayed green because a pnpm install has the
 * dev deps present. Nothing in the unit suite, the typecheck or `npm pack` can see that: the defect
 * is only visible from *outside* the workspace, which is exactly where we never looked.
 *
 * So this walks the real graph from the bin entry and asserts every bare specifier it can reach is
 * something a consumer will actually be given. It is a cheap standing check for a class of bug whose
 * only other detector is a user reporting that the package does not import.
 */
const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every module specifier a file imports, bare and relative alike.
 *
 * Anchored at statement start and forbidden from crossing a quote (`[^'"]*?`) on purpose: a loose
 * `/from ['"]/` also matches prose inside a runtime string — `'…status is derived from ' + x` in
 * `tools/goals.js` was the first thing this caught, and a guard that cries wolf gets muted.
 */
function importsOf(js: string): string[] {
  const out: string[] = [];
  const patterns = [
    /^\s*(?:import|export)[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm, // import/export … from '…'
    /^\s*import\s*['"]([^'"]+)['"]/gm, // side-effect import '…'
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('…')
  ];
  for (const re of patterns) for (const m of js.matchAll(re)) out.push(m[1]!);
  return out;
}

/** Bare specifiers only — relative paths resolve inside the tarball, builtins always exist. */
function bareImportsOf(js: string): string[] {
  return importsOf(js).filter((s) => !s.startsWith('.') && !s.startsWith('/'));
}

/** The package a bare specifier belongs to: `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function packageOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/** Every `.js` under a dist dir, recursively. */
function distFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...distFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

describe('the published runtime graph', () => {
  const dist = join(PKG_DIR, 'dist');
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    files?: string[];
  };
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));
  const devOnly = new Set(Object.keys(pkg.devDependencies ?? {}).filter((d) => !declared.has(d)));

  it('imports nothing undeclared anywhere in the tarball', () => {
    // Needs a build. Skipping silently would make this guard a no-op exactly when it matters, so it
    // fails loudly instead — `pnpm gates` builds before it tests.
    expect(existsSync(dist), 'dist/ missing — build before running this guard').toBe(true);

    // Undeclared is always wrong: nothing declares it, so no install of any shape resolves it.
    // dev-only is judged separately, by reachability — see the next test for why that split is real.
    const offenders: string[] = [];
    for (const file of distFiles(dist)) {
      for (const spec of bareImportsOf(readFileSync(file, 'utf8'))) {
        const owner = packageOf(spec);
        if (isBuiltin(spec) || isBuiltin(owner)) continue;
        if (!declared.has(owner) && !devOnly.has(owner)) {
          offenders.push(`${file.slice(PKG_DIR.length + 1)} → ${spec}`);
        }
      }
    }
    expect(offenders, `declared in no dependency list:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });

  it('loads the bin entry without reaching a devDependency', () => {
    // THE guard — the exact thing 0.4.0 got wrong. Reachability from the entry is the property that
    // matters, not mere presence in the tarball: `surfaceMeasure.js` legitimately ships (the
    // standing-context budget gate imports it straight out of `dist`) and legitimately pulls a dev
    // dep, and that is harmless precisely as long as nothing the entry loads touches it.
    const entry = join(dist, 'index.js');
    expect(existsSync(entry)).toBe(true);

    const seen = new Set<string>();
    const queue = [entry];
    const reachedDev: string[] = [];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const spec of importsOf(src)) {
        if (!spec.startsWith('.')) continue;
        const rel = resolve(dirname(file), spec);
        if (existsSync(rel)) queue.push(rel);
      }
      for (const spec of bareImportsOf(src)) {
        if (devOnly.has(packageOf(spec)))
          reachedDev.push(`${file.slice(PKG_DIR.length + 1)} → ${spec}`);
      }
    }
    expect(
      reachedDev,
      `dist/index.js reaches dev-only packages:\n  ${reachedDev.join('\n  ')}`,
    ).toEqual([]);
  });
});
