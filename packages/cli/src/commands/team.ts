import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  type Binding,
  bindingSeat,
  type Capabilities,
  effectiveCapabilities,
  type EnforcementClass,
  type EnforcementPosture,
  LaneStakesSchema,
  type Lifecycle,
  type MemberKind,
  type PolicyOverride,
  parseSeatFile,
  type SeatFile,
  serializeSeat,
  serializeTeam,
  type StakesDefault,
  TOKEN_PREFIXES,
  GuardianClassSchema,
  GuardianTierSchema,
  type TeamFile,
} from '@musterd/protocol';
import { flagStr, fmtDurationMs, parseDurationMs, type Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import {
  excludeCredentialFromGit,
  findBinding,
  loadConfig,
  readBindingAt,
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
  if (sub === 'agent-key') return teamAgentKey(parsed);
  if (sub === 'bootstrap') return teamBootstrap(parsed);
  if (sub === 'remove') return teamRemove(parsed);
  if (sub === 'archive') return teamArchive(parsed);
  if (sub === 'export') return teamExport(parsed);
  if (sub === 'policy') return teamPolicy(parsed);
  throw new CliError(
    'usage: musterd team <create|add|observe|credential|agent-key|bootstrap|remove|archive|export|policy> ...',
    2,
  );
}

/** Admin lifecycle for ADR 344's independently scoped bootstrap credentials. */
async function teamBootstrap(parsed: Parsed): Promise<number> {
  const action = parsed.positionals[1];
  const { team, http } = resolve(parsed.flags);
  const json = parsed.flags['json'] === true;

  if (action === 'mint') {
    const scopes = [
      ['claim_seat', flagStr(parsed.flags, 'seat')],
      ['claim_role', flagStr(parsed.flags, 'role')],
      ['host', flagStr(parsed.flags, 'host')],
    ].filter((entry): entry is [string, string] => entry[1] !== undefined);
    if (scopes.length !== 1) {
      throw new CliError(
        'bootstrap mint needs exactly one of --seat <name>, --role <name>, or --host <label>',
        2,
      );
    }
    const expiresIn = flagStr(parsed.flags, 'expires-in');
    const expiresAt = expiresIn
      ? Date.now() + parseDurationMs(expiresIn, '--expires-in')
      : undefined;
    const [use, target] = scopes[0]!;
    const minted = await http.mintBootstrapCredential(team, {
      use: use as 'claim_seat' | 'claim_role' | 'host',
      target,
      ...(flagStr(parsed.flags, 'label') ? { label: flagStr(parsed.flags, 'label')! } : {}),
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    });
    if (json) {
      process.stdout.write(JSON.stringify(minted) + '\n');
      return 0;
    }
    process.stdout.write(
      success(`minted ${minted.credential.use} bootstrap credential for ${target}`) + '\n',
    );
    process.stdout.write(theme.meta('shown once — store it in the intended harness now:') + '\n');
    process.stdout.write(`  ${minted.agent_key}\n`);
    process.stdout.write(theme.meta(`credential id: ${minted.credential.id}`) + '\n');
    return 0;
  }

  if (action === 'list') {
    const inventory = await http.listBootstrapCredentials(team);
    if (json) {
      process.stdout.write(JSON.stringify(inventory) + '\n');
      return 0;
    }
    if (inventory.credentials.length === 0) {
      process.stdout.write(theme.meta(`no bootstrap credentials on ${team}`) + '\n');
      return 0;
    }
    for (const credential of inventory.credentials) {
      const target = credential.target ? ` ${credential.target}` : '';
      const label = credential.label ? ` · ${credential.label}` : '';
      process.stdout.write(
        `${credential.id}  ${credential.state}  ${credential.use}${target}${label}\n`,
      );
    }
    return 0;
  }

  if (action === 'revoke') {
    const id = parsed.positionals[2];
    if (!id) throw new CliError('usage: musterd team bootstrap revoke <credential-id>', 2);
    const result = await http.revokeBootstrapCredential(team, id);
    if (json) process.stdout.write(JSON.stringify(result) + '\n');
    else process.stdout.write(success(`revoked bootstrap credential ${id}`) + '\n');
    return 0;
  }

  throw new CliError(
    'usage: musterd team bootstrap <mint|list|revoke> [--seat|--role|--host ...]',
    2,
  );
}

/**
 * `musterd team policy [--reseat-known-agents on|off] [--ask-fallback-to-nonadmin on|off]
 * [--review-loop on|off] [--dispatch-loop on|off] [--sweep-loop on|off]
 * [--ask-slack-webhook <url|off>] [--stakes-default <surface>=<low|normal|high>|off]
 * [--guardian-tier <class>=<observe|alert|auto>|off]` — show or set the
 * team governance policy (admin-only, audited `policy.change`). ADR 146: `--reseat-known-agents on`
 * opts the team into dogfood-mode re-seat — an already-held agent seat re-occupies without an admin
 * decision. ADR 147: `--ask-fallback-to-nonadmin on` lets an admin-unanswered ask fall back to
 * non-admin humans past its tier timeout. ADR 191: `--review-loop on` arms the review work-order
 * loop; ADR 199: `--dispatch-loop on` arms the dispatch work-order loop; ADR 229: `--sweep-loop on`
 * arms the acceptance backstop, which closes a lane nobody accepted after the grace. ADR 149:
 * `--ask-slack-webhook <url>` points the ask stream's loud reach at a Slack incoming webhook (`off`
 * clears it); the URL is a secret, so the display masks it to its host. ADR 248:
 * `--seeds-relay <url> --seeds-token <token>` points the seeds ingest loop at the capture relay
 * (`--seeds-relay off` clears both); the token is a secret and never displayed. ADR 244:
 * `--stakes-default <surface>=<low|normal|high>` upserts a default-stakes rule (same surface
 * replaces in place; a new surface appends); `--stakes-default off` clears the list. Reads → merges the named
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
  // ADR 268 (incident spec §5): shared-blocker convergence. `--incident off` is an OPT-OUT — unlike
  // the loops above, clustering ships on, so this flag exists to turn shipped behaviour off. The two
  // wake knobs are the opt-INs: they spend, and wake accounting cannot yet see what an unreported
  // lease cost, so no team gets a new wake edge without an admin asking for it by name.
  const incidentOn = onOff(parsed.flags['incident'], '--incident');
  if (incidentOn !== undefined) {
    merged.incident = { ...merged.incident, enabled: incidentOn };
    changed = true;
  }
  const incidentThreshold = flagStr(parsed.flags, 'incident-threshold');
  if (incidentThreshold !== undefined) {
    const n = Number(incidentThreshold);
    if (!Number.isInteger(n) || n < 2) {
      throw new CliError(
        'usage: musterd team policy --incident-threshold <n ≥ 2>  (one seat is not a cluster)',
        2,
      );
    }
    merged.incident = { ...merged.incident, cluster_threshold: n };
    changed = true;
  }
  const claimWindow = flagStr(parsed.flags, 'incident-claim-window');
  if (claimWindow !== undefined) {
    merged.incident = {
      ...merged.incident,
      claim_window_ms: parseDurationMs(claimWindow, '--incident-claim-window'),
    };
    changed = true;
  }
  const fallbackRole = flagStr(parsed.flags, 'incident-fallback-role');
  if (fallbackRole !== undefined) {
    if (!fallbackRole.trim()) {
      throw new CliError('usage: musterd team policy --incident-fallback-role <role>', 2);
    }
    merged.incident = { ...merged.incident, fallback_role: fallbackRole.trim() };
    changed = true;
  }
  const wakeOnRoute = onOff(parsed.flags['incident-wake-on-route'], '--incident-wake-on-route');
  if (wakeOnRoute !== undefined) {
    merged.incident = { ...merged.incident, wake_on_route: wakeOnRoute };
    changed = true;
  }
  const wakeOnResolve = onOff(
    parsed.flags['incident-wake-on-resolve'],
    '--incident-wake-on-resolve',
  );
  if (wakeOnResolve !== undefined) {
    merged.incident = { ...merged.incident, wake_on_resolve: wakeOnResolve };
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
  const stakesDefaultChanged = applyStakesDefaultFlag(merged, parsed);
  if (applyGuardianTierFlag(merged, parsed)) changed = true;
  if (stakesDefaultChanged) changed = true;

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
    if (stakesDefaultChanged) {
      const rules = updated.stakes_defaults;
      process.stdout.write(
        hint(
          rules.length === 0
            ? "stakes defaults off — every lane opens at the worker's declaration (or normal)"
            : `stakes defaults: ${rules.map((r) => `${r.surface} → ${r.stakes}`).join(', ')} — first match wins; mixed-surface lanes stay normal`,
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
  // ADR 268: the incident block reads as one line when it is at its defaults, and expands only where
  // an admin actually chose something — the knobs below `enabled` are noise on a team running stock.
  process.stdout.write(
    `  incident convergence: ${current.incident.enabled ? theme.accent('on') : 'off'}${inherited(stored.incident, 'enabled')}\n`,
  );
  if (current.incident.enabled) {
    process.stdout.write(
      `    cluster at: ${current.incident.cluster_threshold} distinct reporters${inherited(stored.incident, 'cluster_threshold')}\n`,
    );
    process.stdout.write(
      `    claim window: ${fmtDurationMs(current.incident.claim_window_ms)}, then role ${theme.accent(current.incident.fallback_role)}${inherited(stored.incident, 'claim_window_ms')}\n`,
    );
    process.stdout.write(
      `    wakes: on route ${current.incident.wake_on_route ? theme.accent('on') : 'off'}, on resolve ${current.incident.wake_on_resolve ? theme.accent('on') : 'off'}${inherited(stored.incident, 'wake_on_route')}\n`,
    );
  }
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
  // ADR 244: admin-set default stakes by surface. Empty is the shipped default (inert).
  const stakeRules = current.stakes_defaults;
  if (stakeRules.length === 0) {
    process.stdout.write(
      `  stakes defaults: ${theme.meta('off (no rules)')}${inherited(stored, 'stakes_defaults')}\n`,
    );
  } else {
    process.stdout.write(
      `  stakes defaults: ${theme.accent(`${stakeRules.length} rule(s)`)}${inherited(stored, 'stakes_defaults')}\n`,
    );
    for (const r of stakeRules) {
      process.stdout.write(`    · ${r.surface} → ${r.stakes}\n`);
    }
  }
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
  process.stdout.write(
    theme.meta("       musterd team policy --stakes-default 'packages/web/**=low'") + '\n',
  );
  return 0;
}

const STAKES_DEFAULT_USAGE =
  "usage: musterd team policy --stakes-default '<surface>=<low|normal|high> | off'";

/**
 * ADR 244 — upsert or clear `stakes_defaults` on the sparse stored policy. `--stakes-default off`
 * deletes the key (the empty list is the schema default). A `surface=stakes` value upserts by
 * surface: same path replaces in place (order preserved, first-match still wins); a new path
 * appends. Never replaces the whole list, so setting web-low cannot wipe a more specific rule.
 */
const GUARDIAN_TIER_USAGE =
  "usage: musterd team policy --guardian-tier '<class>=<observe|alert|auto> | off'";

/**
 * Guardian spec §4 — the autonomy dial. Upserts one class in the sparse `guardian_tiers` map
 * (absent classes read as the guardian's shipped defaults); `off` deletes the key so the schema
 * default (empty map) is restored, never stored as `{}` noise.
 */
function applyGuardianTierFlag(merged: PolicyOverride, parsed: Parsed): boolean {
  const raw = flagStr(parsed.flags, 'guardian-tier');
  if (raw === undefined) return false;
  if (raw === 'off') {
    delete merged.guardian_tiers;
    return true;
  }
  const eq = raw.indexOf('=');
  if (eq <= 0 || eq === raw.length - 1) throw new CliError(GUARDIAN_TIER_USAGE, 2);
  const cls = GuardianClassSchema.safeParse(raw.slice(0, eq).trim());
  const tier = GuardianTierSchema.safeParse(raw.slice(eq + 1).trim());
  if (!cls.success || !tier.success) throw new CliError(GUARDIAN_TIER_USAGE, 2);
  merged.guardian_tiers = { ...merged.guardian_tiers, [cls.data]: tier.data };
  process.stdout.write(`${theme.ok('✓')} guardian tier: ${cls.data} → ${tier.data}\n`);
  return true;
}

function applyStakesDefaultFlag(merged: PolicyOverride, parsed: Parsed): boolean {
  const raw = flagStr(parsed.flags, 'stakes-default');
  if (raw === undefined) return false;
  if (raw === 'off') {
    delete merged.stakes_defaults;
    return true;
  }
  const eq = raw.lastIndexOf('=');
  if (eq <= 0 || eq === raw.length - 1) {
    throw new CliError(STAKES_DEFAULT_USAGE, 2);
  }
  const surface = raw.slice(0, eq).trim();
  const stakesParsed = LaneStakesSchema.safeParse(raw.slice(eq + 1).trim());
  if (surface.length === 0 || !stakesParsed.success) {
    throw new CliError(STAKES_DEFAULT_USAGE, 2);
  }
  const rule: StakesDefault = { surface, stakes: stakesParsed.data };
  const rules = [...(merged.stakes_defaults ?? [])];
  const i = rules.findIndex((r) => r.surface === surface);
  if (i >= 0) rules[i] = rule;
  else rules.push(rule);
  merged.stakes_defaults = rules;
  return true;
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
    throw new CliError(
      'usage: musterd team create <slug> [--as <you>] [--role <role>] [--switch]',
      2,
    );
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
  // WHETHER TO CLAIM THE MACHINE-WIDE DEFAULT. Writing `server`/`current` unconditionally made a
  // LOCAL action a FLEET-WIDE one: creating an isolated team on another port (which ADR 252's live
  // wake check required) silently repointed every unbound folder — and every reader that consults
  // the global config directly, `service status` and `stream doctor` among them — at a daemon that
  // vanished when the probe ended. Measured 2026-08-12: four checks failing correctly about the
  // wrong port, ~1h lost to healthy infrastructure, and first cause of a second incident.
  //
  // The creating folder never needed it. `saveBinding` below writes this folder's own server + team,
  // and a binding outranks the global default everywhere identity resolves — so on a machine that
  // already has a default, the global write was pure side effect.
  //
  // Not a contradiction of `musterd human`, which asserts `current` unconditionally and says so
  // (see human.ts): that command is a PERSON declaring which team they act on, and the declaration
  // is the point. Creating a team is not that declaration — the probe case is exactly where the two
  // come apart — so here it is opt-in via `--switch`, and never silent either way.
  const takeDefault = parsed.flags['switch'] === true || !config.current;
  const previousTeam = config.current;
  if (takeDefault) {
    config.server = server;
    config.current = slug;
  }
  config.agentKeys[slug] = res.agent_key as string; // ADR 075: keep the team key for `musterd agent`
  config.identities[slug] = { name, key: credential, surface: 'cli' };
  rememberIdentity(config, { team: slug, name, key: credential, surface: 'cli' }); // ADR 059 vault
  saveConfig(config);
  // Auto-bind the creating folder so it's immediately *active* — you can act here without `--as`,
  // while every other unbound folder stays read-only (ADR 036). The binding carries the folder's
  // claim secret (here the creator's credential) so resolveIdentity yields the admin here.
  const binding: Binding = {
    version: 2,
    server,
    team: slug,
    agent_key: credential,
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
  // Say what happened to the machine-wide default, in BOTH branches. The 2026-08-12 incident was
  // expensive because the switch left no trace at the call site and none afterwards — the only
  // evidence was the symptom, three tools away, presenting as something else entirely.
  process.stdout.write(
    takeDefault
      ? theme.meta(`machine default now points at ${slug} ${theme.accent(server)}`) + '\n'
      : theme.meta(
          `machine default left on ${theme.accent(previousTeam as string)} — this folder is bound to ${slug}; ` +
            `pass ${theme.accent('--switch')} to change it for every unbound folder`,
        ) + '\n',
  );
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
  const bootstrap =
    kind === 'agent'
      ? await http.mintBootstrapCredential(team, {
          use: 'claim_seat',
          target: name,
          label: `team-add:${name}`,
        })
      : undefined;

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({
        member: res.member,
        ...(res.human_credential ? { human_credential: res.human_credential } : {}),
        ...(bootstrap
          ? {
              agent_key: bootstrap.agent_key,
              bootstrap_credential: bootstrap.credential,
            }
          : {}),
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
    // ADR 344: the handoff carries a one-seat bootstrap credential, never the Team-wide legacy key.
    process.stdout.write(theme.meta('connect this agent via MCP with its scoped key:') + '\n');
    process.stdout.write(
      theme.meta(
        `  MUSTERD_TEAM=${team} MUSTERD_AGENT_KEY=${bootstrap!.agent_key} MUSTERD_CLAIM=seat:${name} MUSTERD_LAUNCH_SURFACE=claude-code`,
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
 * Read the team agent key off the seat bindings this machine already holds.
 *
 * The key is a per-team secret recorded in `config.agentKeys` at `team create` (ADR 075) — and that
 * map is the *only* copy the config keeps, so anything that empties it (an interrupted prune,
 * `musterd reset`, a restored backup) takes `musterd agent` and `musterd human` down with it. But the
 * key itself is rarely gone: every agent workspace `musterd agent` ever provisioned wrote it into its
 * own gitignored `binding.json`. Measured on team `revive`, 2026-08-14: `agentKeys` empty, eleven
 * seat bindings all carrying the same `mskey_`. The secret was on the machine the whole time.
 *
 * That is why recovery, not rotation, is this command's default. Rotating in that state mints a key
 * none of those eleven bindings hold, so the repair for a bookkeeping gap would be a team-wide
 * outage.
 *
 * Two abstentions are deliberate. Only `mskey_`-prefixed keys count — a human seat's binding carries
 * that person's `mscr_` credential, and recording one as the team key would rebuild the dead binding
 * `findHeldCredential` and `doctor.ts` both exist to catch. And disagreement returns no key at all:
 * two keys in flight means a rotation landed partway, so this hands back every candidate and lets the
 * operator choose with `--key` rather than guessing and re-breaking the other half.
 *
 * Pure and injectable (`read`) so the decision is testable without a filesystem.
 */
export function recoverAgentKey(
  dirs: readonly string[],
  team: string,
  read: (dir: string) => Binding | null,
): {
  /** The single agreed key, or null when there is nothing to recover or the candidates disagree. */
  key: string | null;
  /** The folders that vouched for `key` — named in the output, because this writes a secret. */
  sources: string[];
  /** Every candidate with its folders, populated only when they disagree. */
  conflicts: Array<{ key: string; dirs: string[] }>;
} {
  const byKey = new Map<string, string[]>();
  for (const dir of dirs) {
    const binding = read(dir);
    if (binding?.team !== team) continue;
    const key = binding.agent_key;
    if (!key || !key.startsWith(TOKEN_PREFIXES.agent_key)) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), dir]);
  }
  if (byKey.size === 0) return { key: null, sources: [], conflicts: [] };
  if (byKey.size > 1) {
    return {
      key: null,
      sources: [],
      conflicts: [...byKey].map(([key, dirs]) => ({ key, dirs })),
    };
  }
  const [key, sources] = [...byKey][0]!;
  return { key, sources, conflicts: [] };
}

/**
 * `musterd team agent-key [--key <mskey_…>] [--rotate [--yes]] [--show]` — hold, recover, or replace
 * the team agent key on this machine. See {@link recoverAgentKey} for why the default reads rather
 * than rotates.
 */
async function teamAgentKey(parsed: Parsed): Promise<number> {
  const config = loadConfig();
  const team = flagStr(parsed.flags, 'team') ?? config.current;
  if (!team) throw new CliError('no team — pass --team <slug> or set a current team', 2);
  const json = parsed.flags['json'] === true;
  const held = config.agentKeys[team];

  const record = (key: string, how: string, sources: string[]): number => {
    config.agentKeys[team] = key;
    saveConfig(config);
    if (json) {
      process.stdout.write(JSON.stringify({ team, agent_key: key, source: how, sources }) + '\n');
      return 0;
    }
    process.stdout.write(
      success(`team agent key recorded for ${team} ${theme.meta(`(${how})`)}`) + '\n',
    );
    if (sources.length) {
      process.stdout.write(
        theme.meta(
          `  read from ${sources.length} seat binding${sources.length === 1 ? '' : 's'}: `,
        ) +
          theme.meta(sources.join(', ')) +
          '\n',
      );
    }
    process.stdout.write(hint('musterd agent <name> now works here') + '\n');
    return 0;
  };

  // `--show` — print what this machine holds. No round-trip; the key is already echoed by
  // `team add`, so this exposes nothing new, but it stays behind an explicit flag.
  if (parsed.flags['show'] === true) {
    if (json) {
      process.stdout.write(JSON.stringify({ team, agent_key: held ?? null }) + '\n');
      return 0;
    }
    if (!held) {
      process.stdout.write(
        `${theme.warn(sym.warn)} no team agent key recorded for ${team} on this machine\n` +
          theme.meta(`  try \`musterd team agent-key --team ${team}\` to recover it\n`),
      );
      return 4;
    }
    process.stdout.write(`${held}\n`);
    return 0;
  }

  // `--key` — record a key the operator already holds (from another machine, or a conflict this
  // command refused to resolve on its own).
  const explicit = flagStr(parsed.flags, 'key');
  if (explicit) {
    if (!explicit.startsWith(TOKEN_PREFIXES.agent_key)) {
      throw new CliError(
        `"${explicit.slice(0, 6)}…" is not a team agent key — those start with ` +
          `\`${TOKEN_PREFIXES.agent_key}\`. A \`${TOKEN_PREFIXES.credential}\` is a person's ` +
          `credential (\`musterd join\`), not the team key.`,
        2,
      );
    }
    return record(explicit, 'given with --key', []);
  }

  if (parsed.flags['rotate'] === true) return rotateTeamAgentKey(parsed, config, team, held, json);

  // The default: recover from the seat bindings this machine already holds.
  const found = recoverAgentKey(Object.keys(config.bindings), team, readBindingAt);
  if (found.key) {
    if (found.key === held) {
      if (json) {
        process.stdout.write(
          JSON.stringify({
            team,
            agent_key: held,
            source: 'already recorded',
            sources: found.sources,
          }) + '\n',
        );
        return 0;
      }
      process.stdout.write(
        success(`team agent key already recorded for ${team} — nothing to repair`) + '\n',
      );
      process.stdout.write(
        theme.meta(`  ${found.sources.length} seat binding(s) here agree with it\n`),
      );
      return 0;
    }
    return record(found.key, 'recovered from seat bindings', found.sources);
  }

  if (found.conflicts.length) {
    // Abstain loudly. Naming every candidate and its folders is the whole value here — the operator
    // knows which rotation was the real one; this command does not.
    const lines = found.conflicts
      .map((c) => `  ${c.key.slice(0, 12)}…  ${c.dirs.length} seat(s): ${c.dirs.join(', ')}`)
      .join('\n');
    throw new CliError(
      `the seat bindings on this machine disagree about "${team}"'s agent key, so nothing was ` +
        `recorded — a rotation landed partway. Candidates:\n${lines}\n` +
        `Pick one with \`musterd team agent-key --team ${team} --key <mskey_…>\`, or mint a fresh ` +
        `one for everybody with \`--rotate\`.`,
      4,
    );
  }

  throw new CliError(
    `no team agent key for "${team}" anywhere on this machine — not in the config, and no seat ` +
      `binding here carries one. If you have it, record it with \`--key <mskey_…>\`; otherwise mint ` +
      `a replacement with \`musterd team agent-key --team ${team} --rotate\` (which invalidates the ` +
      `old key for every seat on every machine).`,
    4,
  );
}

/**
 * `--rotate` — mint a new team agent key. The destructive branch, and gated accordingly: it counts
 * the local seat bindings still carrying the current key and refuses without `--yes`. On team
 * `revive` that count was eleven; rotating blind to fix an empty `agentKeys` map would have taken
 * every agent on the machine offline to repair a bookkeeping gap.
 *
 * The stale bindings are LISTED, not rewritten. A silent multi-folder rewrite of files holding
 * secrets is the wrong kind of convenience, and it could only ever reach this machine anyway — seats
 * on other machines need the new key regardless, so the honest output is the list plus the repair.
 */
async function rotateTeamAgentKey(
  parsed: Parsed,
  config: ReturnType<typeof loadConfig>,
  team: string,
  held: string | undefined,
  json: boolean,
): Promise<number> {
  const stale = Object.keys(config.bindings).filter((dir) => {
    const binding = readBindingAt(dir);
    return binding?.team === team && !!binding.agent_key?.startsWith(TOKEN_PREFIXES.agent_key);
  });

  if (parsed.flags['yes'] !== true) {
    throw new CliError(
      `rotating "${team}"'s agent key invalidates the key ${stale.length} seat binding(s) on this ` +
        `machine currently authenticate with${stale.length ? `:\n  ${stale.join('\n  ')}\n` : ', '}` +
        `plus every seat on every other machine. Nothing was changed. ` +
        `If you only lost the local record, \`musterd team agent-key --team ${team}\` recovers it ` +
        `without a rotation. To rotate anyway, re-run with \`--yes\`.`,
      2,
    );
  }

  // Admin act against a live daemon — `resolve` enforces an *active* identity (ADR 036), same bar as
  // `team add`, and the daemon audits the rotate as `key.rotate`.
  const { http } = resolve(parsed.flags);
  const mint = await http.rotateAgentKey(team);
  config.agentKeys[team] = mint.agent_key;
  saveConfig(config);

  if (json) {
    process.stdout.write(
      JSON.stringify({ team, agent_key: mint.agent_key, rotated: true, stale }) + '\n',
    );
    return 0;
  }
  process.stdout.write(success(`re-issued "${team}"'s team agent key`) + '\n');
  process.stdout.write(
    theme.meta('shown once — store it now, and hand it to any seat on another machine:') + '\n',
  );
  process.stdout.write(`  ${mint.agent_key}\n`);
  process.stdout.write(theme.meta('recorded in this machine’s config') + '\n');
  if (stale.length) {
    const wasHeld = held ? '' : ' (the old key was not in this config, so it is not shown)';
    process.stdout.write(
      `${theme.warn(sym.warn)} ${stale.length} seat binding(s) here still hold the OLD key${wasHeld} — ` +
        `they will 403 on their next claim:\n` +
        stale.map((d) => theme.meta(`    ${d}`)).join('\n') +
        '\n' +
        theme.meta(`  repair each with \`musterd wire\` in the folder — it re-reads this config.`) +
        '\n',
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
