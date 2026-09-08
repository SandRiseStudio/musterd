import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, readBindingAt } from '../config.js';
import { stamped } from './guidance.js';
import type { Harness } from './harness.js';

/**
 * Role-skill **bridges** (ADR 334): a seat whose roster role has a committed skill under
 * `.agents/skills/<role>/` gets a thin pointer to it in whichever harnesses catalog a native skill
 * shell, so the harness actually loads the role the roster says the seat holds.
 *
 * ## Why this exists
 * Measured 2026-08-28: the `big-body` seat carried `role = "security"` on the roster while its
 * worktree had no bridge, so the canonical `.agents/skills/security/SKILL.md` never loaded. The seat
 * ran a whole session without its role and nearly started public-posture work that skill forbids
 * until a baseline audit lands. Provisioning knew the role and stayed silent — a seat holding a role
 * it cannot load is worse than a seat with no role, because the roster asserts a duty nothing
 * enforces.
 *
 * ## The boundary this keeps (ADR 272)
 * The role is a **team** fact and is strictly read-only input here; the bridge is a **workspace**
 * fact rendered by provisioning. Reading a role to decide what to render consumes a team fact and
 * creates none: nothing here grants, removes, or routes on a role.
 *
 * ## The shape (ADR 299 §2)
 * One canonical body, thin per-harness pointers — never a copy. Bridges are stamped like every other
 * managed guidance file, so drift detection, `uninstall`, and harness deselect treat them the same.
 */

/** Where committed, reviewed skills live (ADR 299 §1). Repo-relative. */
export const COMMITTED_SKILL_ROOT = '.agents/skills';

export interface CommittedRoleSkill {
  /** Repo-relative path to the canonical body the bridge points at. */
  canonicalPath: string;
  /** The skill's own `description:` — reused verbatim so the bridge gates on the same sentence. */
  description: string;
}

/**
 * The seat's role as the **file-backed roster** records it (ADR 058 §5: the seat file is the single
 * writer). Returns null when the seat file is missing or its role is empty — both mean "no role", and
 * neither is an error worth failing provisioning over.
 */
export function resolveSeatRole(rosterHome: string, seat: string): string | null {
  const abs = join(rosterHome, '.musterd', 'seats', `${seat}.toml`);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const match = /^\s*role\s*=\s*"([^"]*)"/m.exec(text);
  const role = match?.[1]?.trim();
  return role ? role : null;
}

/** The committed skill for `role`, or null when the repo carries none. */
export function committedRoleSkill(repoRoot: string, role: string): CommittedRoleSkill | null {
  const canonicalPath = `${COMMITTED_SKILL_ROOT}/${role}/SKILL.md`;
  const abs = join(repoRoot, canonicalPath);
  if (!existsSync(abs)) return null;
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const match = /^description:\s*(.+)$/m.exec(text);
  return { canonicalPath, description: match?.[1]?.trim() ?? `The ${role} role skill.` };
}

/** Seams for {@link seatRoleFor}, so the resolution is testable without a real machine config. */
export interface SeatRoleDeps {
  /** The seat name this worktree is bound to, or null when it is bound to none. */
  seatOf(worktreeRoot: string): { team: string; seat: string } | null;
  /** The file-backed roster home for a team, or null when the team is db-only. */
  rosterHomeOf(team: string): string | null;
}

/**
 * The role this worktree's seat holds, resolved through the roster the daemon and CLI already share
 * (ADR 058). Null whenever any link is missing — unbound folder, db-only team, seat with no role —
 * because provisioning a workspace must never fail over an absent optional attachment (ADR 272 §1).
 */
export function seatRoleFor(worktreeRoot: string, deps: SeatRoleDeps): string | null {
  const bound = deps.seatOf(worktreeRoot);
  if (!bound) return null;
  const home = deps.rosterHomeOf(bound.team);
  if (!home) return null;
  return resolveSeatRole(home, bound.seat);
}

/**
 * The real readers: the worktree's own binding for the seat, and the shared machine config for the
 * team's roster home. Every lookup is wrapped — a diagnostic must never become the failure it was
 * explaining, and provisioning that dies on an unreadable config is worse than one that renders no
 * bridge.
 */
export function defaultSeatRoleDeps(): SeatRoleDeps {
  return {
    seatOf(worktreeRoot) {
      try {
        const binding = readBindingAt(worktreeRoot);
        const seat = binding?.claim?.mode === 'seat' ? binding.claim.name : undefined;
        return binding?.team && seat ? { team: binding.team, seat } : null;
      } catch {
        return null;
      }
    },
    rosterHomeOf(team) {
      try {
        return loadConfig().rosterHome[team] ?? null;
      } catch {
        return null;
      }
    },
  };
}

/** The bridges this worktree's seat should carry, for the harnesses given. The one call an adapter
 *  makes; resolution and rendering are the tested units above. */
export function roleBridgesFor(
  worktreeRoot: string,
  harnesses: Harness[],
  deps: SeatRoleDeps = defaultSeatRoleDeps(),
): Record<string, string> {
  return roleBridgeMap(worktreeRoot, seatRoleFor(worktreeRoot, deps), harnesses);
}

/** The bridge body — the pointer itself, identical across harnesses. */
function bridgeBody(canonicalPath: string): string {
  return [
    'This is a bridge, not the skill. Read the canonical skill at',
    `\`${canonicalPath}\` (repo-relative) and follow it. If that file is missing,`,
    "this worktree's branch predates it — merge or rebase onto `main` first. Do not",
    'edit this bridge to add content; the canonical file is the only body (ADR 299).',
  ].join('\n');
}

/** Wrap the bridge body in the frontmatter flavor a harness gates its catalog on. */
function bridgeFile(
  flavor: 'claude-code' | 'cursor',
  role: string,
  skill: CommittedRoleSkill,
): string {
  const body = bridgeBody(skill.canonicalPath);
  if (flavor === 'cursor') {
    return ['---', `description: ${skill.description}`, 'alwaysApply: false', '---', '', body].join(
      '\n',
    );
  }
  return ['---', `name: ${role}`, `description: ${skill.description}`, '---', '', body].join('\n');
}

/**
 * The stamped bridge file map for one role across `harnesses`, keyed by worktree-relative path.
 * Empty when the seat has no role, the role has no committed skill, or no harness catalogs a native
 * skill shell — every one of which is a normal state, not a failure.
 */
export function roleBridgeMap(
  repoRoot: string,
  role: string | null,
  harnesses: Harness[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!role) return out;
  const skill = committedRoleSkill(repoRoot, role);
  if (!skill) return out;
  for (const h of harnesses) {
    const pattern = h.guidance?.roleSkillPattern;
    if (!pattern) continue;
    out[pattern.replace('<role>', role)] = stamped(
      bridgeFile(h.guidance!.frontmatter, role, skill),
    );
  }
  return out;
}
