import { describe, expect, it } from 'vitest';
import { PolicySchema } from './credentials.js';
import {
  EnforcementPolicySchema,
  gateFingerprint,
  globToRegExp,
  isWriteShaped,
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

/**
 * ADR 163 — actor attestation. `isWriteShaped` is the read/write asymmetry in one function: reads must
 * never fire (an `Explore` sweep's hundreds of reads would swamp the ledger), writes must. The Bash arm
 * is an explicitly-incomplete heuristic — these tests pin what it DOES catch and, just as importantly,
 * document a miss it does not, so nobody reads the resulting count as a rate.
 */
describe('isWriteShaped (ADR 163)', () => {
  it('path-shaped write tools are writes', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(isWriteShaped({ tool, path: 'src/x.ts' })).toBe(true);
    }
  });

  it('reads are never writes — the whole read/write asymmetry', () => {
    expect(isWriteShaped({ tool: 'Read', path: 'src/x.ts' })).toBe(false);
    expect(isWriteShaped({ tool: 'Grep' })).toBe(false);
    expect(isWriteShaped({ tool: 'Glob', path: '**/*.ts' })).toBe(false);
    expect(isWriteShaped({ tool: 'Bash', command: 'cat src/x.ts' })).toBe(false);
    expect(isWriteShaped({ tool: 'Bash', command: 'ls -la' })).toBe(false);
    expect(isWriteShaped({ tool: 'Bash', command: 'grep -rn foo src/' })).toBe(false);
  });

  it('catches the obvious Bash write shapes', () => {
    const writes = [
      'echo hi > out.txt',
      'echo hi >> out.txt',
      'echo hi | tee out.txt',
      "sed -i '' s/a/b/ f.ts",
      'rm -rf build',
      'mv a b',
      'cp a b',
      'mkdir -p x',
      'touch f',
      'git commit -m x',
      'git push origin main',
      'pnpm install',
      'patch -p1 < x.diff',
    ];
    for (const command of writes) {
      expect(isWriteShaped({ tool: 'Bash', command }), command).toBe(true);
    }
  });

  it('MISSES writes through indirection — the MEASURED recall gap, not a bug to fix here', () => {
    // Each of these really does write, and produces no row. This is why ADR 163's headline is a LOWER
    // BOUND. The error bar is now measured: recall 21/31 = 68%, 0 false positives, finding 008
    // (`docs/research/008-subagent-write-detector-recall.md`, reproduce with
    // `node scripts/research/adr-163-recall.ts`). If a future change makes one of these pass,
    // RE-RUN THAT HARNESS and update the number rather than deleting the case — the count is cited
    // with the recall figure attached, so a silent improvement makes every prior citation wrong.
    //
    // The misses are structural, in four groups. One representative of each is pinned here; ground
    // truth for all of them was measured by sandbox tree-hash, not asserted.
    const measuredMisses = [
      'python -c \'open("f","w").write("x")\'', // interpreter indirection
      'node build.js', //                          delegation to a build script
      'tar -xf bundle.tar', //                     archive extraction
      'sort seed.txt -o sorted.txt', //            in-place via the tool's own flag, no redirect
    ];
    for (const command of measuredMisses) {
      expect(isWriteShaped({ tool: 'Bash', command }), command).toBe(false);
    }
  });

  it('does NOT miss tee, sed -i or heredocs — ADR 163 originally claimed it did', () => {
    // Finding 008 corrected the ADR: three of the five shapes it named as blind spots are caught.
    // Pinned so the correction cannot silently regress back into the pessimistic claim.
    const caught = [
      'echo hi | tee out.txt',
      "sed -i '' s/a/b/ f.ts",
      'cat > heredoc.txt <<EOF\nhello\nEOF',
      'cat <<EOF > heredoc2.txt\nhello\nEOF',
    ];
    for (const command of caught) {
      expect(isWriteShaped({ tool: 'Bash', command }), command).toBe(true);
    }
  });

  it('never fires on a read by a binary whose writes it does catch — 0/15 false positives', () => {
    // The measured asymmetry that makes the count trustworthy as far as it goes: same tools, no write.
    const reads = [
      "awk '{print}' seed.txt", // vs `awk … > f`, which is caught
      'sort seed.txt', //           vs `sort -o`, which is missed anyway
      'python3 -c \'print(open("seed.txt").read())\'',
      "node -e 'console.log(1)'",
      'git status',
      'git diff',
      'git log --oneline',
    ];
    for (const command of reads) {
      expect(isWriteShaped({ tool: 'Bash', command }), command).toBe(false);
    }
  });

  it('a Bash call with no command is not a write', () => {
    expect(isWriteShaped({ tool: 'Bash' })).toBe(false);
    expect(isWriteShaped({ tool: 'Bash', command: '   ' })).toBe(false);
  });
});
