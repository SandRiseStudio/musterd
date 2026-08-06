import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  type Binding,
  bindingSeat,
  type Capabilities,
  effectiveCapabilities,
  type EnforcementClass,
  type EnforcementPosture,
  type Lifecycle,
  type MemberKind,
  type PolicyOverride,
  parseSeatFile,
  type SeatFile,
  serializeSeat,
  serializeTeam,
  type TeamFile,
} from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import {
  excludeCredentialFromGit,
  findBinding,
  loadConfig,
  recordRosterHome,
  rememberIdentity,
  saveBinding,
  saveConfig,
} from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { hint, success, sym } from '../render/ui.js';
import { writeSeatFile } from '../roster.js';
import { findWorkspaceDir, inherited, resolve } from './helpers.js';

export async function teamCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'create') return teamCreate(parsed);
  if (sub === 'add') return teamAdd(parsed);
  if (sub === 'observe') return teamObserve(parsed);
  if (sub === 'credential') return teamCredential(parsed);
  if (sub === 'remove') return teamRemove(parsed);
  if (sub === 'archive') return teamArchive(parsed);
  if (sub === 'export') return teamExport(parsed);
  if (sub === 'policy') return teamPolicy(parsed);
  throw new CliError(
    'usage: musterd team <create|add|observe|credential|remove|archive|export|policy> ...',
    2,
  );
}

/**
 * `musterd team policy [--reseat-known-agents on|off] [--ask-fallback-to-nonadmin on|off]
 * [--review-loop on|off] [--dispatch-loop on|off] [--sweep-loop on|off]
 * [--ask-slack-webhook <url|off>]` — show or set the
 * team governance policy (admin-only, audited `policy.change`). ADR 146: `--reseat-known-agents on`
 * opts the team into dogfood-mode re-seat — an already-held agent seat re-occupies without an admin
 * decision. ADR 147: `--ask-fallback-to-nonadmin on` lets an admin-unanswered ask fall back to
 * non-admin humans past its tier timeout. ADR 191: `--review-loop on` arms the review work-order
 * loop; ADR 199: `--dispatch-loop on` arms the dispatch work-order loop; ADR 229: `--sweep-loop on`
 * arms the acceptance backstop, which closes a lane nobody accepted after the grace. ADR 149:
 * `--ask-slack-webhook <url>` points the ask stream's loud reach at a Slack incoming webhook (`off`
 * clears it); the URL is a secret, so the display masks it to its host. ADR 248:
 * `--seeds-relay <url> --seeds-token <token>` points the seeds ingest loop at the capture relay
 * (`--seeds-relay off` clears both); the token is a secret and never displayed. Reads → merges the named
 * knob(s) → POSTs the policy (the residency-policy read-merge-write pattern), so setting one knob
 * never clobbers the wake-policy defaults.
 */
async function teamPolicy(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const { policy: current, stored } = await http.getPolicy(team);

  // Read-merge-write each named knob (never clobber the wake-policy defaults). Both flags may be set
  // in one call; onOff throws on a value that is neither on nor off.
  //
  // ADR 185: merge into the SPARSE `stored` doc, not the defaults-applied `current`. Merging into
  // `current` is what re-materialized every default into the row on each write, killing the schema
  // default for the team. `delete merged.ask_slack_webhook` now genuinely unsets the key.
  const merged: PolicyOverride = { ...stored };
  let changed = false;
  const reseat = onOff(parsed.flags['reseat-known-agents'], '--reseat-known-agents');
  if (reseat !== undefined) {
    merged.standing_reseat_known_agents = reseat;
    changed = true;
  }
  // ADR 147: the ask stream's configurable (never automatic) fallback — an admin-unanswered ask may fall
  // back to non-admin humans on the same timeout/risk machinery.
  const askFallback = onOff(parsed.flags['ask-fallback-to-nonadmin'], '--ask-fallback-to-nonadmin');
  if (askFallback !== undefined) {
    merged.ask_fallback_to_nonadmin = askFallback;
    changed = true;
  }
  // ADR 191 / 199: work-order loops remain dark until a Team admin explicitly arms each one.
  // Preserve the sibling loop switch (and every unrelated sparse policy setting) while changing only
  // the named one — never clobber review when flipping dispatch, or vice versa.
  const reviewLoop = onOff(parsed.flags['review-loop'], '--review-loop');
  if (reviewLoop !== undefined) {
    merged.loops = { ...merged.loops, review: reviewLoop };
    changed = true;
  }
  const dispatchLoop = onOff(parsed.flags['dispatch-loop'], '--dispatch-loop');
  if (dispatchLoop !== undefined) {
    merged.loops = { ...merged.loops, dispatch: dispatchLoop };
    changed = true;
  }
  const sweepLoop = onOff(parsed.flags['sweep-loop'], '--sweep-loop');
  if (sweepLoop !== undefined) {
    merged.loops = { ...merged.loops, sweep: sweepLoop };
    changed = true;
  }
  // ADR 149: the ask stream's Slack delivery — a webhook URL, or `off` to clear it (delete the key so
  // the daemon's "unset = no outbound call ever" default is restored, not stored as an empty string).
  const webhook = flagStr(parsed.flags, 'ask-slack-webhook');
  if (webhook !== undefined) {
    if (webhook === 'off') {
      delete merged.ask_slack_webhook;
    } else {
      if (!/^https:\/\//.test(webhook)) {
        throw new CliError('usage: musterd team policy --ask-slack-webhook <https url | off>', 2);
      }
      merged.ask_slack_webhook = webhook;
    }
    changed = true;
  }
  // ADR 248: seeds ingest — the relay the daemon pulls raw captured ideas from. Two keys set
  // together (`--seeds-relay <url> --seeds-token <token>`), `--seeds-relay off` clears both (delete,
  // not empty string, restoring the daemon's "unset = no outbound call ever" default). The token is
  // a secret with the webhook's handling: masked on display, never exported.
  const seedsRelay = flagStr(parsed.flags, 'seeds-relay');
  const seedsToken = flagStr(parsed.flags, 'seeds-token');
  if (seedsRelay !== undefined) {
    if (seedsRelay === 'off') {
      delete merged.seeds_relay_url;
      delete merged.seeds_relay_token;
    } else {
      if (!/^https:\/\//.test(seedsRelay) || seedsToken === undefined) {
        throw new CliError(
          'usage: musterd team policy --seeds-relay <https url | off> --seeds-token <token>',
          2,
        );
      }
      merged.seeds_relay_url = seedsRelay;
      merged.seeds_relay_token = seedsToken;
    }
    changed = true;
  }
  // ADR 150: the enforcement class table — the opt-in PreToolUse gate declaration. `--enforce-surface`
  // (contended surfaces, Gate A) and `--enforce-action` (costly actions, Gate B) upsert classes by name
  // (re-declaring a name replaces it); `--enforce-clear` empties the table. Posture defaults to `block`
  // (the flag is an explicit opt-in to enforce; pass `--enforce-posture warn` for the advisory tier).
  const enforceChanged = applyEnforcementFlags(merged, parsed);
  if (enforceChanged) changed = true;

  if (changed) {
    const { policy: updated } = await http.setPolicy(team, merged);
    process.stdout.write(
      success(
        `team policy updated — ${team}: re-seat known agents ${updated.standing_reseat_known_agents ? theme.accent('on') : 'off'}, ask fallback to non-admins ${updated.ask_fallback_to_nonadmin ? theme.accent('on') : 'off'}, review loop ${updated.loops.review ? theme.accent('on') : 'off'}, dispatch loop ${updated.loops.dispatch ? theme.accent('on') : 'off'}, sweep loop ${updated.loops.sweep ? theme.accent('on') : 'off'}`,
      ) + '\n',
    );
    if (updated.standing_reseat_known_agents)
      process.stdout.write(
        hint('a held agent seat now re-occupies without an admin decision (new seats stay gated)') +
          '\n',
      );
    if (updated.ask_fallback_to_nonadmin)
      process.stdout.write(
        hint(
          'an admin-unanswered ask may now fall back to non-admin humans past its tier timeout',
        ) + '\n',
      );
    if (updated.loops.sweep)
      process.stdout.write(
        hint(
          'a lane nobody accepts is now closed by the daemon after the grace, recorded review_swept and never verified',
        ) + '\n',
      );
    if (webhook !== undefined)
      process.stdout.write(
        hint(
          updated.ask_slack_webhook
            ? `asks now also post to Slack (${maskWebhook(updated.ask_slack_webhook)})`
            : 'Slack delivery for asks is off',
        ) + '\n',
      );
    if (seedsRelay !== undefined)
      process.stdout.write(
        hint(
          updated.seeds_relay_url
            ? `seeds ingest on — the daemon polls ${maskWebhook(updated.seeds_relay_url)} and opens a lane per captured seed`
            : 'seeds ingest is off',
        ) + '\n',
      );
    if (enforceChanged) {
      const n = updated.enforcement.classes.length;
      const blocking = updated.enforcement.classes.filter((c) => c.posture === 'block').length;
      process.stdout.write(
        hint(
          n === 0
            ? 'enforcement disabled — no classes declared (warn-never-block default restored)'
            : `enforcement: ${n} class(es) declared, ${blocking} at block — each seat's PreToolUse gate reads this`,
        ) + '\n',
      );
    }
    return 0;
  }

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ ...current, stored }) + '\n');
    return 0;
  }
  process.stdout.write(`${theme.accent('team policy')} — ${team}\n`);
  process.stdout.write(
    `  re-seat known agents: ${current.standing_reseat_known_agents ? theme.accent('on') : 'off'}${inherited(stored, 'standing_reseat_known_agents')}\n`,
  );
  process.stdout.write(
    `  ask fallback to non-admins: ${current.ask_fallback_to_nonadmin ? theme.accent('on') : 'off'}${inherited(stored, 'ask_fallback_to_nonadmin')}\n`,
  );
  process.stdout.write(
    `  review loop: ${current.loops.review ? theme.accent('on') : 'off'}${inherited(stored.loops, 'review')}\n`,
  );
  process.stdout.write(
    `  dispatch loop: ${current.loops.dispatch ? theme.accent('on') : 'off'}${inherited(stored.loops, 'dispatch')}\n`,
  );
  process.stdout.write(
    `  sweep loop: ${current.loops.sweep ? theme.accent('on') : 'off'}${inherited(stored.loops, 'sweep')}\n`,
  );
  process.stdout.write(
    `  allow pre-issued grants: ${current.allow_pre_issued_grants ? 'on' : 'off'}${inherited(stored, 'allow_pre_issued_grants')}\n`,
  );
  // ADR 149: the webhook URL is a secret — show only that it's set, and where it points (host).
  process.stdout.write(
    `  ask slack webhook: ${current.ask_slack_webhook ? theme.accent(maskWebhook(current.ask_slack_webhook)) : 'off'}${inherited(stored, 'ask_slack_webhook')}\n`,
  );
  // ADR 248: the relay URL shows its host; the token shows only that it is set.
  process.stdout.write(
    `  seeds relay: ${current.seeds_relay_url ? theme.accent(maskWebhook(current.seeds_relay_url)) : 'off'}${inherited(stored, 'seeds_relay_url')}\n`,
  );
  // ADR 150: the enforcement class table — the opt-in PreToolUse gate declaration.
  const classes = current.enforcement.classes;
  if (classes.length === 0) {
    process.stdout.write(`  enforcement: ${theme.meta('off (no classes declared)')}\n`);
  } else {
    process.stdout.write(`  enforcement: ${theme.accent(`${classes.length} class(es)`)}\n`);
    for (const c of classes) {
      const kind = c.kind === 'contended-surface' ? 'surface' : 'action';
      const posture = c.posture === 'block' ? theme.accent('block') : 'warn';
      process.stdout.write(`    · ${kind} ${c.class} [${c.match.join(', ')}] → ${posture}\n`);
    }
  }
  if (Object.keys(stored).length === 0)
    process.stdout.write(
      theme.meta('  every value is inherited — this team tracks the shipped defaults') + '\n',
    );
  process.stdout.write(theme.meta('  set: musterd team policy --reseat-known-agents on') + '\n');
  process.stdout.write(theme.meta('       musterd team policy --review-loop on') + '\n');
  process.stdout.write(theme.meta('       musterd team policy --dispatch-loop on') + '\n');
  process.stdout.write(
    theme.meta(
      "       musterd team policy --enforce-surface 'src/tariff.ts' --enforce-posture block",
    ) + '\n',
  );
  return 0;
}

/**
 * Apply the ADR 150 enforcement flags to `merged.enforcement` in place (read-merge-write). Returns true
 * if anything changed. `--enforce-clear` empties the table; `--enforce-surface <glob[,glob…]>` declares
 * contended-surface classes (Gate A); `--enforce-action <class=glob[;class=glob…]>` declares costly-action
 * classes (Gate B). Classes upsert by name (re-declaring a name replaces it), so a table is built across
 * calls. `--enforce-posture warn|block` (default block) applies to every class set in THIS invocation.
 */
function applyEnforcementFlags(
  merged: { enforcement?: { classes?: EnforcementClass[] | undefined } | undefined },
  parsed: Parsed,
): boolean {
  let changed = false;
  if (parsed.flags['enforce-clear'] === true) {
    // ADR 185: drop the key rather than storing `{classes: []}`. The empty table IS the default, so
    // an inherited enforcement and a stored-empty one behave identically — but only the first keeps
    // the row honest about what was chosen.
    delete merged.enforcement;
    changed = true;
  }
  const postureRaw = flagStr(parsed.flags, 'enforce-posture') ?? 'block';
  if (postureRaw !== 'warn' && postureRaw !== 'block') {
    throw new CliError('usage: --enforce-posture <warn | block> (default block)', 2);
  }
  const posture = postureRaw as EnforcementPosture;

  const upsert = (cls: EnforcementClass): void => {
    const classes = (merged.enforcement?.classes ?? []).filter((c) => c.class !== cls.class);
    classes.push(cls);
    merged.enforcement = { classes };
    changed = true;
  };

  const surfaces = flagStr(parsed.flags, 'enforce-surface');
  if (surfaces !== undefined) {
    for (const glob of surfaces
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      upsert({ class: glob, kind: 'contended-surface', match: [glob], posture });
    }
  }

  const actions = flagStr(parsed.flags, 'enforce-action');
  if (actions !== undefined) {
    for (const entry of actions
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const eq = entry.indexOf('=');
      if (eq <= 0) {
        throw new CliError(
          `usage: --enforce-action '<class>=<command-glob>' (got "${entry}") — e.g. 'force-push=git push --force*'`,
          2,
        );
      }
      const name = entry.slice(0, eq).trim();
      const glob = entry.slice(eq + 1).trim();
      if (!name || !glob) {
        throw new CliError(
          `--enforce-action needs both a class name and a glob (got "${entry}")`,
          2,
        );
      }
      upsert({ class: name, kind: 'costly-action', match: [glob], posture });
    }
  }
  return changed;
}

/** Mask a webhook URL to its host — enough to recognize the destination, never the secret path. */
function maskWebhook(url: string): string {
  try {
    return `set → ${new URL(url).host}`;
  } catch {
    return 'set';
  }
}

/** Parse an on/off flag value to a boolean, or undefined if the flag was absent; throws on a bad value. */
function onOff(raw: unknown, flag: string): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === true || raw === 'on' || raw === 'true' || raw === 'yes') return true;
  if (raw === 'off' || raw === 'false' || raw === 'no') return false;
  throw new CliError(`usage: musterd team policy ${flag} <on|off>`, 2);
}

async function teamCreate(parsed: Parsed): Promise<number> {
  const slug = parsed.positionals[1];
  if (!slug)
    throw new CliError('usage: musterd team create <slug> [--as <you>] [--role <role>]', 2);
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const name = flagStr(parsed.flags, 'as') ?? defaultUser();
  const role = flagStr(parsed.flags, 'role');
  const display = flagStr(parsed.flags, 'display');
  const http = new HttpClient({ server });
  const res = await http.createTeam(slug, { name, ...(role ? { role } : {}) }, display);

  // v0.3 (ADR 075): the creator is the team's first admin and authenticates with their **human
  // credential** (mscr_) from the composite mint (SPEC A.7); the team **agent key** (mskey_) is what
  // agents claim with, handed out separately. `res.agent_key`/`res.human_credential` are shown once.
  const credential = res.human_credential as string;
  config.server = server;
  config.current = slug;
  config.agentKeys[slug] = res.agent_key as string; // ADR 075: keep the team key for `musterd agent`
  config.identities[slug] = { name, key: credential, surface: 'cli' };
  rememberIdentity(config, { team: slug, name, key: credential, surface: 'cli' }); // ADR 059 vault
  saveConfig(config);
  // Auto-bind the creating folder so it's immediately *active* — you can act here without `--as`,
  // while every other unbound folder stays read-only (ADR 036). The binding carries the folder's
  // claim secret (here the creator's credential) so resolveIdentity yields the admin here.
  const binding: Binding = {
    server,
    team: slug,
    agent_key: credential,
    surface: 'cli',
    claim: { mode: 'seat', name },
  };
  saveBinding(process.cwd(), binding);

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ team: res.team, member: res.member }) + '\n');
    return 0;
  }
  process.stdout.write(success(`team "${slug}" created`, { next: 'musterd status' }) + '\n');
  process.stdout.write(
    `  on the team as ${theme.memberName(name, 'human')} ${theme.meta(`(human${role ? `, ${role}` : ''})`)}\n`,
  );
  process.stdout.write(theme.meta('bound this folder as your seat — act here with no --as') + '\n');
  process.stdout.write(hint('add members: musterd team add <name> --kind agent') + '\n');
  return 0;
}

async function teamAdd(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  const kind = flagStr(parsed.flags, 'kind') as MemberKind | undefined;
  if (!name || (kind !== 'agent' && kind !== 'human')) {
    throw new CliError('usage: musterd team add <name> --kind <agent|human> [--role <role>]', 2);
  }
  // Adding a member is an admin act, so it needs an *active* identity (binding/env/--as), not just
  // an ambient global-config default (ADR 036). `resolve()` enforces that.
  const { team, http } = resolve(parsed.flags);

  const role = flagStr(parsed.flags, 'role');
  const lifecycle = flagStr(parsed.flags, 'lifecycle') as Lifecycle | undefined;
  const until = flagStr(parsed.flags, 'until');
  // ADR 058 §5: for a file-backed team the file is the single writer — write `seats/<name>.toml`
  // first, then `addMember` becomes project-and-return (the daemon reconciles the file, mints, hands
  // back the token). A db-only team has no roster home, so this is skipped and the daemon originates.
  const home = loadConfig().rosterHome[team];
  if (home) {
    writeSeatFile(home, name, { kind, role, lifecycle, until });
  }
  const res = await http.addMember(team, {
    name,
    kind,
    role,
    ...(lifecycle ? { lifecycle } : {}),
    ...(until ? { lifecycle_until: Date.parse(until) } : {}),
  });

  if (parsed.flags['json']) {
    // v0.3 (ADR 069): a human gets an mscr_ credential (shown once); an agent is credential-less and
    // claims with the team agent key. The vestigial `token` is no longer an authenticator.
    process.stdout.write(
      JSON.stringify({
        member: res.member,
        ...(res.human_credential ? { human_credential: res.human_credential } : {}),
      }) + '\n',
    );
    return 0;
  }
  process.stdout.write(
    success(
      `added ${theme.memberName(name, kind)} ${theme.meta(`(${kind}${role ? `, ${role}` : ''})`)} to ${team}`,
    ) + '\n',
  );
  if (kind === 'agent') {
    // Agents authenticate with the team agent key (mskey_) + a seat claim (ADR 069/075) — not a per-seat
    // token. The simplest hand-off is `musterd agent` in the agent's folder (isolated worktree + MCP).
    const agentKey = loadConfig().agentKeys[team] ?? 'mskey_…';
    process.stdout.write(theme.meta('connect this agent via MCP with the team agent key:') + '\n');
    process.stdout.write(
      theme.meta(
        `  MUSTERD_TEAM=${team} MUSTERD_AGENT_KEY=${agentKey} MUSTERD_CLAIM=seat:${name} MUSTERD_SURFACE=claude-code`,
      ) + '\n',
    );
    process.stdout.write(
      theme.meta('— or skip the wiring: ') +
        theme.accent(`musterd agent ${name} --team ${team}`) +
        theme.meta(` builds an isolated worktree + MCP for it (safe to run now).`) +
        '\n',
    );
  } else {
    // Humans authenticate with their own credential (mscr_), shown once here.
    process.stdout.write(
      theme.meta(`they authenticate with their credential (shown once — store it now):`) + '\n',
    );
    process.stdout.write(
      theme.meta(`  musterd join ${team} --as ${name} --key ${res.human_credential}`) + '\n',
    );
  }
  return 0;
}

/**
 * Provision a read-only observer seat (ADR 063): a seat that watches the whole-team firehose from the
 * dashboard but is hidden from the roster/counts/presence and cannot send. Resolved like `team export`
 * (server + slug from flags/config, no active identity needed) since the dashboard provisions it
 * out-of-band; observers are db-only even on a file-backed team, so no seat file is written.
 */
async function teamObserve(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  if (!name) throw new CliError('usage: musterd team observe <name> [--team <slug>]', 2);
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const team = flagStr(parsed.flags, 'team') ?? config.current;
  if (!team) throw new CliError('no team — pass --team <slug> or set a current team', 2);
  const http = new HttpClient({ server });
  const res = await http.addMember(team, { name, kind: 'human', observer: true });

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ member: res.member, token: res.token }) + '\n');
    return 0;
  }
  process.stdout.write(
    success(
      `observer "${name}" ready for ${team} ${theme.meta('— read-only, hidden from the roster')}`,
    ) + '\n',
  );
  process.stdout.write(
    hint(`open /live and connect:  team ${team}   as ${name}   token ${res.token}`) + '\n',
  );
  return 0;
}

/**
 * `musterd team credential <name>` — re-issue a human's `mscr_` credential, shown once.
 *
 * The recovery verb for the state that has no other exit: `credential_hash` is one column and
 * minting overwrites it, so a human who lost their credential could not authenticate, could not
 * `musterd board`, and could not even be re-added (`POST /members` conflicts on a live member).
 *
 * Deliberately identity-free — it resolves the team like `team export` (flags/config, no `resolve()`)
 * because requiring an active identity would be circular: the caller's problem IS that they have
 * none. The daemon holds the real bar (localhost, or an admin credential off-host).
 *
 * When the local machine already knows this (team, name), the rotate repairs what it knows in the
 * same breath — the vault entry, the team's active identity, and the cwd binding's key — so ADR
 * 170's `musterd board` works immediately afterwards with nothing pasted anywhere. Rotating
 * *someone else's* credential touches none of that: it is a secret for another person, not a
 * sign-in for this machine.
 */
async function teamCredential(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  if (!name)
    throw new CliError('usage: musterd team credential <name> [--team <slug>] [--server <url>]', 2);
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const team = flagStr(parsed.flags, 'team') ?? config.current;
  if (!team) throw new CliError('no team — pass --team <slug> or set a current team', 2);
  const http = new HttpClient({ server });
  const res = await http.rotateCredential(team, name);

  const repaired = repairLocalCredential(config, team, res.member, res.credential);

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({ member: res.member, credential: res.credential, repaired }) + '\n',
    );
    return 0;
  }
  process.stdout.write(
    success(`re-issued ${theme.memberName(res.member, 'human')}'s credential for ${team}`) + '\n',
  );
  process.stdout.write(
    theme.meta('the previous one stops working at their next claim — shown once, store it now:') +
      '\n',
  );
  process.stdout.write(`  ${res.credential}\n`);
  if (repaired.identity || repaired.binding) {
    // Say exactly what was rewritten: this command hands out a secret, so silent local writes would
    // be the wrong kind of convenience.
    const where = [
      ...(repaired.identity ? ['this machine’s saved identity'] : []),
      ...(repaired.binding ? ['this folder’s binding'] : []),
    ].join(' + ');
    process.stdout.write(theme.meta(`updated ${where} — nothing to paste`) + '\n');
    process.stdout.write(hint('open the board signed in: musterd board') + '\n');
  } else {
    process.stdout.write(
      hint(`hand it over: musterd join ${team} --as ${res.member} --key <the line above>`) + '\n',
    );
  }
  return 0;
}

/**
 * Repair what this machine holds for `(team, name)` after a rotate — the vault entry (ADR 059), the
 * team's active identity slot, and the workspace binding when it names that same seat. Every write
 * is conditional on the seat already being known here: a rotate must never *create* a local identity
 * for someone, only refresh one that already existed and just went stale.
 *
 * Exported for tests; returns what it actually changed so the caller can say so.
 */
export function repairLocalCredential(
  config: ReturnType<typeof loadConfig>,
  team: string,
  name: string,
  credential: string,
): { identity: boolean; binding: boolean } {
  let identity = false;
  const known = config.knownIdentities.find((i) => i.team === team && i.name === name);
  if (known) {
    rememberIdentity(config, { ...known, key: credential });
    identity = true;
  }
  const active = config.identities[team];
  if (active && active.name === name) {
    config.identities[team] = { ...active, key: credential };
    identity = true;
  }
  if (identity) saveConfig(config);

  // The binding is per-folder and holds the seat's bearer secret in `agent_key` (for a human folder
  // that is their mscr_ — see helpers.gather). Rewrite it only when this folder is bound to the very
  // seat that rotated, and only for the same team.
  let binding = false;
  const dir = findWorkspaceDir();
  const current = dir ? findBinding(dir) : null;
  if (dir && current && current.team === team && bindingSeat(current) === name) {
    saveBinding(dir, { ...current, agent_key: credential });
    binding = true;
  }
  return { identity, binding };
}

/**
 * Soft-remove a member from a team's roster (ADR 019). The sanctioned way to clear a mistaken or
 * stale member instead of editing the daemon's DB: it sets `left_at`, so the member drops off every
 * roster/auth path while its message history + provenance survive. Idempotent — an already-removed
 * (or never-existing) member is a clean `not_found`, not an error stack.
 */
async function teamRemove(parsed: Parsed): Promise<number> {
  const name = parsed.positionals[1];
  if (!name) throw new CliError('usage: musterd team remove <name>', 2);
  const { team, http } = resolve(parsed.flags);
  const res = await http.removeMember(team, name);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`removed ${theme.memberName(res.member, res.kind)} from ${team}`) + '\n',
  );
  process.stdout.write(theme.meta('off the roster; message history is kept') + '\n');
  return 0;
}

/**
 * Soft-archive a team (the inverse of `team create`). Admin-only + audited `team.archive`: sets
 * `archived_at`, so the team drops off status/rosters and refuses auth while its history survives —
 * the sanctioned cleanup for a junk/finished team instead of SQL against the daemon's db. The slug is
 * always explicit (never the ambient bound team) so a fat-fingered bare `team archive` can't take
 * down the team you're working on; auth still needs an admin identity for THAT team (its creator
 * credential is in the vault from `team create` — name it with `--as` if you're bound elsewhere).
 */
async function teamArchive(parsed: Parsed): Promise<number> {
  const slug = parsed.positionals[1];
  if (!slug) throw new CliError('usage: musterd team archive <slug> [--as <admin>]', 2);
  const { http } = resolve({ ...parsed.flags, team: slug });
  const res = await http.archiveTeam(slug);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res) + '\n');
    return 0;
  }
  process.stdout.write(success(`archived team "${slug}"`) + '\n');
  process.stdout.write(
    theme.meta('off every roster and status surface; history is kept (soft archive)') + '\n',
  );
  return 0;
}

/** The roster fields `team export` needs from a live member (a subset of MemberSummary). */
export interface RosterMember {
  name: string;
  kind: MemberKind;
  role: string;
  lifecycle: Lifecycle;
  lifecycle_until?: number | null;
  /** The seat's EFFECTIVE capabilities. Admin-visible only, and load-bearing — see below. */
  capabilities?: Capabilities | undefined;
}

/**
 * Project a live roster into canonical durable files (ADR 058 / migration-bootstrap.md), keyed by
 * path. Pure + token-free — no secret ever reaches a file. Runs the format-layer parity self-check
 * (serialize → parse reproduces each seat's identity) so a serializer bug aborts the export instead
 * of silently writing files that don't reproduce the roster.
 */
/**
 * Capability fields a round-trip through this seat file would LOSE, for a seat with no role.
 *
 * Only decidable without a role: the ceiling is then the generalist default, which both sides know,
 * so `effectiveCapabilities({}, override)` here is exactly what reconcile will compute there. A
 * seat carrying a role is not judged — its ceiling lives in the db and is not readable from the CLI.
 */
function capabilitiesLostOnReconcile(
  seat: SeatFile,
  parsedBack: SeatFile,
  live: Capabilities | undefined,
): string[] {
  if ((seat.role ?? '') !== '' || !live) return [];
  const rebuilt = effectiveCapabilities({}, parsedBack.capabilities ?? {});
  return (Object.keys(live) as Array<keyof Capabilities>).filter(
    (k) => JSON.stringify(rebuilt[k]) !== JSON.stringify(live[k]),
  );
}

/**
 * The capability fields that differ from the generalist default, or undefined when none do. Keeps a
 * seat file to the lines a reviewer needs — the point of putting the roster in git in the first place.
 */
function capabilityDiff(caps: Capabilities | undefined): Capabilities | undefined {
  if (!caps) return undefined;
  const g = effectiveCapabilities({}, {});
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(g) as Array<keyof Capabilities>) {
    if (JSON.stringify(caps[k]) !== JSON.stringify(g[k])) out[k] = caps[k];
  }
  return Object.keys(out).length > 0 ? (out as unknown as Capabilities) : undefined;
}

export function rosterToFiles(
  slug: string,
  members: RosterMember[],
): { teamToml: string; seatFiles: Record<string, string> } {
  const team: TeamFile = { slug, lifecycle: 'forever' };
  const seatFiles: Record<string, string> = {};
  for (const m of members) {
    const seat: SeatFile = { kind: m.kind, role: m.role ?? '' };
    if (m.lifecycle && m.lifecycle !== 'forever') {
      seat.lifecycle = m.lifecycle;
      if (m.lifecycle === 'until' && m.lifecycle_until) {
        seat.until = new Date(m.lifecycle_until).toISOString();
      }
    }
    // Capabilities are part of the roster, so a file set that omits them does not reproduce it.
    // Dropping them here is what silently de-admined revive on 2026-08-01: reconcile REBUILDS every
    // seat's capabilities from `effectiveCapabilities(roleDefaults[role], seat.capabilities)`, so a
    // seat file carrying only kind+role tells it to rebuild the creator as a plain generalist — and
    // the team ended up with no admin at all, with no audit row and no way back through the API.
    //
    // Writing the effective set is safe in both directions: an override can only NARROW, so this
    // can never grant a seat more than its role allows; and where the role already grants it, the
    // clamp returns the same value. What it cannot do is manufacture authority the role withholds —
    // which is exactly the case the parity check below refuses rather than writes.
    // Only the fields that differ from the generalist default, so a roster stays readable in a diff
    // — these files exist to be reviewed in git (ADR 058), and seven lines per seat restating the
    // defaults would bury the one line that matters. Omitted fields fall back to the role ceiling,
    // which is what reconcile does anyway, so a plain seat still writes exactly kind+role.
    const narrowed = capabilityDiff(m.capabilities);
    if (narrowed) seat.capabilities = narrowed;
    const text = serializeSeat(seat);
    const back = parseSeatFile(text, m.name);
    if (
      back.kind !== seat.kind ||
      (back.role ?? '') !== (seat.role ?? '') ||
      back.lifecycle !== seat.lifecycle ||
      back.until !== seat.until
    ) {
      throw new CliError(
        `parity check failed for seat "${m.name}" — the roster files would not reproduce the live roster`,
        1,
      );
    }
    // The capability half of the parity check, for the case this side can actually decide. With no
    // role the ceiling IS the generalist default, which is known here, so reconcile's result is
    // reproducible exactly — and any field that would come back lower is authority the export is
    // about to destroy. A seat WITH a role is left to the server: role defaults live only in the db
    // (there is no `/roles` read), and guessing a ceiling we cannot see is how this bug was written
    // the first time. Reconcile's own zero-admin check is the backstop there.
    const lost = capabilitiesLostOnReconcile(seat, back, m.capabilities);
    if (lost.length > 0) {
      throw new CliError(
        `export would DESTROY authority on seat "${m.name}": [${lost.join(', ')}] cannot survive a ` +
          `seat file, because a seat override only narrows and "${m.name}" holds no role granting ` +
          `them. Give the seat a role whose capabilities carry them, then export again. ` +
          `(Writing these files would leave the roster quietly weaker than the live team.)`,
        1,
      );
    }
    seatFiles[`${m.name}.toml`] = text;
  }
  return { teamToml: serializeTeam(team), seatFiles };
}

/**
 * One-time db→file inversion (migration-bootstrap.md): read the live roster, write the canonical
 * `.musterd/` files in this folder, and register it as the team's roster home (the cutover signal).
 * Refuses if `team.toml` already exists (idempotency without clobber). No token touches a file; the
 * very next reconcile is a no-op UPDATE that preserves every live token (D ≡ C by construction).
 */
async function teamExport(parsed: Parsed): Promise<number> {
  const slug = parsed.positionals[1];
  if (!slug) throw new CliError('usage: musterd team export <slug> [--to <dir>]', 2);
  // Where the roster lands (ADR 176 §1, increment 3): an explicit `--to` wins, else the team's own
  // home, else this folder. The default matters because "which repo owns the roster when several
  // touch one team" was migration-bootstrap.md's open question, and install-topology §4 answered it
  // by saying **no repo does** — the roster's home is the *team's* home. Exporting into whatever
  // folder you happened to stand in is how that question arose in the first place.
  //
  // `teamHome` and `rosterHome` still compose rather than merge: this changes only the DEFAULT
  // DESTINATION. Recording `rosterHome` — ADR 058's file-authoritative cutover signal — is unchanged
  // below, and having a home never implies the flip. Nor does exporting invent a home: a team with
  // no `teamHome` exports here, exactly as before.
  const explicitTo = flagStr(parsed.flags, 'to');
  const home = loadConfig().teamHome[slug];
  const dir = resolvePath(explicitTo ?? home ?? process.cwd());
  const musterdDir = join(dir, '.musterd');
  const teamFile = join(musterdDir, 'team.toml');
  if (existsSync(teamFile)) {
    throw new CliError(
      `"${slug}" already looks file-backed — ${teamFile} exists (refusing to clobber hand-edits)`,
      1,
    );
  }
  const config = loadConfig();
  const server = flagStr(parsed.flags, 'server') ?? config.server;
  const http = new HttpClient({ server });
  const { members } = await http.roster(slug);
  const { teamToml, seatFiles } = rosterToFiles(
    slug,
    members.map((m) => ({
      name: m.name,
      kind: m.kind,
      role: m.role,
      lifecycle: m.lifecycle,
      lifecycle_until: m.lifecycle_until ?? null,
      // Admin-visible only; when the roster does not carry them the seat file simply omits them and
      // reconcile keeps rebuilding from the role, exactly as before this change.
      capabilities: m.capabilities,
    })),
  );

  mkdirSync(join(musterdDir, 'seats'), { recursive: true });
  writeFileSync(teamFile, teamToml);
  for (const [fname, body] of Object.entries(seatFiles)) {
    writeFileSync(join(musterdDir, 'seats', fname), body);
  }
  recordRosterHome(config, slug, dir);
  saveConfig(config);

  // This command's last words are "git add + commit them", and the roster it just wrote shares
  // `.musterd/` with a live credential — so earn that instruction before giving it. Unconditional,
  // including when `dir` fell back to cwd and holds no binding: "a repo does not commit a musterd
  // credential" is true of that repo too, and a condition here is only a way to get it wrong later.
  const safeToCommit = excludeCredentialFromGit(dir);

  const count = Object.keys(seatFiles).length;
  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({
        slug,
        rosterHome: dir,
        credentialExcluded: safeToCommit,
        // Say WHY it landed there, so a default that moved the files somewhere other than the folder
        // you typed in is legible rather than surprising.
        destination: explicitTo ? 'flag' : home ? 'teamHome' : 'cwd',
        seats: Object.keys(seatFiles),
      }) + '\n',
    );
    return 0;
  }
  const where = dir === process.cwd() ? '.musterd/' : join(dir, '.musterd');
  process.stdout.write(
    success(`exported "${slug}" roster → ${where} (${count} seat${count === 1 ? '' : 's'})`, {
      next: 'musterd reload',
    }) + '\n',
  );
  if (!explicitTo && home) {
    process.stdout.write(
      theme.meta(`the roster's home is the team's home, not a project repo — ${dir} (ADR 176).`) +
        '\n',
    );
  }
  if (safeToCommit) {
    process.stdout.write(
      theme.meta(
        'these files are now the source of truth — git add + commit them for a reviewable roster.',
      ) + '\n',
    );
  } else {
    // The roster is written and the export succeeded; what failed is the guard. Say so instead of
    // handing over an instruction that would commit a credential.
    process.stdout.write(
      theme.warn(
        `${sym.warn} could not write ${join(dir, '.gitignore')} — not telling you to commit yet: ` +
          `${join('.musterd', 'binding.json')} there holds a live credential. Exclude it, then commit the roster.`,
      ) + '\n',
    );
  }
  process.stdout.write(
    theme.meta(
      'provisioning (team add/claim) is file-backed immediately; `musterd reload` makes the daemon track edits.',
    ) + '\n',
  );
  return 0;
}

function defaultUser(): string {
  return process.env['USER'] ?? process.env['USERNAME'] ?? 'me';
}
