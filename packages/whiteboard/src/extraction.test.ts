/**
 * The extraction guarantee (ADR 330 decision 1), enforced: this package imports NOTHING from
 * @musterd/*. If this test fails, the package is no longer liftable into its own repository
 * and the ADR's standalone claim has quietly become false.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('extraction guarantee', () => {
  it('no source file imports from @musterd/*', async () => {
    const files = [
      ...(await sourceFiles(join(PKG_ROOT, 'src'))),
      ...(await sourceFiles(join(PKG_ROOT, 'web', 'src'))),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      expect(content, `${file} imports @musterd/*`).not.toMatch(/from ['"]@musterd\//);
    }
  });

  it('package.json declares no @musterd/* dependency', async () => {
    const pkg = JSON.parse(await readFile(join(PKG_ROOT, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string>
    >;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const dep of Object.keys(pkg[section] ?? {})) {
        expect(dep, `${section} contains ${dep}`).not.toMatch(/^@musterd\//);
      }
    }
  });
});
