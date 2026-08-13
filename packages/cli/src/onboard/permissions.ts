import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RoleTemplate } from './role.js';

/**
 * ADR 261 — the standard floor and the seat-dir permission installer.
 *
 * The harness permission layer composes with musterd's two layers as AND, and until this module
 * nobody owned it: every seat's `.claude/settings.local.json` allowlist was an accident of which
 * prompts a human happened to approve. A non-interactive seat with no permissions block fails
 * closed on its first Write — correctly, silently, and presenting as a broken tool (the 2026-08-13
 * ryder incident; hours lost to the innocent layer).
 *
 * Entries are Claude Code's own rule syntax, VERBATIM — `Read`, `Edit`, `Bash(<prefix> *)` — never
 * a friendly-name vocabulary. The seed library's historical lowercase entries (`'read'`,
 * `'bash(git diff*)'`) matched nothing: rules are keyed on exact tool names, so everything ever
 * provisioned from them was inert. A translation layer would just be a second place for that
 * class of defect to live.
 */

export interface PermissionLists {
  allow: string[];
  ask: string[];
  deny: string[];
}

/**
 * What every claude-code seat needs to function NON-INTERACTIVELY, independent of role: file
 * edits, the enforced git loop (ADR 106), the repo gates, and the read-shaped basics. Allow-only
 * by construction — a floor must merge under any ceiling, so it can never carry `deny` (or `ask`,
 * which in a headless session is just a slower fail-closed).
 *
 * Deliberately NOT here: `Bash(git push *)` variants beyond the loop's own, `rm`, network tools.
 * The floor is "can do its job", not "can do anything" — the ADR 150 lane gate and the role
 * ceiling stay the instruments of restraint.
 */
export const STANDARD_FLOOR: PermissionLists = {
  allow: [
    'Read',
    'Edit',
    'Write',
    'Glob',
    'Grep',
    // The enforced git loop (ADR 106): branch → commit → push → PR → auto-merge → rebase.
    'Bash(git status *)',
    'Bash(git diff *)',
    'Bash(git log *)',
    'Bash(git show *)',
    'Bash(git add *)',
    'Bash(git commit *)',
    'Bash(git checkout *)',
    'Bash(git switch *)',
    'Bash(git branch *)',
    'Bash(git fetch *)',
    'Bash(git rebase *)',
    'Bash(git push *)',
    'Bash(gh pr *)',
    // The repo gates a seat must run before any push (build → typecheck → lint → format → tests).
    'Bash(pnpm build*)',
    'Bash(pnpm typecheck*)',
    'Bash(pnpm lint*)',
    'Bash(pnpm format:check*)',
    'Bash(pnpm test*)',
    'Bash(pnpm vitest *)',
    'Bash(pnpm exec vitest *)',
    'Bash(pnpm exec prettier *)',
    'Bash(pnpm context:check*)',
    'Bash(pnpm wiki:*)',
    // Read-shaped shell basics.
    'Bash(ls *)',
    'Bash(rg *)',
    'Bash(cat *)',
    // The musterd CLI — the coordination channel when the MCP bridge is not the one in use.
    'Bash(musterd *)',
  ],
  ask: [],
  deny: [],
};

interface SeatSettings {
  permissions?: Partial<Record<keyof PermissionLists, string[]>>;
  [key: string]: unknown; // hooks and anything else a human put there — carried verbatim
}

const LISTS: (keyof PermissionLists)[] = ['allow', 'ask', 'deny'];

/**
 * Merge the standard floor — plus a role's permission profile, when the seat has one — into
 * `<dir>/.claude/settings.local.json`. Dir-aware because `musterd agent` provisions a worktree
 * that is never `process.cwd()`.
 *
 * Merge-never-clobber (the ADR 255 posture): hooks, unknown keys, and every entry outside the
 * profile's own vocabulary survive verbatim — the shape of the 2026-08-13 manual unblock (scoped
 * allow added, five hook groups preserved) is what this must produce mechanically. Deny is
 * authoritative and always written; surplus user allows are kept, not stripped (deny outranks
 * allow, so they are inert — nick's call, 2026-08-13).
 *
 * Returns only the entries NEWLY added per list, so the ADR 030 manifest can record an exact
 * reversal — and so idempotence is observable: a second run returns empty lists.
 */
export function installSeatPermissions(dir: string, role?: RoleTemplate): PermissionLists {
  const path = join(dir, '.claude', 'settings.local.json');
  let settings: SeatSettings = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, 'utf8')) as SeatSettings;
    } catch {
      // An unparseable settings file is a human's broken edit, not ours to overwrite: leave it
      // alone and add nothing. (readBinding's posture in config.ts — announce, never clobber.)
      return { allow: [], ask: [], deny: [] };
    }
  }
  const profile: PermissionLists = {
    allow: [...STANDARD_FLOOR.allow, ...(role?.tools.permissions.allow ?? [])],
    ask: [...(role?.tools.permissions.ask ?? [])],
    deny: [...(role?.tools.permissions.deny ?? [])],
  };
  settings.permissions ??= {};
  const added: PermissionLists = { allow: [], ask: [], deny: [] };
  let changed = false;
  for (const list of LISTS) {
    const existing = settings.permissions[list] ?? [];
    const have = new Set(existing);
    for (const entry of profile[list]) {
      if (!have.has(entry)) {
        existing.push(entry);
        have.add(entry);
        added[list].push(entry);
        changed = true;
      }
    }
    if (existing.length > 0) settings.permissions[list] = existing;
  }
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }
  return added;
}
