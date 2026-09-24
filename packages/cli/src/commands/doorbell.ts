import {
  ASK_TIERS,
  type AskTier,
  DOORBELL_SINKS,
  type DoorbellPrefs,
  type DoorbellSink,
  type DoorbellSinkPref,
  type PolicyOverride,
} from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import type { DoorbellView } from '../client.js';
import { CliError } from '../errors.js';
import { canonicalServer, type HostRegistryEntry, loadHostRegistry } from '../host/registry.js';
import { theme } from '../render/theme.js';
import { success } from '../render/ui.js';
import { resolve, resolveRead } from './helpers.js';

/**
 * `musterd doorbell` — where you are rung when something is addressed to you (ADR 443).
 *
 *   musterd doorbell                                     show your route, and where each part comes from
 *   musterd doorbell <slack|webhook> on [--url <u>] [--tiers blocking,standard]
 *   musterd doorbell os on [--host <label>]              ring this machine (its host label)
 *   musterd doorbell <sink> off
 *   musterd doorbell team [--allow a,b] [--defaults a,b] [--slack <url|off>] [--webhook <url|off>]
 *
 * For human members only. There is deliberately no MCP tool: agents do not choose where a human is
 * rung (ADR 443 §7). A personal URL is shown only to you, masked to its host even then.
 */

export interface DoorbellDeps {
  loadRegistry?: () => { entries: HostRegistryEntry[] };
}

const OFF_MACHINE = new Set<DoorbellSink>(['slack', 'webhook']);

export async function doorbellCommand(parsed: Parsed, deps: DoorbellDeps = {}): Promise<number> {
  const [first, second] = parsed.positionals;
  if (first === 'team') return teamKnobs(parsed);
  const { team, http } = resolve(parsed.flags);

  let view: DoorbellView;
  try {
    view = await http.getDoorbell(team);
  } catch (err) {
    if (err instanceof CliError && err.code === 'forbidden') {
      process.stdout.write(
        theme.meta('the doorbell is for human members — an agent is reached through its inbox') +
          '\n',
      );
      return 0;
    }
    throw err;
  }

  if (first === undefined) return show(view, parsed);

  const sink = parseSink(first);
  if (second !== 'on' && second !== 'off') throw usage();
  if (sink === 'live') {
    if (second === 'off')
      throw new CliError('live is always on — /live and the inbox always reach you', 2);
    return show(view, parsed);
  }

  const prefs: DoorbellPrefs = { sinks: { ...view.prefs.sinks } };
  const prior = prefs.sinks[sink];
  if (second === 'off') {
    prefs.sinks[sink] = { ...prior, on: false };
  } else {
    prefs.sinks[sink] = turnOn(sink, prior, view, parsed, deps);
  }
  const updated = await http.putDoorbell(team, prefs);
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(updated) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`doorbell ${theme.accent(sink)} ${second}`, { next: 'musterd doorbell' }) + '\n',
  );
  return 0;
}

function turnOn(
  sink: Exclude<DoorbellSink, 'live'>,
  prior: DoorbellSinkPref | undefined,
  view: DoorbellView,
  parsed: Parsed,
  deps: DoorbellDeps,
): DoorbellSinkPref {
  const tiers = parseTiers(flagStr(parsed.flags, 'tiers'));
  const next: DoorbellSinkPref = { ...prior, on: true, ...(tiers ? { tiers } : {}) };
  if (OFF_MACHINE.has(sink)) {
    const url = flagStr(parsed.flags, 'url');
    if (url) next.url = url;
    const teamHasUrl = view.team_urls[sink as 'slack' | 'webhook'];
    if (!next.url && !teamHasUrl) {
      throw new CliError(
        `no ${sink} url — pass --url <https://…>, or ask an admin to set the team's (musterd doorbell team --${sink} <url>)`,
        2,
      );
    }
  }
  if (sink === 'os') next.host = flagStr(parsed.flags, 'host') ?? thisMachinesLabel(parsed, deps);
  return next;
}

/**
 * The host label this machine's `musterd host` polls under for this team (ADR 443 §3): the one its
 * resident seats enrolled with. None means no host runs here for the team, so no banner could ever
 * be raised — say so rather than store a label nothing answers to.
 */
function thisMachinesLabel(parsed: Parsed, deps: DoorbellDeps): string {
  const { team, server } = resolveRead(parsed.flags);
  const entries = (deps.loadRegistry ?? loadHostRegistry)().entries.filter(
    (e) => e.team === team && canonicalServer(e.server) === canonicalServer(server),
  );
  const labels = [...new Set(entries.map((e) => e.host))];
  if (labels.length === 0) {
    throw new CliError(
      `no musterd host runs on this machine for ${team} — the os sink needs one ` +
        '(enroll a seat here with `musterd residency on`), or pass --host <label>',
      2,
    );
  }
  if (labels.length > 1) {
    throw new CliError(
      `this machine polls as more than one host label (${labels.join(', ')}) — pass --host <label>`,
      2,
    );
  }
  return labels[0]!;
}

/** Your route, one line per sink, each saying where its state comes from. */
function show(view: DoorbellView, parsed: Parsed): number {
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(view) + '\n');
    return 0;
  }
  process.stdout.write(`${theme.accent('doorbell')} — ${view.member}\n`);
  for (const sink of DOORBELL_SINKS) {
    const on = view.route.includes(sink);
    // `os` routed with no host label rings nothing on this machine — the record goes straight to
    // done. "on" overstated that (stanley's acceptance nit, 2026-09-24), so it reads idle until labelled.
    const idle = on && sink === 'os' && !view.prefs.sinks.os?.host;
    const mark = idle ? theme.warn('◌ idle') : on ? theme.ok('◉ on ') : theme.meta('○ off');
    process.stdout.write(`  ${mark}  ${sink.padEnd(8)} ${theme.meta(why(sink, view))}\n`);
  }
  return 0;
}

function why(sink: DoorbellSink, view: DoorbellView): string {
  if (sink === 'live') return 'always on — /live and the inbox';
  if (!view.allow.includes(sink)) return 'not allowed on this team';
  const pref = view.prefs.sinks[sink];
  const parts: string[] = [];
  if (pref) parts.push(pref.on ? 'your override' : 'you turned it off');
  else parts.push(view.defaults.includes(sink) ? 'team default' : 'off by team default');
  if (pref?.tiers) parts.push(`tiers: ${pref.tiers.join(',')}`);
  if (pref?.url) parts.push(`your url → ${maskUrl(pref.url)}`);
  else if (OFF_MACHINE.has(sink))
    parts.push(view.team_urls[sink as 'slack' | 'webhook'] ? 'team url' : 'no url set');
  if (sink === 'os')
    parts.push(pref?.host ? `host ${pref.host}` : 'no host label — run: musterd doorbell os on');
  return parts.join(' · ');
}

/** A URL masked to its host — enough to recognise the destination, never the secret path. */
export function maskUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'set';
  }
}

/**
 * The admin's team knobs: which sinks exist, which ring by default, and the team's own Slack and
 * webhook URLs. The same read-merge-write `POST /policy` `team policy` uses, audited `policy.change`.
 */
async function teamKnobs(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const allow = parseSinks(flagStr(parsed.flags, 'allow'), '--allow');
  const defaults = parseSinks(flagStr(parsed.flags, 'defaults'), '--defaults');
  const slack = flagStr(parsed.flags, 'slack');
  const webhook = flagStr(parsed.flags, 'webhook');
  const { stored } = await http.getPolicy(team);
  const doorbell: NonNullable<PolicyOverride['doorbell']> = { ...stored.doorbell };
  if (allow) doorbell.allow = allow;
  if (defaults) doorbell.defaults = defaults;
  if (slack === 'off') delete doorbell.slack_url;
  else if (slack) doorbell.slack_url = slack;
  if (webhook === 'off') delete doorbell.webhook_url;
  else if (webhook) doorbell.webhook_url = webhook;
  const changed = allow || defaults || slack || webhook;
  const next: PolicyOverride = { ...stored };
  if (Object.keys(doorbell).length > 0) next.doorbell = doorbell;
  else delete next.doorbell;
  const result = changed ? await http.setPolicy(team, next) : await http.getPolicy(team);
  const effective = result.policy.doorbell;
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(effective) + '\n');
    return 0;
  }
  process.stdout.write(`${theme.accent('doorbell')} — team ${team}\n`);
  process.stdout.write(`  allow     ${effective.allow.join(', ')}\n`);
  process.stdout.write(`  defaults  ${effective.defaults.join(', ')}\n`);
  process.stdout.write(
    `  slack     ${effective.slack_url ? maskUrl(effective.slack_url) : result.policy.ask_slack_webhook ? `${maskUrl(result.policy.ask_slack_webhook)} (from ask_slack_webhook)` : 'off'}\n`,
  );
  process.stdout.write(
    `  webhook   ${effective.webhook_url ? maskUrl(effective.webhook_url) : 'off'}\n`,
  );
  return 0;
}

function parseSink(raw: string): DoorbellSink {
  if ((DOORBELL_SINKS as readonly string[]).includes(raw)) return raw as DoorbellSink;
  throw usage();
}

function parseSinks(raw: string | undefined, flag: string): DoorbellSink[] | undefined {
  if (raw === undefined) return undefined;
  const sinks = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = sinks.filter((s) => !(DOORBELL_SINKS as readonly string[]).includes(s));
  if (bad.length > 0)
    throw new CliError(
      `${flag}: unknown sink ${bad.join(', ')} — one of ${DOORBELL_SINKS.join(', ')}`,
      2,
    );
  return sinks as DoorbellSink[];
}

function parseTiers(raw: string | undefined): AskTier[] | undefined {
  if (raw === undefined) return undefined;
  const tiers = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = tiers.filter((t) => !(ASK_TIERS as readonly string[]).includes(t));
  if (bad.length > 0)
    throw new CliError(
      `--tiers: unknown tier ${bad.join(', ')} — one of ${ASK_TIERS.join(', ')}`,
      2,
    );
  return tiers as AskTier[];
}

function usage(): CliError {
  return new CliError(
    'usage: musterd doorbell [<live|os|slack|webhook> <on|off> [--url <u>] [--tiers <t,…>] [--host <label>]] | doorbell team [--allow …] [--defaults …] [--slack <url|off>] [--webhook <url|off>]',
    2,
  );
}
