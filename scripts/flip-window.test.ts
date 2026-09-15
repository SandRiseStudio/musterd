import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * Rule 3's flip window, end to end through the real script in a real git repo.
 *
 * THE WINDOW (dolly, #1123 review): rule 3 judges the BEFORE status, because that is what keeps a
 * proposed ADR editable while it is being drafted. The consequence was that the one commit flipping
 * `proposed` → `accepted` could also rewrite the `## Decision` in the same diff and the gate allowed
 * it — so the text that got frozen need never have been the text anyone reviewed. Measured before
 * choosing the rule (lane 01M1D3HJZACT6CC9KQ0QR88AJS): 9 of the corpus's 41 own-file flips edited
 * the Decision in the same commit, and the exemplar (ADR 331 at 5c1b35f0) was a genuine defect fix,
 * not sloppiness — so the rule refuses only a SILENT rewrite and admits a dated amendment marker,
 * the same escape #1117 built for accepted Decisions.
 *
 * Same fixture discipline as decision-restore.test.ts: a real repo, the real script, because the
 * substance is which side of the diff each check reads.
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

const adr = (status: string, decision: string) =>
  [
    '# 501 — a fixture decision',
    '',
    // Annotated, like the corpus's own status lines (#1123's real flip carried review provenance).
    `- Status: ${status} — 2026-01-01. Authored by fixture`,
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

const ADR_PATH = 'docs/decisions/501-a-fixture-decision.md';

/** Reset the fixture ADR to proposed at a fresh base commit and return that base. */
function proposedBase(decision: string): string {
  writeFileSync(join(repo, ADR_PATH), adr('proposed', decision));
  git('add', '-A');
  git('commit', '-qm', 'propose ADR 501');
  return git('rev-parse', 'HEAD');
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'adr-flip-'));
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

describe('rule 3 flip window — the flip commit cannot silently rewrite the Decision', () => {
  it('FAILS a flip whose diff also rewrites the Decision (the window, closed)', () => {
    const base = proposedBase('THE REVIEWED DECISION.');
    writeFileSync(join(repo, ADR_PATH), adr('accepted', 'A DIFFERENT DECISION NOBODY REVIEWED.'));
    git('add', '-A');
    git('commit', '-qm', 'flip to accepted and rewrite the decision');

    const r = gate(base);
    expect(r.code).toBe(1);
    expect(r.out).toContain('flipped the ADR to accepted');
  });

  it('PASSES a Status-only flip (#1123 at 4f411b49 is the real instance)', () => {
    const base = proposedBase('THE REVIEWED DECISION.');
    writeFileSync(join(repo, ADR_PATH), adr('accepted', 'THE REVIEWED DECISION.'));
    git('add', '-A');
    git('commit', '-qm', 'flip to accepted, status line only');

    const r = gate(base);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Decision unchanged');
  });

  it('PASSES a flip carrying a dated amendment marker (the #1117 escape, the ADR 331 shape done right)', () => {
    const base = proposedBase('The default is `0`.');
    writeFileSync(
      join(repo, ADR_PATH),
      adr(
        'accepted',
        'The default is `0`. _(Amended 2026-01-02: the default is `1` — the first draft contradicted its own backfill. See the amendment below.)_',
      ),
    );
    git('add', '-A');
    git('commit', '-qm', 'flip to accepted with the correction as a dated marker');

    const r = gate(base);
    expect(r.code).toBe(0);
  });

  it('FAILS a flip whose correction is a bare parenthetical, not a marker (the ADR 331 shape as it actually happened)', () => {
    const base = proposedBase('The default is `0`.');
    writeFileSync(
      join(repo, ADR_PATH),
      adr('accepted', 'The default is `1`. (Amended at the build increment.)'),
    );
    git('add', '-A');
    git('commit', '-qm', 'flip to accepted with a bare parenthetical correction');

    const r = gate(base);
    expect(r.code).toBe(1);
    expect(r.out).toContain('flipped the ADR to accepted');
  });

  it('FAILS a flip that introduces the Decision section itself — frozen text nobody reviewed', () => {
    // A proposed file with no ## Decision at all.
    writeFileSync(
      join(repo, ADR_PATH),
      [
        '# 501 — a fixture decision',
        '',
        '- Status: proposed',
        '',
        '## Context',
        '',
        'why',
        '',
      ].join('\n'),
    );
    git('add', '-A');
    git('commit', '-qm', 'propose ADR 501 with no decision yet');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, ADR_PATH), adr('accepted', 'A DECISION BORN FROZEN.'));
    git('add', '-A');
    git('commit', '-qm', 'flip to accepted while adding the decision');

    const r = gate(base);
    expect(r.code).toBe(1);
  });

  it('still PASSES ordinary edits to a proposed ADR that stays proposed — drafting is not gated', () => {
    const base = proposedBase('A DRAFT DECISION.');
    writeFileSync(join(repo, ADR_PATH), adr('proposed', 'A REWORKED DRAFT DECISION.'));
    git('add', '-A');
    git('commit', '-qm', 'keep drafting');

    const r = gate(base);
    expect(r.code).toBe(0);
  });

  // The OR is judged on the whole diff: a valid dated marker does not buy cover for a reworded
  // sentence beside it. Pinned one layer down in adr-sections.test.ts already; this pins it
  // through the gate, where the flip branch actually calls it (dolly's note on #1129).
  it('FAILS a flip whose marker rides with a reworded sentence — the marker is not a smuggling lane', () => {
    const base = proposedBase('The default is `0`. The read is atomic.');
    writeFileSync(
      join(repo, ADR_PATH),
      adr(
        'accepted',
        'The default is `0`. _(Amended 2026-01-02: the default is `1`. See the amendment below.)_ The read is one atomic unit.',
      ),
    );
    git('add', '-A');
    git('commit', '-qm', 'flip with a valid marker and a smuggled reword');

    const r = gate(base);
    expect(r.code).toBe(1);
    expect(r.out).toContain('flipped the ADR to accepted');
  });

  // The diff is the unit, not the commit: fixing the Decision in one commit and flipping in the
  // next lands as one refused diff. Deliberate — the gate reads diffs everywhere, and the message
  // names the two sanctioned routes (marker, or separate PR) rather than pretending it can see
  // per-commit review.
  it('FAILS a fix-then-flip split across two commits of the same branch', () => {
    const base = proposedBase('The default is `0`.');
    writeFileSync(join(repo, ADR_PATH), adr('proposed', 'The default is `1`.'));
    git('add', '-A');
    git('commit', '-qm', 'fix the decision while still proposed');
    writeFileSync(join(repo, ADR_PATH), adr('accepted', 'The default is `1`.'));
    git('add', '-A');
    git('commit', '-qm', 'flip to accepted');

    const r = gate(base);
    expect(r.code).toBe(1);
    expect(r.out).toContain('separate PR');
  });
});
