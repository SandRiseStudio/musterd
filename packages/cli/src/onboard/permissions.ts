import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Profile } from './profile.js';

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
    // Spelled in the DIALOG form — trailing ` *` — deliberately (docs-verified 2026-08-13):
    // `Bash(cmd*)` also matches, but "Yes, don't ask again" writes the space form, and two working
    // spellings that never string-match each other read as phantom drift in every diff and check.
    // The space form is also the narrower one (word boundary), which is the safe direction.
    'Bash(pnpm build *)',
    'Bash(pnpm typecheck *)',
    'Bash(pnpm lint *)',
    'Bash(pnpm format:check *)',
    'Bash(pnpm test *)',
    'Bash(pnpm vitest *)',
    'Bash(pnpm exec vitest *)',
    'Bash(pnpm exec prettier *)',
    'Bash(pnpm context:check *)',
    // Enumerated, not `Bash(pnpm wiki:*)`: a trailing `:*` is parsed as the suffix form (≡ ` *`),
    // so that spelling required a SPACE after "wiki" and never matched `pnpm wiki:check` at all —
    // the same silently-inert shape as defect 3, caught while normalizing.
    'Bash(pnpm wiki:check *)',
    'Bash(pnpm wiki:index *)',
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
 * Merge the standard floor — plus a profile's permission lists, when the seat has one — into
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
export function installSeatPermissions(dir: string, profile?: Profile): PermissionLists {
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
  const wanted: PermissionLists = {
    allow: [...STANDARD_FLOOR.allow, ...(profile?.tools.permissions.allow ?? [])],
    ask: [...(profile?.tools.permissions.ask ?? [])],
    deny: [...(profile?.tools.permissions.deny ?? [])],
  };
  settings.permissions ??= {};
  const added: PermissionLists = { allow: [], ask: [], deny: [] };
  let changed = false;
  for (const list of LISTS) {
    const existing = settings.permissions[list] ?? [];
    // Canonical-form dedupe: a human-approved `Bash(pnpm test*)` / `Bash(pnpm test:*)` already IS
    // the floor's `Bash(pnpm test *)`, and appending the third spelling of one rule turns every
    // later diff of this file into noise. Same equivalence the inspector uses — install and check
    // must agree on what "present" means, or a silent check follows a non-empty install forever.
    const have = new Set(existing.map(canonicalRuleForm));
    for (const entry of wanted[list]) {
      if (!have.has(canonicalRuleForm(entry))) {
        existing.push(entry);
        have.add(canonicalRuleForm(entry));
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

/**
 * Does `deny` entry `rule` outrank `allow` entry `candidate`?
 *
 * Exact match, plus the tool-wide form: `Bash` denies every `Bash(...)` rule, because Claude Code
 * matches a bare tool name against the whole tool. Deliberately NOT a specifier-prefix comparison
 * (`Bash(git *)` vs `Bash(git log *)`) — that is the harness's own matcher, and reimplementing it
 * here would be a second place for the defect-3 class to live. Under-reporting is the safe
 * direction: a missed surplus is a stale note, an invented one sends a human to delete a working
 * entry.
 */
function denyOutranks(rule: string, candidate: string): boolean {
  return candidate === rule || candidate.startsWith(rule + '(');
}

/**
 * One canonical spelling for the three trailing-wildcard forms Claude Code treats alike.
 *
 * Docs-verified 2026-08-13: `Bash(cmd *)`, `Bash(cmd:*)` and `Bash(cmd*)` all match `cmd …`
 * commands (the first two identically; the bare-star form is broader — no word boundary), but as
 * strings they never match each other. The permission dialog writes the space form, so a seat
 * whose human clicked "Yes, don't ask again" holds working equivalents the floor's exact strings
 * would not find, and the missing-floor count reads as drift where none exists.
 *
 * SPELLING equivalence only, deliberately: the three forms of one prefix fold together, and
 * nothing else does. No subsumption ("`Bash(git *)` covers `Bash(git push *)`") — that reasoning
 * belongs to the harness's matcher, and a home-grown copy of it is where the defect-3 class lives.
 */
function canonicalRuleForm(entry: string): string {
  const m = /^(.+\()(.+?)(?: \*|:\*|\*)\)$/.exec(entry);
  return m ? `${m[1]}${m[2]} *)` : entry;
}

/**
 * ADR 261 increment 2 — the harness permission layer, as ADR 171 freshness sees it.
 *
 * Increment 1 arms `musterd agent` so new seats are born with a floor. Existing seats are untouched
 * until re-provisioned, and this is what surfaces them.
 *
 * EVERY FINDING NAMES THE LAYER. Three permission layers compose as AND — capabilities → MCP
 * surface, the ADR 150 lane gate, and this one — so "a write was denied" is ambiguous by
 * construction, and the ambiguity is expensive: the 2026-08-13 incident cost hours spent auditing
 * the two innocent layers. A finding that does not say *harness* and *settings.local.json* has not
 * done the job.
 *
 * Silent for a folder with no settings file — that is not a musterd seat, and a session-start probe
 * that invents drift for someone's unrelated checkout gets muted, taking the real findings with it.
 * Returns findings; never mutates. Repair is `musterd init --refresh-permissions`, which reuses
 * {@link installSeatPermissions} so repair and provisioning cannot drift apart.
 */
export function inspectSeatPermissions(dir: string): string[] {
  const path = join(dir, '.claude', 'settings.local.json');
  if (!existsSync(path)) return [];
  let settings: SeatSettings;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8')) as SeatSettings;
  } catch {
    // A human's broken edit. Announce-never-clobber has no announce channel here, and a throw would
    // take the session start with it — the hook-drift inspector makes the same call.
    return [];
  }
  const findings: string[] = [];
  const allow = settings.permissions?.allow ?? [];
  // Compare in canonical form: a human-approved `Bash(pnpm test*)` or `Bash(pnpm test:*)` is a
  // working spelling of the floor's `Bash(pnpm test *)`, not a gap.
  const have = new Set(allow.map(canonicalRuleForm));
  const missing = STANDARD_FLOOR.allow.filter((entry) => !have.has(canonicalRuleForm(entry)));

  if (!settings.permissions) {
    findings.push(
      'this seat has NO harness permissions block in .claude/settings.local.json — the third ' +
        'permission layer (harness allow/ask/deny), which musterd now owns (ADR 261). A ' +
        'non-interactive session cannot prompt, so its first Write fails closed and presents as a ' +
        'broken tool, while the lane gate and MCP surface both look innocent. Repair: ' +
        '`musterd init --refresh-permissions`.',
    );
  } else if (missing.length > 0) {
    findings.push(
      `this seat's harness permissions block (.claude/settings.local.json) is missing ` +
        `${String(missing.length)} of the ${String(STANDARD_FLOOR.allow.length)} standard-floor ` +
        `entries this build writes (ADR 261) — e.g. ${missing.slice(0, 3).join(', ')}. A ` +
        `non-interactive session fails closed on the ones it needs. Repair: ` +
        `\`musterd init --refresh-permissions\`.`,
    );
  }

  // Decision 5: surplus allows are REPORTED, never stripped. Deny already makes them inert, so this
  // costs nothing to leave in place and re-promotion restores them for free — but a human approved
  // each one at a prompt, and silently deleting approved state on a schedule they did not choose is
  // the misattributed-silent-failure shape this ADR exists to end.
  const deny = settings.permissions?.deny ?? [];
  const surplus = allow.filter((entry) => deny.some((rule) => denyOutranks(rule, entry)));
  if (surplus.length > 0) {
    findings.push(
      `${String(surplus.length)} allow entr${surplus.length === 1 ? 'y' : 'ies'} in ` +
        `.claude/settings.local.json ${surplus.length === 1 ? 'is' : 'are'} inert — the role ` +
        `ceiling denies ${surplus.length === 1 ? 'it' : 'them'} and deny outranks allow ` +
        `(${surplus.slice(0, 3).join(', ')}). Kept deliberately, not stripped (ADR 261 decision ` +
        `5); resolve by widening the role or dropping the entr${surplus.length === 1 ? 'y' : 'ies'}.`,
    );
  }
  return findings;
}
