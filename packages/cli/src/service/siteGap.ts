/**
 * Landed is not live (ADR 308 §Observability, lane 01M2XD2RPG). The public site is published by one
 * seat's standing authorization, outside the merge → accept loop, so a stranger-facing change can be
 * merged, accepted and recorded `done` while musterd.io keeps serving the sentence it removed —
 * measured 2026-09-19 with four homepage strings, every instrument green. This module is the
 * instrument that ADR's Observability section asked for: compare the build marker the site serves
 * (`/build.json`, staged by `stage-site.mjs` from the ADR 135 stamp) against `origin/main` and
 * report the site-affecting commits between them.
 *
 * Pure: every fact (the marker, the tip, git's answer) is injected, so the tick and the human
 * command share one computation and the tests need no network and no repo.
 */

/** The `/build.json` the site serves — the ADR 135 stamp shape. `null` ref = stamped outside git. */
export interface DeployedMarker {
  ref: string | null;
  builtAt?: string;
}

/** A commit in the gap: short sha + subject, in `git log` (newest-first) order. */
export interface GapCommit {
  sha: string;
  subject: string;
}

export type SiteGapStatus =
  /** The deployed ref is the tip, or nothing site-affecting landed since it. */
  | 'current'
  /** Site-affecting commits sit between the deployed ref and the tip. */
  | 'behind'
  /** The site serves no marker (a deploy from before the marker existed) — the gap is unknowable. */
  | 'no_marker'
  /** The marker names a ref this checkout does not have (a `-dirty` deploy, or an unfetched sha). */
  | 'unknown_ref';

export interface SiteGap {
  status: SiteGapStatus;
  /** The ref as the marker gave it (`-dirty` suffix kept: a dirty deploy is a fact worth printing). */
  deployed: string | null;
  tip: string;
  behind: GapCommit[];
}

/**
 * The paths whose commits count as "the site changed". `packages/web` is the whole public artifact
 * — routes, content, the docs manifest and the site-files plugin all live under it — and the
 * daemon-only routes share the same package, so a `/live`-only commit is counted too. That is the
 * conservative side: a false "behind" costs miley one glance at the list; a false "current" is the
 * exact defect this instrument exists to end.
 */
export const SITE_PATHS = ['packages/web'] as const;

export interface GitReader {
  /** Does this ref resolve to a commit in the local object store? */
  hasCommit: (ref: string) => boolean;
  /** `git log --format=%h%x09%s <from>..<to> -- <paths>`, one line per commit, newest first. */
  logRange: (from: string, to: string, paths: readonly string[]) => string[];
}

export function computeSiteGap(
  marker: DeployedMarker | null,
  tip: string,
  git: GitReader,
): SiteGap {
  if (!marker || !marker.ref) return { status: 'no_marker', deployed: null, tip, behind: [] };
  const deployed = marker.ref;
  const sha = deployed.replace(/-dirty$/, '');
  if (!git.hasCommit(sha)) return { status: 'unknown_ref', deployed, tip, behind: [] };
  const behind = git
    .logRange(sha, tip, SITE_PATHS)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const i = l.indexOf('\t');
      return i < 0 ? { sha: l, subject: '' } : { sha: l.slice(0, i), subject: l.slice(i + 1) };
    });
  return { status: behind.length === 0 ? 'current' : 'behind', deployed, tip, behind };
}

const short = (ref: string) => ref.replace(/^([0-9a-f]{8})[0-9a-f]*(-dirty)?$/, '$1$2');

/** One line a human or a log can read; the ask body is built from the same facts. */
export function siteGapLine(g: SiteGap, origin: string): string {
  switch (g.status) {
    case 'current':
      return `${origin} is at ${short(g.deployed!)} — current with ${short(g.tip)} on ${SITE_PATHS.join(', ')}`;
    case 'behind':
      return `${origin} is at ${short(g.deployed!)} — ${g.behind.length} site-affecting commit(s) behind ${short(g.tip)}`;
    case 'no_marker':
      return `${origin} serves no /build.json — deployed from a build before the marker existed; the gap cannot be measured until the next deploy`;
    case 'unknown_ref':
      return `${origin} is at ${short(g.deployed!)}, a ref this checkout does not have — fetch, or a dirty deploy (ADR 135)`;
  }
}

/** The seat ADR 308 names. A constant, not config: the authorization is a person, and the ask says so. */
export const DEPLOY_AUTHORIZED_SEAT = 'miley';

export function siteGapAskBody(g: SiteGap, origin: string): string {
  const list = g.behind
    .slice(0, 12)
    .map((c) => `  ${c.sha} ${c.subject}`)
    .join('\n');
  const more = g.behind.length > 12 ? `\n  … and ${g.behind.length - 12} more` : '';
  return (
    `${siteGapLine(g, origin)}.\n${list}${more}\n` +
    `Merged and accepted is not deployed (ADR 308): \`pnpm --filter @musterd/web deploy:site\` when ready. ` +
    `This ask resolves itself once ${origin}/build.json reports the tip.`
  );
}

/**
 * What the reporter remembers between ticks, at `~/.musterd/live/site-gap.json`. `ask` is the open
 * raise's id — also its thread (a root's thread is its own id, ADR 432) — so the tick that finds the
 * site caught up can close exactly what it opened.
 */
export interface SiteGapStamp {
  deployed: string | null;
  tip: string;
  ask: string | null;
  raised_at: number | null;
}

export type SiteGapAction = 'raise' | 'resolve' | 'none';

/**
 * Damping, stated as the rule rather than a window: ONE open ask per deployed ref. Main moving
 * again while the site is still behind does not re-raise (the ask already says "behind"; a second
 * one is the service chatter ADR 232 names as the failure mode). A deploy that lands somewhere
 * short of the tip resolves the old ask and raises a new one, because the fact changed. Catching up
 * resolves. `no_marker` and `unknown_ref` never raise — an ask that cannot name the gap is noise.
 */
export function nextAction(prev: SiteGapStamp | null, g: SiteGap): SiteGapAction {
  const open = prev?.ask ?? null;
  if (g.status === 'behind') {
    if (!open) return 'raise';
    return prev!.deployed === g.deployed ? 'none' : 'resolve';
  }
  if (g.status === 'current') return open ? 'resolve' : 'none';
  return 'none';
}
