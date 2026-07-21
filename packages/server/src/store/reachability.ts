import { AvailabilitySchema, type EnforcementPolicy, matchEnforcement } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { listMembers } from './members.js';
import { hasLivePresence, listLiveDrivers } from './presence.js';
import { type MemberRow, resolveCapabilities } from './rows.js';
import { getPolicy } from './teams.js';

/**
 * The reachability projection (ADR 153 §1) — the one derived fact that gates the top-tier hold. Computed
 * on demand from current team + policy state (admin roster ADR 145 §1, ambient presence ADR 057, the
 * enforcement policy ADR 150), exactly like the tier→timeout contract it rides beside: no new timer, no
 * stored field, re-checkable at the terminal moment.
 *
 * `unblocker_reachable(ask)` = (any admin human is present or notifiable) OR (a live teammate seat other
 * than the raiser exists AND the blocked action's class still has an open, sanctioned teammate-completable
 * route). The two terms are deliberately asymmetric (izzo's review, ADR 153 §1):
 *   - the **human term is a settle** — an admin can grant the authorization the gate exists to require;
 *   - the **teammate term is a route-around** — a teammate cannot grant a Gate B approval, only land the
 *     work by a path the gate does not cover (the pilot D5 local ff-merge), so it counts **iff** that
 *     path is open per item 2 (`gate-b-costly-action-local-merge-scope.md`). When item 2 closes the
 *     bypass for a class, the term drops and reachability collapses to human-only for it.
 */

/**
 * "Present or notifiable": an un-left admin human seat exists AND (it has live presence, OR the team's
 * loud reach is wired — `ask_slack_webhook`, ADR 149 — so a raised ask reaches the human off-machine).
 * A team with no admin human seat at all is unreachable on this term regardless of surfaces.
 */
export function adminHumanReachable(
  db: Database,
  teamId: string,
  presenceTimeoutMs: number,
): boolean {
  const adminHumans = listMembers(db, teamId).filter(
    (m) => m.kind === 'human' && resolveCapabilities(m).is_admin,
  );
  if (adminHumans.length === 0) return false;
  if (getPolicy(db, teamId).ask_slack_webhook) return true;
  return adminHumans.some((m) => hasLivePresence(db, m.id, presenceTimeoutMs));
}

/** The self-set availability statuses that compose as `away` posture (ADR 044 ∩ ADR 138). */
const AWAY_AVAILABILITY = new Set(['away', 'dnd', 'off_hours']);

/** Defensive availability read off the raw row — malformed/legacy blobs degrade to implicit-available. */
function isSelfSetAway(m: MemberRow): boolean {
  if (!m.availability) return false;
  try {
    const parsed = AvailabilitySchema.safeParse(JSON.parse(m.availability)).data;
    return parsed ? AWAY_AVAILABILITY.has(parsed.status) : false;
  } catch {
    return false;
  }
}

/**
 * "Present": an admin human who composes as `working`/`idle` on the roster right now — a live
 * presence row **or** a live driver link (steering marks you present, ADR 155 Inc 1), and no self-set
 * `away`/`dnd`/`off_hours` (availability outranks activity, ADR 044/138). The ADR 155 Increment 2
 * modulation input: present → the agent waits the full hold window quietly (the loud surface waits
 * for the re-notify); not present → the loud surface fires at raise. Strictly narrower than
 * {@link adminHumanReachable}: presence shifts only *escalation-eagerness* — which surface fires when
 * — never a hold's absolute timeout or its `held`/`stranded` terminal (the ADR 153 ceiling).
 */
export function adminHumanPresent(
  db: Database,
  teamId: string,
  presenceTimeoutMs: number,
): boolean {
  const adminHumans = listMembers(db, teamId).filter(
    (m) => m.kind === 'human' && resolveCapabilities(m).is_admin,
  );
  if (adminHumans.length === 0) return false;
  const drivers = listLiveDrivers(db, teamId, presenceTimeoutMs);
  return adminHumans.some(
    (m) =>
      !isSelfSetAway(m) && (hasLivePresence(db, m.id, presenceTimeoutMs) || drivers.has(m.name)),
  );
}

/** The representative local-merge landing command the route-around probe matches against — the item-2
 *  teammate-completable path (a teammate lands the blocked push's work via a local merge). Probed, not
 *  hardcoded-open: the answer is read off the live enforcement policy every time.
 *
 *  Deliberately the **worst-case sibling-worktree form** (`git -C <main> merge …`), not the plain
 *  `git merge …`: that is the command a teammate actually runs to land the work when `main` lives in a
 *  sibling worktree, and it is the form the ADR 153 exercise showed slipping past a `git merge*` class.
 *  `normalizeCommand` lifts the `-C <path>` global off before matching, so this probe and a real landing
 *  command classify identically — the derived `unblocker_reachable` agrees with real enforcement by
 *  construction, and stays in agreement even if that normalization ever regressed (both would read the
 *  route OPEN together, never one CLOSED while the other is OPEN). */
const LOCAL_MERGE_PROBE = 'git -C ../main merge lane-branch';

/**
 * Is the teammate route-around still open (item 2)? Today no class gates local merges, so this returns
 * true; the moment the team declares a block-posture class matching the local-merge landing command, it
 * flips false and the teammate term drops — the two ADRs move together instead of contradicting.
 */
export function teammateRouteOpen(policy: EnforcementPolicy): boolean {
  const m = matchEnforcement(policy, { tool: 'Bash', command: LOCAL_MERGE_PROBE });
  return !m || m.cls.posture !== 'block';
}

/** A live agent seat other than the raiser — the body that could land the work if the route is open. */
export function liveTeammateExists(
  db: Database,
  teamId: string,
  raiser: string,
  presenceTimeoutMs: number,
): boolean {
  return listMembers(db, teamId).some(
    (m) => m.kind === 'agent' && m.name !== raiser && hasLivePresence(db, m.id, presenceTimeoutMs),
  );
}

/** The full projection: human settle-term OR (live teammate AND open route-around). */
export function unblockerReachable(
  db: Database,
  teamId: string,
  raiser: string,
  presenceTimeoutMs: number,
): boolean {
  if (adminHumanReachable(db, teamId, presenceTimeoutMs)) return true;
  return (
    liveTeammateExists(db, teamId, raiser, presenceTimeoutMs) &&
    teammateRouteOpen(getPolicy(db, teamId).enforcement)
  );
}
