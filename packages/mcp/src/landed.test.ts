import type { Lane } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { declaresLane, parseLog, reconcileLanded, type GitRun } from './landed.js';

/** One `git log --format=%H%x00%s%x00%b%x1e` record. */
function rec(sha: string, subject: string, body: string): string {
  return `${sha}\0${subject}\0${body}\x1e\n`;
}

function lane(over: Partial<Lane>): Lane {
  return {
    id: '01M2NWVH4GCYHHZ6SEEX83Q9Y9',
    team: 'revive',
    project: 'agents',
    title: 'the lane',
    detail: '',
    kind: null,
    owner_seat: 'miley',
    role: null,
    scope: [],
    depends_on: [],
    branch: null,
    goal_id: null,
    risk: [],
    stakes: 'normal',
    stakes_provenance: 'declared',
    merged: null,
    state: 'claimed',
    created_by: 'miley',
    created_at: 1_789_000_000_000,
    claimed_at: 1_789_000_000_000,
    resolved_at: null,
    updated_at: 1_789_000_000_000,
    ...over,
  } as Lane;
}

/** Scripted git: keyed by subcommand; a string is stdout with code 0, a number is a bare exit code. */
function fake(script: Record<string, string | number | 'reject'>, calls: string[][] = []): GitRun {
  return async (args) => {
    calls.push(args);
    const r = script[args[0]!];
    if (r === 'reject' || r === undefined) throw new Error(`spawn failed: ${args[0]}`);
    if (typeof r === 'number') return { code: r, stdout: '' };
    return { code: 0, stdout: r };
  };
}
const cwd = '/w';

describe('declaresLane — a landing declares its lane; a correction only mentions it', () => {
  const short = '01M2XAXRP3';
  it('accepts the squash-body opener `Lane `id`.` and the subject `(lane id)`', () => {
    expect(
      declaresLane({ subject: 's', body: 'why\n\nLane `01M2XAXRP3`. The mechanism' }, short),
    ).toBe(true);
    expect(declaresLane({ subject: 's', body: 'Lane: 01M2XAXRP38F88KC6TMJJDE7JB' }, short)).toBe(
      true,
    );
    expect(
      declaresLane({ subject: 'inbox honors --limit (lane 01M2XAXRP3) (#1560)', body: '' }, short),
    ).toBe(true);
  });
  it('rejects the mentions the first live probe took for landings (#1568, #1578)', () => {
    expect(
      declaresLane(
        { subject: 's', body: 'Found by ryder, declining lane 01M2XAXRP3 on this' },
        short,
      ),
    ).toBe(false);
    expect(
      declaresLane(
        { subject: 's', body: 'wanderer flagged this while accepting lane `01M2XAXRP3` (#1500' },
        short,
      ),
    ).toBe(false);
    const deep =
      Array(46).fill('x').join('\n') + '\nLane `01M2XAXRP3` is open and unowned for the mechanism';
    expect(declaresLane({ subject: 's', body: deep }, short)).toBe(false);
  });
  it('parseLog splits NUL/RS records', () => {
    expect(parseLog(rec('a', 'b', 'c\nd') + rec('e', 'f', ''))).toEqual([
      { sha: 'a', subject: 'b', body: 'c\nd' },
      { sha: 'e', subject: 'f', body: '' },
    ]);
  });
});

describe('reconcileLanded — a carried lane whose work is already on main', () => {
  it('finds the lane by its SHORT id in a main commit (the #1500 shape)', async () => {
    const calls: string[][] = [];
    const got = await reconcileLanded([lane({})], {
      cwd,
      run: fake(
        {
          fetch: 0,
          log: rec(
            '2f1eae77aaaaaaaa',
            'The ack’s rejection … (#1500)',
            'Fixes the race.\n\nLane `01M2NWVH4G`. Closes the defect',
          ),
        },
        calls,
      ),
    });
    expect(got.get('01M2NWVH4GCYHHZ6SEEX83Q9Y9')?.evidence).toBe(
      'main cites it: 2f1eae77 The ack’s rejection … (#1500)',
    );
    const log = calls.find((c) => c[0] === 'log')!;
    // The full ULID never appears in a squash body — #1500 cites `01M2NWVH4G`.
    expect(log).toContain('--grep=01M2NWVH4G');
    expect(log.some((a) => a.startsWith('--since=2026-09-'))).toBe(true);
  });

  it('falls back to a pushed branch that vanished from origin (the #1474 /watch shape)', async () => {
    const got = await reconcileLanded([lane({ branch: 'miley/watch-page' })], {
      cwd,
      run: fake({ fetch: 0, log: '', config: 'refs/heads/miley/watch-page\n', 'ls-remote': '' }),
    });
    expect(got.get('01M2NWVH4GCYHHZ6SEEX83Q9Y9')?.evidence).toContain(
      'branch miley/watch-page was pushed and is gone from origin',
    );
  });

  it('says nothing for a branch that still exists on origin', async () => {
    const got = await reconcileLanded([lane({ branch: 'miley/wip' })], {
      cwd,
      run: fake({
        fetch: 0,
        log: '',
        config: 'refs/heads/miley/wip\n',
        'ls-remote': 'abc\trefs/heads/miley/wip\n',
      }),
    });
    expect(got.size).toBe(0);
  });

  it('says nothing for a branch that was never pushed — absence from origin is not a merge', async () => {
    const got = await reconcileLanded([lane({ branch: 'miley/local-only' })], {
      cwd,
      run: fake({ fetch: 0, log: '', config: 1, 'ls-remote': '' }),
    });
    expect(got.size).toBe(0);
  });

  it('says nothing for a branch whose upstream is origin/main — `checkout -b x origin/main` is not a push', async () => {
    const got = await reconcileLanded([lane({ branch: 'fix/unpushed' })], {
      cwd,
      run: fake({ fetch: 0, log: '', config: 'refs/heads/main\n', 'ls-remote': '' }),
    });
    expect(got.size).toBe(0);
  });

  it('takes the OLDEST declaration when a later commit mentions the lane too', async () => {
    const got = await reconcileLanded([lane({})], {
      cwd,
      run: fake({
        fetch: 0,
        log:
          rec(
            '3f89f741bbbbbbbb',
            'A present-tense claim outlived the fix (#1578)',
            'wanderer flagged this while accepting lane `01M2NWVH4G`',
          ) +
          rec(
            '2f1eae77aaaaaaaa',
            'The ack’s rejection (#1500)',
            'x\n\nLane `01M2NWVH4G`. Closes it',
          ),
      }),
    });
    expect(got.get('01M2NWVH4GCYHHZ6SEEX83Q9Y9')?.evidence).toBe(
      'main cites it: 2f1eae77 The ack’s rejection (#1500)',
    );
  });

  it('skips a lane the seat already attested (merged.sha set) — nothing left to reconcile', async () => {
    const calls: string[][] = [];
    const got = await reconcileLanded([lane({ merged: { sha: 'abc1234', pr: 1 } })], {
      cwd,
      run: fake({ fetch: 0, log: rec('abc1234', 'landed (#1)', 'Lane `01M2NWVH4G`.') }, calls),
    });
    expect(got.size).toBe(0);
    expect(calls.filter((c) => c[0] === 'log')).toHaveLength(0);
  });

  it('never throws: no git at all yields the brief unchanged', async () => {
    const got = await reconcileLanded([lane({ branch: 'x' })], {
      cwd,
      run: fake({ fetch: 'reject', log: 'reject', config: 'reject' }),
    });
    expect(got.size).toBe(0);
  });

  it('makes no git calls for an empty carry', async () => {
    const calls: string[][] = [];
    await reconcileLanded([], { cwd, run: fake({}, calls) });
    expect(calls).toHaveLength(0);
  });
});
