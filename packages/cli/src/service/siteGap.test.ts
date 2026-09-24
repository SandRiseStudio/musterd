import { describe, expect, it } from 'vitest';
import {
  computeSiteGap,
  nextAction,
  siteGapAskBody,
  siteGapLine,
  SITE_PATHS,
  type GitReader,
  type SiteGap,
} from './siteGap.js';

const TIP = 'ac064bb3ad79068118159709677c12e00fc8763d';
const DEPLOYED = 'c432fbb3ad79068118159709677c12e00fc8763d';

function git(commits: string[], known = [DEPLOYED, TIP]): GitReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hasCommit: (ref) => known.includes(ref),
    logRange: (from, to, paths) => {
      calls.push(`${from}..${to} -- ${paths.join(' ')}`);
      return commits;
    },
  };
}

describe('computeSiteGap', () => {
  it('reads current when nothing site-affecting landed since the deployed ref', () => {
    const g = git([]);
    expect(computeSiteGap({ ref: DEPLOYED }, TIP, g)).toEqual({
      status: 'current',
      deployed: DEPLOYED,
      tip: TIP,
      behind: [],
    });
    expect(g.calls).toEqual([`${DEPLOYED}..${TIP} -- ${SITE_PATHS.join(' ')}`]);
  });

  it('lists the site-affecting commits, newest first, when the site is behind', () => {
    const g = git([
      '3076e7a0\tscope the what-is card at both ends',
      '7ae57d44\tdrop the LIVE pill',
    ]);
    const gap = computeSiteGap({ ref: DEPLOYED }, TIP, g);
    expect(gap.status).toBe('behind');
    expect(gap.behind).toEqual([
      { sha: '3076e7a0', subject: 'scope the what-is card at both ends' },
      { sha: '7ae57d44', subject: 'drop the LIVE pill' },
    ]);
  });

  it('cannot measure a site with no marker, and says so instead of guessing', () => {
    expect(computeSiteGap(null, TIP, git([])).status).toBe('no_marker');
    expect(computeSiteGap({ ref: null }, TIP, git([])).status).toBe('no_marker');
  });

  it('strips -dirty before asking git, and keeps it in the report', () => {
    const g = git([], [DEPLOYED, TIP]);
    const gap = computeSiteGap({ ref: `${DEPLOYED}-dirty` }, TIP, g);
    expect(gap.status).toBe('current');
    expect(gap.deployed).toBe(`${DEPLOYED}-dirty`);
    expect(g.calls[0]).toMatch(new RegExp(`^${DEPLOYED}\\.\\.`));
  });

  it('reports a ref the checkout lacks as unknown rather than as current or behind', () => {
    const gap = computeSiteGap({ ref: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, TIP, git([]));
    expect(gap.status).toBe('unknown_ref');
    expect(siteGapLine(gap, 'https://musterd.io')).toMatch(/does not have/);
  });
});

describe('the ask body', () => {
  const behind: SiteGap = {
    status: 'behind',
    deployed: DEPLOYED,
    tip: TIP,
    behind: [{ sha: '7ae57d44', subject: 'drop the LIVE pill' }],
  };
  it('names the gap, the commits, the command and ADR 308, and that it self-resolves', () => {
    const body = siteGapAskBody(behind, 'https://musterd.io');
    expect(body).toContain('c432fbb3 — 1 site-affecting commit(s) behind ac064bb3');
    expect(body).toContain('7ae57d44 drop the LIVE pill');
    expect(body).toContain('deploy:site');
    expect(body).toContain('ADR 308');
    expect(body).toContain('resolves itself');
  });
  it('caps the list so a month of drift is one ask, not a scroll', () => {
    const many = {
      ...behind,
      behind: Array.from({ length: 20 }, (_, i) => ({ sha: `sha${i}`, subject: 's' })),
    };
    expect(siteGapAskBody(many, 'x')).toContain('… and 8 more');
  });
});

describe('nextAction — one open ask per deployed ref', () => {
  const behind: SiteGap = {
    status: 'behind',
    deployed: DEPLOYED,
    tip: TIP,
    behind: [{ sha: 'a', subject: 'b' }],
  };
  const current: SiteGap = { status: 'current', deployed: TIP, tip: TIP, behind: [] };
  const stamp = (deployed: string | null, ask: string | null) => ({
    deployed,
    tip: TIP,
    ask,
    raised_at: 1,
  });

  it('raises once when the site first reads behind', () => {
    expect(nextAction(null, behind)).toBe('raise');
    expect(nextAction(stamp(DEPLOYED, null), behind)).toBe('raise');
  });
  it('does not raise again when main moves but the deployed ref has not', () => {
    expect(nextAction(stamp(DEPLOYED, '01ASK'), { ...behind, tip: 'newer' })).toBe('none');
  });
  it('resolves the open ask when the deployed ref changes — a partial catch-up re-raises on the next tick', () => {
    expect(nextAction(stamp('older', '01ASK'), behind)).toBe('resolve');
  });
  it('resolves when the site catches up, and stays silent when it was never behind', () => {
    expect(nextAction(stamp(DEPLOYED, '01ASK'), current)).toBe('resolve');
    expect(nextAction(null, current)).toBe('none');
    expect(nextAction(stamp(TIP, null), current)).toBe('none');
  });
  it('never raises on a gap it cannot name', () => {
    expect(nextAction(null, { status: 'no_marker', deployed: null, tip: TIP, behind: [] })).toBe(
      'none',
    );
    expect(nextAction(null, { status: 'unknown_ref', deployed: 'x', tip: TIP, behind: [] })).toBe(
      'none',
    );
  });
});
