import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findLadderBreaks, parseMigrationVersions } from '../scripts/check-migrations.ts';

/**
 * The migration-ladder gate. The invariant it defends is not cosmetic: `runMigrations` walks
 * MIGRATIONS in array order and `continue`s on `m.version <= applied`, so a version that does not
 * step strictly upward is never applied on a fresh database — silently, while `schema_meta` records a
 * plausible number. These cases are about the parser seeing the ladder honestly and the rule catching
 * both shapes of break.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

describe('parseMigrationVersions', () => {
  it('reads version keys in source order, with their line numbers', () => {
    // The multi-line layout the real file uses.
    const src = [
      'export const MIGRATIONS = [',
      '  {',
      '    version: 1,',
      '    up: (db) => {},',
      '  },',
      '  {',
      '    version: 2,',
      '    up: (db) => {},',
      '  },',
      '];',
    ].join('\n');
    expect(parseMigrationVersions(src)).toEqual([
      { version: 1, line: 3 },
      { version: 2, line: 7 },
    ]);
  });

  it('also reads a ONE-LINE entry — a layout the gate must not go blind on', () => {
    // The first draft anchored to line-start only, so an inline entry was invisible: the gate would
    // have kept reporting success while seeing less of the ladder. Missing quietly is the one
    // failure mode a gate may not have.
    const src = ['  { version: 4, up: (db) => {} },', '  { version: 5, up: (db) => {} },'].join(
      '\n',
    );
    expect(parseMigrationVersions(src)).toEqual([
      { version: 4, line: 1 },
      { version: 5, line: 2 },
    ]);
  });

  it('ignores a version mentioned in prose or SQL, not as a key', () => {
    // A gate that miscounts is worse than no gate — it lies about the lie. Only a line whose first
    // non-space token is `version:` is a migration entry.
    const src = [
      '  // bumped from version: 3 in the previous release',
      "  db.exec('INSERT INTO meta VALUES (\\'version: 99\\')');",
      '  const schemaVersion: 7 = 7;',
      '  myversion: 8,',
      '    version: 4,',
    ].join('\n');
    expect(parseMigrationVersions(src)).toEqual([{ version: 4, line: 5 }]);
  });
});

describe('findLadderBreaks', () => {
  const at = (...versions: number[]) => versions.map((version, i) => ({ version, line: i + 1 }));

  it('passes a strictly ascending ladder', () => {
    expect(findLadderBreaks(at(1, 2, 3, 4))).toEqual([]);
  });

  it('passes a ladder with GAPS — a skipped number costs nothing', () => {
    // Deliberate: the runner applies whatever has `version > applied`, so a gap left by a renumbered
    // branch is harmless. Only collisions and downward steps break it.
    expect(findLadderBreaks(at(1, 2, 5, 9))).toEqual([]);
  });

  it('catches a duplicate — the shape that silently drops a migration', () => {
    const breaks = findLadderBreaks(at(1, 2, 2, 3));
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.kind).toBe('duplicate');
    expect(breaks[0]!.offending.version).toBe(2);
    expect(breaks[0]!.previous.line).toBe(2);
  });

  it('catches a downward step, and names it as its own kind', () => {
    // Distinct from a duplicate because the remedy differs: one needs renumbering, the other needs
    // reordering. Two ways to break the ladder, two names (ADR 173 clause 1).
    const breaks = findLadderBreaks(at(1, 5, 3));
    expect(breaks).toHaveLength(1);
    expect(breaks[0]!.kind).toBe('descending');
  });

  it('reports every break, not just the first', () => {
    expect(findLadderBreaks(at(1, 1, 2, 2)).map((b) => b.offending.line)).toEqual([2, 4]);
  });

  it('is empty-safe on a one-entry and a zero-entry ladder', () => {
    expect(findLadderBreaks(at(1))).toEqual([]);
    expect(findLadderBreaks([])).toEqual([]);
  });
});

describe('the gate, end to end against the real tree', () => {
  const run = () =>
    execFileSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', 'scripts/check-migrations.ts'],
      { cwd: repoRoot, encoding: 'utf8' },
    );

  it("passes on this repo's actual migration ladder, and says what it checked", () => {
    // Not merely exit 0: a gate that found nothing must not look identical to a gate that verified
    // something. The line names the count and the range it walked.
    const out = run();
    expect(out).toMatch(/^✓ \d+ migration\(s\), v\d+…v\d+, strictly ascending$/m);
  });
});
