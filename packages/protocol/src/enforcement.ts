import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Enforcement policy (ADR 150 — structural inducement). The declaration surface both PreToolUse gates
 * read: a small table of **classes** a team has deliberately marked as consequential enough to gate at
 * the tool boundary. This is the foundation shared by Gate A (lane-ownership) and Gate B (action→ask);
 * neither gate's *decision* lives here — only the class table, the tool-call match, and the fingerprint.
 *
 * Two structural guards keep this from becoming a second harness-permission-prompt system (ADR 145's
 * drawn line): the class table lives **only** on the team policy (admin-set, audited `policy.change`)
 * — never in harness settings — and a tool call matching **no** declared class passes through untouched
 * (`matchEnforcement` returns null). If a change would make a gate fire on an undeclared call, it is out
 * of scope by construction.
 */

/** A class's *kind* selects which gate adjudicates a match — never how the match is computed. */
export const ENFORCEMENT_CLASS_KINDS = ['contended-surface', 'costly-action'] as const;
export type EnforcementClassKind = (typeof ENFORCEMENT_CLASS_KINDS)[number];

/** Per-class posture. `warn` (the default, ADR 083) surfaces + records but never denies; `block` is the
 *  deliberate per-class escalation a team turns on for exactly the surfaces/actions it decided are worth
 *  the friction. There is no global "strict mode" — posture is always per class. */
export const ENFORCEMENT_POSTURES = ['warn', 'block'] as const;
export type EnforcementPosture = (typeof ENFORCEMENT_POSTURES)[number];

/**
 * One declared class. `class` is the short legible name (`merge-to-main`, `src/tariff.ts`) that appears
 * in every denial, ask body, and audit row — the unit the team declared. `match` is a list of globs;
 * their flavor is chosen by the **incoming tool**, not the class: an `Edit`/`Write` call matches its
 * target *path* (`*` = one segment, `**` = any depth), a `Bash` call matches its normalized *command*
 * (`*` = any run of chars, so a branch's `/` doesn't stop the wildcard). Because the command is
 * normalized (`normalizeCommand` — env-prefix + git global options lifted off), a class targets the
 * subcommand verb and the obvious glob works: `git merge*` matches `git -C ../main merge lane` too.
 * First class in declaration order to match wins.
 */
export const EnforcementClassSchema = z.object({
  class: z.string().min(1),
  kind: z.enum(ENFORCEMENT_CLASS_KINDS),
  match: z.array(z.string().min(1)).min(1),
  posture: z.enum(ENFORCEMENT_POSTURES).default('warn'),
});
export type EnforcementClass = z.infer<typeof EnforcementClassSchema>;

/** The `enforcement` field on `PolicySchema`. `parse({})` yields the off posture: an empty class table,
 *  so every tool call passes untouched (warn-never-block out of the box, ADR 083 / ADR 145 §6). */
export const EnforcementPolicySchema = z.object({
  classes: z.array(EnforcementClassSchema).default([]),
});
export type EnforcementPolicy = z.infer<typeof EnforcementPolicySchema>;

/**
 * The `POST /gate` request body — the shapes the hook sends the daemon on a MATCHED call, so the daemon
 * adjudicates atomically server-side (race-safe dedup/emit/release for Gate B). `target` (the path or
 * normalized command) rides here only to *make the decision* and fill a Gate B ask body — it is never
 * written to an audit row (ADR 051 shapes-only; audit stores `class` + `fingerprint`). The daemon trusts
 * the client-computed `class`/`fingerprint` (cooperative-agent threat model — this is inducement, not a
 * security boundary). An undeclared call never produces a request: the hook only POSTs on a match.
 */
export const GateCheckRequestSchema = z.object({
  kind: z.enum(ENFORCEMENT_CLASS_KINDS),
  class: z.string().min(1),
  fingerprint: z.string().min(1),
  posture: z.enum(ENFORCEMENT_POSTURES),
  tool: z.string().min(1),
  target: z.string(),
  /** For Gate B release re-checks: the ask this fingerprint already raised (the agent re-attempts
   *  after a denial; the daemon re-checks that thread for a human accept). Absent on first attempt. */
  ask_ref: z.string().optional(),
});
export type GateCheckRequest = z.infer<typeof GateCheckRequestSchema>;

/** The audit `outcome` a gate decision records (in `detail.outcome`). Gate A uses
 *  `allowed`/`warned`/`denied`; Gate B adds the ask-lifecycle outcomes. `allowed` = an owned lane or a
 *  released ask; `warned` = warn posture proceeded (the un-asked-costly-action query keys on it). */
export const GATE_OUTCOMES = [
  'allowed',
  'warned',
  'denied',
  'denied_ask_raised',
  'denied_awaiting',
  'denied_declined',
  'released',
] as const;
export type GateOutcome = (typeof GATE_OUTCOMES)[number];

/** The `POST /gate` response the hook maps to a PreToolUse allow/deny. `deny` + `reason` becomes the
 *  repair string the agent sees in its action loop; `ask_ref` (Gate B) is surfaced so a re-attempt can
 *  reference the raised ask. */
export const GateDecisionSchema = z.object({
  decision: z.enum(['allow', 'deny']),
  outcome: z.enum(GATE_OUTCOMES),
  reason: z.string(),
  ask_ref: z.string().optional(),
});
export type GateDecision = z.infer<typeof GateDecisionSchema>;

/** The normalized tool call a gate sees — exactly what a PreToolUse hook already hands over (tool name
 *  + input), nothing more. The gate gains no new visibility into the session. */
export interface GateToolCall {
  /** Harness tool name, e.g. `Edit` | `Write` | `Bash`. */
  tool: string;
  /** Target path for path-shaped tools (`Edit`/`Write`). */
  path?: string;
  /** Raw command for `Bash` (normalized before matching). */
  command?: string;
  /** ADR 163 — present ONLY when the call comes from a subagent's own tool use, absent for the parent
   *  seat's calls. The one field that distinguishes the two: everything else in the payload
   *  (`session_id`, `transcript_path`, `cwd`, `prompt_id`) is identical by construction. */
  actorId?: string;
  /** ADR 163 — the subagent's declared type (`Explore`, …), alongside `actorId`. */
  actorType?: string;
  /** ADR 163 — on a *spawn* call (`tool_name: Agent`), the subagent type being requested. The spawn
   *  call carries this and `spawnModel` but NO `actorId`; the resulting subagent's own calls carry
   *  `actorId` but no model. The two halves share no key — hence no join in increment 1. */
  spawnType?: string;
  /** ADR 163 — on a spawn call, the `model:` override if one was passed. The only place a subagent's
   *  model is ever visible. */
  spawnModel?: string;
  /** ADR 167 — on a `ccd_session_mgmt.send_message` call, the body/target already reduced to sha256-16
   *  AT PARSE TIME (plus any ULID the body carried). The raw body and raw session id are deliberately
   *  never stored on this object at all: they exist only inside `parseToolCall`'s frame, so no later
   *  code path can leak what was never kept. */
  bodyFingerprint?: string;
  sessionRef?: string;
  nudgeRef?: string;
}

/** A class match: the class, the concrete target that matched (path or normalized command), and the
 *  fingerprint (class + target) retries converge on so a re-attempt maps to ONE ask (Gate B) / decision. */
export interface EnforcementMatch {
  cls: EnforcementClass;
  target: string;
  fingerprint: string;
}

/** Leading `NAME=val` env-assignment tokens — identity-neutral: they set the environment the command
 *  runs in, not which command runs. `A=1 git merge` fingerprints as `git merge`. (`make A=1` is left
 *  alone — the first token is the command word, not an assignment.) */
function stripEnvPrefix(command: string): string {
  const tokens = command.split(' ');
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
  return tokens.slice(i).join(' ');
}

/** git's global options that take a following argument (`git -C <path> merge …`) — they sit *before*
 *  the subcommand and are neutral to the action's identity. `--exec-path` is intentionally absent: bare
 *  it prints-and-exits (a boolean below), attached (`--exec-path=<p>`) it is handled by the `=` form. */
const GIT_ARG_GLOBALS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--attr-source',
]);
/** git's global boolean/terminal options before a subcommand (no argument to consume). */
const GIT_BOOL_GLOBALS = new Set([
  '-p',
  '--paginate',
  '-P',
  '--no-pager',
  '--bare',
  '--no-replace-objects',
  '--no-lazy-fetch',
  '--no-optional-locks',
  '--no-advice',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--exec-path',
  '--html-path',
  '--man-path',
  '--info-path',
]);

/**
 * Lift git's identity-neutral *global* options out from between `git` and its subcommand, so the same
 * action matches and fingerprints identically however it is spelled. This closes the ADR 153 exercise
 * gap: when `main` lives in a sibling worktree the natural landing form is `git -C ../main merge lane`,
 * which a subcommand-anchored glob (`git merge*`) never matched — the solo strand probe sailed through
 * un-gated, and the `teammateRouteOpen` reachability probe (which tested the plain form) read a class
 * as CLOSED while real enforcement left it OPEN. After this, `git -C ../main merge lane` → `git merge
 * lane`, so the obvious glob catches it and the derived fact agrees with enforcement by construction.
 *
 * Only options *before* the first non-option token (the subcommand) are lifted — git's own grammar —
 * so a subcommand's own flag is never touched (`git commit -C HEAD` keeps its `-C`, which reuses a
 * commit message rather than choosing a directory). An unrecognized pre-subcommand token stops the scan
 * (git would itself reject it) — we never over-strip. What a single command glob still cannot reach is a
 * leading shell wrapper or chain (`cd ../main && git merge`, `bash -c '…'`): that is the ADR 150
 * inducement boundary (cooperative-agent inducement, not a sandbox), documented, not papered over.
 */
function stripGitGlobalOptions(command: string): string {
  const tokens = command.split(' ');
  if (tokens[0] !== 'git') return command;
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t === '') {
      i += 1;
    } else if (t.startsWith('--') && t.includes('=')) {
      // Attached long-option form: `--git-dir=<p>`, `--exec-path=<p>`, `--config-env=<n>=<e>`.
      const name = t.slice(0, t.indexOf('='));
      if (GIT_ARG_GLOBALS.has(name) || name === '--exec-path') i += 1;
      else break;
    } else if (GIT_ARG_GLOBALS.has(t)) {
      i += 2; // consume the option and its separate-token argument
    } else if (GIT_BOOL_GLOBALS.has(t)) {
      i += 1;
    } else {
      break; // first non-global token — the subcommand; keep it and everything after verbatim
    }
  }
  return ['git', ...tokens.slice(i)].join(' ');
}

/**
 * The ADR's command normalization — the shape the matcher and fingerprint see, so an action matches a
 * glob and dedups a Gate B ask by *what it does*, not how it was typed. Three identity-neutral passes:
 * first line + collapsed whitespace (`gh  pr merge\n…` → `gh pr merge`); leading env-assignments
 * (`A=1 git merge` → `git merge`); and git's pre-subcommand global options (`git -C ../main merge lane`
 * → `git merge lane`, so a class author writes the obvious `git merge*` and it still catches the
 * sibling-worktree form — ADR 153 exercise finding).
 */
export function normalizeCommand(command: string): string {
  const flat = (command.split('\n', 1)[0] ?? '').trim().replace(/\s+/g, ' ');
  return stripGitGlobalOptions(stripEnvPrefix(flat));
}

/**
 * Minimal glob → RegExp, anchored both ends. `path` flavor is path-segmented (`*` = `[^/]*`, a
 * leading double-star = any depth) — mirrors the archaeology matcher. `command` flavor makes `*` cross
 * everything (`.*`) so a wildcard spans a branch's `/` in `git push --force origin foo/bar`.
 */
export function globToRegExp(glob: string, flavor: 'path' | 'command'): RegExp {
  const star = flavor === 'command' ? '.*' : '[^/]*';
  let out = '';
  let i = 0;
  while (i < glob.length) {
    if (flavor === 'path' && glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
    } else if (flavor === 'path' && glob.startsWith('**', i)) {
      out += '.*';
      i += 2;
    } else if (glob[i] === '*') {
      out += star;
      i += 1;
    } else {
      const ch = glob[i]!;
      out += /[.+^${}()|[\]\\?]/.test(ch) ? `\\${ch}` : ch;
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/** The fingerprint a re-attempt of the same action converges on — a short sha256 of `class target`, so
 *  Gate B's dedup and both gates' audit rows key on the shape, never the raw command text. */
export function gateFingerprint(cls: string, target: string): string {
  return createHash('sha256').update(`${cls}\u0000${target}`).digest('hex').slice(0, 16);
}

/**
 * Match a tool call against the declared class table (ADR 150). Returns the first class (declaration
 * order) whose globs match the tool's target, or **null** when nothing matches — the load-bearing
 * default: an undeclared call is never gated. Matching flavor is chosen by the incoming tool, so a
 * command class simply never matches a path and vice-versa; the class's `kind` is carried through for
 * the caller to dispatch (contended-surface → Gate A, costly-action → Gate B), it does not steer the match.
 */
export function matchEnforcement(
  policy: EnforcementPolicy,
  call: GateToolCall,
): EnforcementMatch | null {
  const path = call.path?.trim();
  const command = call.command != null ? normalizeCommand(call.command) : undefined;
  // A path-shaped tool matches its path; a command-shaped tool matches its command. Nothing to match on
  // → nothing gated.
  const target =
    path && path.length > 0 ? path : command && command.length > 0 ? command : undefined;
  if (target === undefined) return null;
  const flavor: 'path' | 'command' = target === path ? 'path' : 'command';
  for (const cls of policy.classes) {
    for (const glob of cls.match) {
      if (globToRegExp(glob, flavor).test(target)) {
        return { cls, target, fingerprint: gateFingerprint(cls.class, target) };
      }
    }
  }
  return null;
}

/* ─────────────────────────── ADR 163 — actor attestation ─────────────────────────── */

/**
 * Actor attestation (ADR 163) is **not a third gate**. A gate answers _may this proceed_; this answers
 * only _who did it_. It has no posture, no class table, no deny path — it cannot change whether a call
 * proceeds, which is precisely why it is exempt from the declared-class boundary above (ADR 150 §Gate B,
 * as amended): the creep that guard prevents requires the power to say no.
 *
 * The two rows are asymmetric on purpose. A **write** row says a subagent wrote; a **spawn** row says
 * fan-out happened at all, and is the denominator the write count is read against. Increment 1 records
 * both and joins neither — the spawn call carries the `model:` override but no `actorId`, the subagent's
 * own calls carry `actorId` but no model, and nothing links them.
 *
 * ADR 167 adds a third kind, `session-message`: a seat used the harness's own session-to-session
 * messaging (`ccd_session_mgmt.send_message`) — an identityless channel the ledger otherwise never
 * sees. Same exemption, same reason: the reporter still cannot say no.
 */
export const ACTOR_ATTESTATION_KINDS = [
  'subagent-write',
  'subagent-spawn',
  'session-message',
] as const;
export type ActorAttestationKind = (typeof ACTOR_ATTESTATION_KINDS)[number];

/**
 * The `POST /actor` body — shapes only (ADR 051), like every gate row. Never file content, never the
 * subagent's prompt. `target` is the same repo-relative path or normalized command the matcher would
 * see, carried so "which surfaces do subagents write to" is answerable without storing anything richer.
 */
export const ActorAttestationSchema = z.object({
  kind: z.enum(ACTOR_ATTESTATION_KINDS),
  tool: z.string().min(1),
  /** Subagent identity — present on `subagent-write`, absent on `subagent-spawn` (the spawn call has none). */
  actorId: z.string().min(1).optional(),
  actorType: z.string().min(1).optional(),
  /** Path or normalized command the write targeted. */
  target: z.string().optional(),
  /** Spawn-only: the requested subagent type and `model:` override, if any. */
  spawnType: z.string().min(1).optional(),
  spawnModel: z.string().min(1).optional(),
  /** `session-message`-only (ADR 167), all computed CLIENT-side so the raw values never cross the wire:
   *  the message body reduced to sha256-16 — stricter than the Bash pattern (where the raw command
   *  crosses and the server fingerprints) because a session message is another agent's incoming context
   *  (ADR 128), not the sender's own command line. */
  bodyFingerprint: z.string().length(16).optional(),
  /** `session-message`-only: the target harness session id reduced to sha256-16 — raw session ids never
   *  cross the wire (the `SessionCaptureSchema` contract, ADR 131 §5), but "same target as last time?"
   *  stays answerable. */
  sessionRef: z.string().length(16).optional(),
  /** `session-message`-only: a ULID found in the body, if any — the key ADR 167's nudge-confirmation
   *  derives on (a sanctioned relay carries the nudged message's id; organic use carries none). */
  nudgeRef: z
    .string()
    .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    .optional(),
});
export type ActorAttestation = z.infer<typeof ActorAttestationSchema>;

/* ─────────────────────────── ADR 167 — session-message observation ─────────────────────────── */

/** The harness tool ADR 167 observes: Claude Code Desktop's session-to-session send. One exact name —
 *  `list_sessions` is a read (reads need no provenance, the ADR 163 line) and `set_session_title` is
 *  ADR 160's governed surface already. */
export const CCD_SEND_MESSAGE_TOOL = 'mcp__ccd_session_mgmt__send_message';

/** sha256-16 of an arbitrary text — the shapes-only reduction ADR 167 applies to a session message's
 *  body and target session id client-side. Sibling of `gateFingerprint`, minus the class prefix: here
 *  there is no class table, just "never the raw value" (ADR 051/128). */
export function textFingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** First ULID in a text, or undefined — how a relayed nudge self-identifies (ADR 167): the daemon put
 *  the nudged message's id in the composed line, so its presence in a sent body is the join key. */
export function extractUlid(text: string): string | undefined {
  return /[0-9A-HJKMNP-TV-Z]{26}/.exec(text)?.[0];
}

/** Tools whose call IS a write, with no inspection needed. */
const WRITE_SHAPED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Bash commands that betray a write. **This is a heuristic on a command string, and its recall is
 * deliberately unmeasured here** — a subagent writing via `python -c`, an unusual redirect, or an MCP
 * filesystem tool produces no match at all. That is why ADR 163's headline metric is a **lower bound,
 * not a rate**, and why a separate recall arm exists to put an error bar on it. Do not add cleverness
 * to this list expecting completeness; add it, then re-measure recall.
 */
const BASH_WRITE_PATTERNS: RegExp[] = [
  /(^|[^>])>>?[^>]/, //  shell redirection into a file (`… > f`, `… >> f`)
  /\btee\b/,
  /\bsed\b[^|]*\s-i\b/,
  /\b(rm|mv|cp|mkdir|touch|truncate|install|chmod|chown|ln)\b/,
  /\bgit\s+(commit|push|merge|rebase|apply|checkout|switch|restore|reset|clean|rm|mv|tag)\b/,
  /\b(npm|pnpm|yarn)\s+(install|add|remove|link|publish)\b/,
  /\bdd\b/,
  /\bpatch\b/,
];

/**
 * Is this call write-shaped (ADR 163)? Reads must never fire — nick's read/write asymmetry blesses
 * read-only fan-out explicitly, and an `Explore` sweep's hundreds of reads would swamp the ledger for
 * nothing. Path-shaped write tools are exact; `Bash` is the heuristic documented above.
 */
export function isWriteShaped(call: GateToolCall): boolean {
  if (WRITE_SHAPED_TOOLS.has(call.tool)) return true;
  if (call.tool !== 'Bash') return false;
  const command = call.command?.trim();
  if (!command) return false;
  return BASH_WRITE_PATTERNS.some((re) => re.test(command));
}
