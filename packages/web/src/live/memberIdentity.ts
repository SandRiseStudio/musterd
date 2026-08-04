/**
 * The signed-in member identity for a team — **one slot per browser per team, shared by every
 * route** (ADR 221).
 *
 * /live and /board used to keep separate ideas of who you are, and /live's was always an observer
 * (ADR 063), so the office could show you exactly what was waiting on your decision and never let
 * you decide it. One slot, and signing in anywhere signs you in everywhere on this browser.
 *
 * Keyed by team, not by route: with several projects on one machine you may be `nick` on one team
 * and someone else on another, and approving as the wrong identity is unrecoverable. Separate
 * daemons already mean separate origins (ADR 039 — one team, one daemon), so the per-team key is
 * belt-and-braces on an isolation that already holds rather than the only thing holding it.
 */
export interface MemberIdentity {
  as: string;
  /** The member's credential (mscr_) — HTTP Bearer and the ADR 077 WS claim key. */
  token: string;
}

const memberKey = (team: string) => `musterd.member.v1.${team}`;
/** /board's private key from before this was shared. Read once, migrated forward, then dropped. */
const legacyBoardKey = (team: string) => `musterd.board.member.v1.${team}`;

/** A stored record is only an identity if it carries both halves — a half-written slot is no seat. */
function parse(raw: string | null): MemberIdentity | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { as?: unknown; token?: unknown };
    return typeof v.as === 'string' && typeof v.token === 'string'
      ? { as: v.as, token: v.token }
      : null;
  } catch {
    return null;
  }
}

export function loadMemberIdentity(team: string): MemberIdentity | null {
  if (typeof window === 'undefined') return null;
  try {
    const current = parse(window.localStorage.getItem(memberKey(team)));
    if (current) return current;
    // Migrate on read, so a human already signed into /board is signed into /live the first time
    // they open it. That carry-over is the whole point of collapsing two slots into one.
    const legacy = parse(window.localStorage.getItem(legacyBoardKey(team)));
    if (legacy) saveMemberIdentity(team, legacy);
    return legacy;
  } catch {
    return null;
  }
}

export function saveMemberIdentity(team: string, id: MemberIdentity): void {
  try {
    window.localStorage.setItem(memberKey(team), JSON.stringify(id));
  } catch {
    // Private mode: this session still works as that member, it just will not be remembered.
  }
}

export function forgetMemberIdentity(team: string): void {
  try {
    window.localStorage.removeItem(memberKey(team));
    // Drop the legacy key too, or "watch as an observer instead" would sign you straight back in on
    // the next load via the migration above.
    window.localStorage.removeItem(legacyBoardKey(team));
  } catch {
    // Private mode — nothing was stored to remove.
  }
}

/** How the connected seat was chosen. The rail needs this to tell "not signed in" from "not you". */
export type ResolvedIdentity =
  | { kind: 'member'; as: string; token: string }
  | { kind: 'watch'; as: string; token: string };

/**
 * The total precedence order for who this page connects as (ADR 221):
 *
 *   1. an explicit watch link (`?as=…#w=…`) — a URL instruction, and how a team deliberately hands
 *      the office to someone else; it must never be overridden by whoever last signed in here, or
 *      casting your screen would cast your identity with it;
 *   2. the stored member identity for this team;
 *   3. `null` — the caller provisions an auto observer (ADR 063).
 */
export function resolveIdentity(
  team: string,
  watchLink: { as: string; token: string } | null,
): ResolvedIdentity | null {
  if (watchLink) return { kind: 'watch', as: watchLink.as, token: watchLink.token };
  const member = loadMemberIdentity(team);
  return member ? { kind: 'member', as: member.as, token: member.token } : null;
}
