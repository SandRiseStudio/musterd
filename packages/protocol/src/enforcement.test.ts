import { describe, expect, it } from 'vitest';
import { PolicySchema } from './credentials.js';
import {
  EnforcementPolicySchema,
  gateFingerprint,
  globToRegExp,
  matchEnforcement,
  normalizeCommand,
} from './enforcement.js';

describe('EnforcementPolicySchema (ADR 150) — the opt-in class table', () => {
  it('parse({}) is the off posture: an empty class table', () => {
    expect(EnforcementPolicySchema.parse({})).toEqual({ classes: [] });
  });

  it('a class defaults posture to warn (ADR 083 default)', () => {
    const p = EnforcementPolicySchema.parse({
      classes: [{ class: 'merge-to-main', kind: 'costly-action', match: ['gh pr merge*'] }],
    });
    expect(p.classes[0]!.posture).toBe('warn');
  });

  it('rejects a class with no matcher (an unmatchable class is a footgun)', () => {
    expect(
      EnforcementPolicySchema.safeParse({
        classes: [{ class: 'x', kind: 'costly-action', match: [] }],
      }).success,
    ).toBe(false);
  });

  it('team PolicySchema carries an empty enforcement table without breaking older stored policies', () => {
    // A pre-ADR-150 stored policy has no `enforcement` key — parse fills the empty default.
    const p = PolicySchema.parse({ allow_pre_issued_grants: true });
    expect(p.enforcement).toEqual({ classes: [] });
  });
});

describe('normalizeCommand', () => {
  it('takes the first line, collapses whitespace', () => {
    expect(normalizeCommand('gh  pr   merge 320\n--squash')).toBe('gh pr merge 320');
    expect(normalizeCommand('  git push --force  ')).toBe('git push --force');
  });

  it('lifts leading env-assignments (identity-neutral) but leaves a command word alone', () => {
    expect(normalizeCommand('GIT_TRACE=1 git merge lane-branch')).toBe('git merge lane-branch');
    expect(normalizeCommand('A=1 B=2 git push --force')).toBe('git push --force');
    expect(normalizeCommand('make FOO=bar')).toBe('make FOO=bar'); // arg to make, not a prefix
  });

  it('lifts git pre-subcommand global options so the sibling-worktree form canonicalizes (ADR 153)', () => {
    expect(normalizeCommand('git -C ../main merge lane-branch')).toBe('git merge lane-branch');
    expect(normalizeCommand('git -c user.name=x merge lane-branch')).toBe('git merge lane-branch');
    expect(normalizeCommand('git --git-dir=/repo/.git --work-tree /repo merge x')).toBe(
      'git merge x',
    );
    expect(normalizeCommand('git -C ../main -c core.pager=cat push --force')).toBe(
      'git push --force',
    );
  });

  it('never touches a subcommand-owned flag (git grammar: globals precede the subcommand)', () => {
    // `-C` here is `git commit`'s reuse-message flag, not the global directory option.
    expect(normalizeCommand('git commit -C HEAD')).toBe('git commit -C HEAD');
    // An unrecognized pre-subcommand token stops the scan — we never over-strip.
    expect(normalizeCommand('git --frobnicate merge x')).toBe('git --frobnicate merge x');
  });

  it('composes env-prefix + git globals in one pass', () => {
    expect(normalizeCommand('GIT_TRACE=1 git -C ../main merge lane-branch')).toBe(
      'git merge lane-branch',
    );
  });
});

describe('globToRegExp — path vs command flavor', () => {
  it('path flavor: * stops at a slash, ** crosses depth', () => {
    expect(globToRegExp('src/*.ts', 'path').test('src/tariff.ts')).toBe(true);
    expect(globToRegExp('src/*.ts', 'path').test('src/nested/tariff.ts')).toBe(false);
    expect(globToRegExp('src/**', 'path').test('src/nested/tariff.ts')).toBe(true);
    expect(globToRegExp('**/config.ts', 'path').test('packages/server/config.ts')).toBe(true);
  });

  it('command flavor: * crosses a slash so a branch path does not stop the wildcard', () => {
    expect(
      globToRegExp('git push --force*', 'command').test('git push --force origin feat/x'),
    ).toBe(true);
    expect(globToRegExp('gh pr merge*', 'command').test('gh pr merge 320 --squash')).toBe(true);
    expect(globToRegExp('git push --force*', 'command').test('git status')).toBe(false);
  });
});

describe('matchEnforcement (ADR 150) — declaration-order, tool-driven flavor, undeclared passes', () => {
  const policy = EnforcementPolicySchema.parse({
    classes: [
      {
        class: 'src/tariff.ts',
        kind: 'contended-surface',
        match: ['src/tariff.ts'],
        posture: 'block',
      },
      { class: 'merge-to-main', kind: 'costly-action', match: ['gh pr merge*'], posture: 'block' },
      { class: 'force-push', kind: 'costly-action', match: ['git push --force*'] },
    ],
  });

  it('returns null for an undeclared call — the load-bearing default', () => {
    expect(matchEnforcement(policy, { tool: 'Edit', path: 'src/other.ts' })).toBeNull();
    expect(matchEnforcement(policy, { tool: 'Bash', command: 'ls -la' })).toBeNull();
    expect(matchEnforcement(policy, { tool: 'Read', path: 'src/tariff.ts' })).not.toBeNull(); // path-shaped still matches
  });

  it('an Edit matches a contended-surface class by path; carries its kind for Gate A dispatch', () => {
    const m = matchEnforcement(policy, { tool: 'Write', path: 'src/tariff.ts' });
    expect(m?.cls.class).toBe('src/tariff.ts');
    expect(m?.cls.kind).toBe('contended-surface');
    expect(m?.target).toBe('src/tariff.ts');
  });

  it('a Bash command matches a costly-action class by normalized command; carries kind for Gate B', () => {
    const m = matchEnforcement(policy, { tool: 'Bash', command: 'gh  pr merge 320 --squash' });
    expect(m?.cls.class).toBe('merge-to-main');
    expect(m?.cls.kind).toBe('costly-action');
    expect(m?.target).toBe('gh pr merge 320 --squash'); // normalized
  });

  it('a command class does not match a real file path (flavor is tool-driven, globs are tool-shaped)', () => {
    // An Edit tests path flavor against every class; a command glob like `gh pr merge*` simply does not
    // resemble a real path, so it never fires on one. (A path literally spelling a command is a
    // harmless pathological corner, not a real edit target.)
    expect(matchEnforcement(policy, { tool: 'Edit', path: 'src/handlers/merge.ts' })).toBeNull();
  });

  it('declaration order wins on overlap', () => {
    const p = EnforcementPolicySchema.parse({
      classes: [
        { class: 'first', kind: 'costly-action', match: ['git push*'] },
        { class: 'second', kind: 'costly-action', match: ['git push --force*'] },
      ],
    });
    expect(matchEnforcement(p, { tool: 'Bash', command: 'git push --force' })?.cls.class).toBe(
      'first',
    );
  });

  it('fingerprint is stable per (class,target) and differs across targets', () => {
    const a = matchEnforcement(policy, { tool: 'Bash', command: 'gh pr merge 320' })!;
    const b = matchEnforcement(policy, { tool: 'Bash', command: 'gh pr merge 999' })!;
    expect(a.fingerprint).toBe(gateFingerprint('merge-to-main', 'gh pr merge 320'));
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('the obvious glob catches the sibling-worktree form the exercise showed slipping through (ADR 153)', () => {
    // A class author writes the obvious `git merge*`; before normalization `git -C ../main merge …`
    // sailed through un-gated (cell-S1 VOID probe). Now it matches, on the plain target string.
    const p = EnforcementPolicySchema.parse({
      classes: [
        { class: 'local-merge', kind: 'costly-action', match: ['git merge*'], posture: 'block' },
      ],
    });
    const plain = matchEnforcement(p, { tool: 'Bash', command: 'git merge lane-branch' });
    const worktree = matchEnforcement(p, {
      tool: 'Bash',
      command: 'git -C ../main merge lane-branch',
    });
    const envPrefixed = matchEnforcement(p, {
      tool: 'Bash',
      command: 'GIT_TRACE=1 git -C ../main merge lane-branch',
    });
    expect(worktree?.cls.class).toBe('local-merge');
    expect(envPrefixed?.cls.class).toBe('local-merge');
    // …and all three converge on ONE fingerprint, so a retry that adds `-C` maps to the same Gate B ask.
    expect(worktree?.target).toBe('git merge lane-branch');
    expect(worktree?.fingerprint).toBe(plain?.fingerprint);
    expect(envPrefixed?.fingerprint).toBe(plain?.fingerprint);
  });
});
