import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Rule 3's restoration escape, end to end through the real script in a real git repo.
 *
 * WHY A REAL REPO AND NOT A UNIT TEST. The escape's whole substance is *which git revisions it
 * consults*, and the bug it nearly shipped with was exactly that: `git log` defaults to HEAD, which
 * on a PR branch includes the PR's own commits — so text the change itself introduced counted as
 * "previously held" and rule 3 passed EVERYTHING. Measured before the fix: replaying a genuine
 * Decision rewrite exited 0. A test that mocked git would have been written from the same wrong
 * mental model as the code and would have agreed with it.
 *
 * So both directions are asserted against real commits:
 *   - a genuine Decision rewrite must FAIL (or the gate is off)
 *   - restoring a Decision to a form the file previously held must PASS (or remediation is impossible)
 */
const scriptsDir = dirname(fileURLToPath(import.meta.url));
/** The gate resolves its repo root from its OWN location (`<script>/..`), not from cwd — so the
 *  fixture gets a real copy of the scripts and runs that, keeping the code under test the real one. */
let script: string;

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

/** Run the gate inside the fixture repo. Returns its exit code and combined output. */
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

const adr = (decision: string) =>
  [
    '# 500 — a fixture decision',
    '',
    // Annotated status: the shape that was unprotected before #739, so this fixture also keeps
    // that fix honest rather than testing the easy `- Status: accepted` form.
    '- Status: accepted — implemented 2026-01-01',
    '',
    '## Context',
    '',
    'why',
    '',
    '## Decision',
    '',
    decision,
    '',
    '## Consequences',
    '',
    'what followed',
    '',
  ].join('\n');

const ADR_PATH = 'docs/decisions/500-a-fixture-decision.md';

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'adr-restore-'));
  mkdirSync(join(repo, 'docs', 'decisions'), { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'fixture');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  for (const f of ['check-change-adr.ts', 'adr-status.ts', 'adr-sections.ts']) {
    copyFileSync(join(scriptsDir, f), join(repo, 'scripts', f));
  }
  script = join(repo, 'scripts', 'check-change-adr.ts');
  writeFileSync(join(repo, ADR_PATH), adr('THE ORIGINAL DECISION.'));
  git('add', '-A');
  git('commit', '-qm', 'accept ADR 500');
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('rule 3 — a rewrite fails, a restoration passes', () => {
  it('FAILS a genuine Decision rewrite (text that never existed before)', () => {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, ADR_PATH), adr('THE ORIGINAL DECISION.\n\nAND A LATER AMENDMENT.'));
    git('add', '-A');
    git('commit', '-qm', 'amend the decision in place');

    const r = gate(base);
    expect(r.code).toBe(1);
    expect(r.out).toContain('the `## Decision` of an accepted ADR was edited');
  });

  // The deadlock #739 created: main now HOLDS the violating text, so removing it is a Decision edit.
  it('PASSES a restoration to a form the file previously held', () => {
    const base = git('rev-parse', 'HEAD'); // main, carrying the violating amendment
    writeFileSync(join(repo, ADR_PATH), adr('THE ORIGINAL DECISION.'));
    git('add', '-A');
    git('commit', '-qm', 'restore the decision, move the note to Consequences');

    const r = gate(base);
    expect(r.code).toBe(0);
    expect(r.out).toContain('restored to a form this file previously held');
  });

  // THE NEAR-MISS, pinned. Walking from HEAD instead of `base` makes the change's own commit part of
  // the history it appeals to, so every rewrite looks like a restoration and rule 3 passes
  // everything. This asserts a rewrite STILL fails when the branch has commits after the base —
  // the exact shape that hid the bug.
  it('FAILS a rewrite even when the branch carries several commits past the base', () => {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, ADR_PATH), adr('THE ORIGINAL DECISION.\n\nA BRAND NEW REWRITE.'));
    git('add', '-A');
    git('commit', '-qm', 'rewrite the decision');
    writeFileSync(join(repo, 'unrelated.txt'), 'noise');
    git('add', '-A');
    git('commit', '-qm', 'unrelated follow-up commit on the same branch');

    const r = gate(base);
    expect(r.code).toBe(1);
    expect(r.out).toContain('the `## Decision` of an accepted ADR was edited');
  });
});
