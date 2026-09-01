import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Rule 3 across a RENAME, end to end through the real script in a real git repo.
 *
 * THE EVASION (dolly, #1129 review, routed to lane 01M1EWVE68CB9CCGV76WGN61XT rather than smuggled
 * into that PR): rule 3's loop reads `status !== 'M'` and then `before === null → continue`. A plain
 * `git diff --name-status` reports a rename as an unrelated delete plus add, so renaming an ADR and
 * rewriting its `## Decision` in the same diff was never judged at all — the add has no before side
 * to compare against. That holds for the flip window AND for already-accepted ADRs, so the whole of
 * rule 3 came off with one `git mv`.
 *
 * WHY NOT JUST REFUSE ADDED ADRs: a new accepted ADR is the normal authoring flow and the sanctioned
 * remedy the gate's own message prescribes ("write a superseding ADR"). Refusing adds would break
 * the escape hatch. The fix has to tell a rename from a genuinely new file, which is what `-M` is
 * for — so these tests pin both sides: the rename is judged, the true add still passes.
 *
 * Same fixture discipline as flip-window.test.ts and decision-restore.test.ts: a real repo and the
 * real script, because the substance is which side of the diff each check reads.
 */
const scriptsDir = dirname(fileURLToPath(import.meta.url));
let script: string;

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

function gate(base: string): { code: number; out: string } {
  try {
    const out = execFileSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', script, '--base', base],
      { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const adr = (title: string, status: string, decision: string) =>
  [
    `# ${title}`,
    '',
    `- Status: ${status} — 2026-01-01. Authored by fixture`,
    '',
    '## Context',
    '',
    'The surrounding sections are deliberately substantial: a rename is detected by similarity, so a',
    'fixture whose whole body is the Decision would fall below the threshold and be reported as an',
    'unrelated add — passing for the wrong reason and telling us nothing about the rename path.',
    '',
    '## Decision',
    '',
    decision,
    '',
    '## Consequences',
    '',
    'What followed, at enough length that the Decision is a small fraction of the file, matching the',
    'shape of a real ADR in the corpus rather than a stub built to make the test easy.',
    '',
  ].join('\n');

/** Long enough that replacing it drops the pair below `-M`'s default 50% similarity. */
const LONG_DECISION = Array.from(
  { length: 40 },
  (_, i) =>
    `Clause ${i + 1}: a substantive line of the decision, of the length a real ADR carries.`,
).join('\n');

const OLD_PATH = 'docs/decisions/502-a-fixture-decision.md';
const NEW_PATH = 'docs/decisions/503-a-fixture-decision.md';

/**
 * Commit the fixture ADR at `OLD_PATH` with the given status and Decision; return that base.
 *
 * The tests share one repo, so this clears `NEW_PATH` first: a leftover from the previous test would
 * turn the next `renameTo` into a delete-plus-modify, and the test would pass or fail for a reason
 * that has nothing to do with rename tracking.
 */
function baseAt(status: string, decision: string): string {
  rmSync(join(repo, NEW_PATH), { force: true });
  mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(repo, OLD_PATH), adr('502 — a fixture decision', status, decision));
  git('add', '-A');
  git('commit', '-qm', `land ADR 502 as ${status}`);
  return git('rev-parse', 'HEAD');
}

/** Rename the fixture ADR to `NEW_PATH`, writing the given status and Decision, in one commit. */
function renameTo(status: string, decision: string, message: string): void {
  git('rm', '-q', OLD_PATH);
  mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(repo, NEW_PATH), adr('503 — a fixture decision', status, decision));
  git('add', '-A');
  git('commit', '-qm', message);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'adr-rename-'));
  mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'fixture');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  for (const f of ['check-change-adr.ts', 'adr-status.ts', 'adr-sections.ts']) {
    copyFileSync(join(scriptsDir, f), join(repo, 'scripts', f));
  }
  script = join(repo, 'scripts', 'check-change-adr.ts');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('rule 3 follows a rename — a `git mv` does not lift the freeze', () => {
  it('FAILS a rename that rewrites an accepted Decision in the same diff (the evasion, closed)', () => {
    const base = baseAt('accepted', 'THE DECISION AS ACCEPTED AND REVIEWED.');
    renameTo(
      'accepted',
      'A DIFFERENT DECISION SMUGGLED IN BEHIND THE RENAME.',
      'renumber 502 to 503 and rewrite the decision',
    );

    const r = gate(base);
    expect(r.code).toBe(1);
    expect(r.out).toContain('was edited');
  });

  it('FAILS a rename that also flips proposed to accepted and rewrites the Decision', () => {
    const base = baseAt('proposed', 'THE DRAFT DECISION THAT WAS REVIEWED.');
    renameTo(
      'accepted',
      'A DIFFERENT DECISION NOBODY REVIEWED.',
      'renumber 502 to 503, flip to accepted, rewrite the decision',
    );

    const r = gate(base);
    expect(r.code).toBe(1);
    expect(r.out).toContain('flipped the ADR to accepted');
  });

  it('PASSES a pure rename of an accepted ADR — renumbering is legitimate', () => {
    const base = baseAt('accepted', 'THE DECISION AS ACCEPTED AND REVIEWED.');
    renameTo('accepted', 'THE DECISION AS ACCEPTED AND REVIEWED.', 'renumber 502 to 503');

    const r = gate(base);
    expect(r.code).toBe(0);
  });

  it('PASSES a rename carrying a dated amendment marker — the #1117 escape survives the rename', () => {
    const base = baseAt('accepted', 'The default is `0`.');
    renameTo(
      'accepted',
      'The default is `0`. _(Amended 2026-01-02: the default is `1`. See the amendment below.)_',
      'renumber 502 to 503 with the correction as a dated marker',
    );

    const r = gate(base);
    expect(r.code).toBe(0);
  });

  // `-M` pairs files by SIMILARITY, so it is defeated by rewriting enough of the file: gut a long
  // Decision and the pair drops under the 50% default, git reports an unrelated delete plus add, and
  // the freeze is off again. Measured on the real corpus while building this (2026-09-01): renaming
  // `106-unified-git-workflow.md` and replacing its 78-line Decision scored R040 — below threshold,
  // so a similarity-only fix passed the evasion it was written to stop. Renumbering keeps the slug,
  // so the slug is the key that does not move with the content.
  it('FAILS a rename that rewrites enough of the file to fall below the similarity threshold', () => {
    const base = baseAt('accepted', LONG_DECISION);
    renameTo('accepted', 'GUTTED.', 'renumber 502 to 503 and gut the decision');

    expect(
      git('diff', '--name-status', '-M', `${base}...HEAD`).startsWith('R'),
      'fixture must actually fall below the -M threshold, else this tests nothing',
    ).toBe(false);

    const r = gate(base);
    expect(r.code).toBe(1);
    expect(r.out).toContain('was edited');
    // git's own "fatal: path ... does not exist" from the probing reads must not reach the operator:
    // printed immediately above a refusal it reads as a crash, not a verdict.
    expect(r.out).not.toContain('fatal:');
  });

  // The #739 restoration escape has to survive the rename too, and it reads the file's history by
  // path. Ask `git log` about the NEW path and there is no history at the base — so a legitimate
  // restore-and-renumber would be refused with "was edited", the false positive `wasEverOnMain`
  // exists to prevent.
  it('PASSES restoring a Decision the file previously held while also renaming it', () => {
    rmSync(join(repo, NEW_PATH), { force: true });
    mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
    writeFileSync(
      join(repo, OLD_PATH),
      adr('502 — a fixture decision', 'accepted', 'THE ORIGINAL DECISION.'),
    );
    git('add', '-A');
    git('commit', '-qm', 'land ADR 502 as accepted');
    // The edit that slipped through while the status regex was blind.
    writeFileSync(
      join(repo, OLD_PATH),
      adr('502 — a fixture decision', 'accepted', 'AN EDIT THAT SLIPPED THROUGH.'),
    );
    git('add', '-A');
    git('commit', '-qm', 'an unreviewed edit from the blind years');
    const base = git('rev-parse', 'HEAD');

    renameTo('accepted', 'THE ORIGINAL DECISION.', 'restore the decision and renumber 502 to 503');

    const r = gate(base);
    expect(r.code).toBe(0);
    expect(r.out).toContain('previously held');
  });

  it('still PASSES a genuinely new accepted ADR — the superseding-ADR route stays open', () => {
    // `baseAt` also clears NEW_PATH, so the add below is a true add and not a resurrection.
    const base = baseAt('accepted', 'AN UNRELATED DECISION THAT STAYS PUT.');

    writeFileSync(
      join(repo, NEW_PATH),
      adr('503 — a fixture decision', 'accepted', 'A BRAND NEW DECISION, WRITTEN AS A NEW FILE.'),
    );
    git('add', '-A');
    git('commit', '-qm', 'add a new accepted ADR 503');

    const r = gate(base);
    expect(r.code).toBe(0);
  });
});
