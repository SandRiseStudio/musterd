import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  BINDING_DIR,
  BINDING_FILE,
  bindingSeat,
  ResidencyPolicySchema,
  type Residency,
  type ResidencyPolicy,
  type ResidencyPolicyOverride,
} from '@musterd/protocol';
import { flagStr, fmtDurationMs, parseDurationMs, type Parsed } from '../args.js';
import { findBinding, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import {
  hostRegistryPath,
  loadHostRegistry,
  removeHostEntry,
  upsertHostEntry,
} from '../host/registry.js';
import { clock, theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';
import { findWorkspaceDir, resolve, resolveRead } from './helpers.js';

/**
 * `musterd residency on|off|status` (ADR 131) — enroll this workspace's seat into harness
 * residency so a directed act can wake it while offline. `on` is the authorization event
 * (admin-authorized server-side): one verb, three writes — the server enrollment row + a
 * **standing** resume grant landed in this workspace's `binding.grant` (so woken sessions occupy
 * via the seat's own credential), and the machine-local host registry entry (seat → workspace
 * path) that `musterd host` actuates from. `off` reverses all three — the kill switch. `status`
 * cross-checks the three stores and names drift (the `init --check` idiom).
 *
 * The two identities in play are deliberately different flags: `--seat` names *what gets
 * enrolled* (an agent seat; defaults to this workspace's binding), `--as` names *who authorizes*
 * (an admin — enrollment is an actor≠authorizer gate, ADR 127).
 *
 * Increment 5 adds the knobs (ADR 131 §3): `on` takes per-seat override flags, `policy` reads or
 * sets the team-wide defaults with the same flag vocabulary, and `status` renders the effective
 * policy per seat (overridden knobs starred). There is deliberately no `--lane off`: an enrollment
 * that can never wake is a contradiction — "stop waking this seat" is `residency off`.
 */
const POLICY_FLAGS_USAGE =
  '[--lane both|interrupt|batched] [--cooldown <15m>] [--hourly-cap <n>] [--attempt-cap <n>] ' +
  '[--tool-policy reply-only|seat-policy] [--timeout <5m>] [--max-turns <n>] [--budget <usd>] ' +
  '[--transcript-max <MiB>]';

export async function residencyCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'on') return onCommand(parsed);
  if (sub === 'off') return offCommand(parsed);
  if (sub === 'policy') return policyCommand(parsed);
  if (sub === 'status' || sub === undefined) return statusCommand(parsed);
  throw new CliError(
    'usage: musterd residency on | off | status | policy  ' +
      '(--seat <agent> = what gets enrolled, default this workspace’s seat; --as <admin> = who ' +
      `authorizes). Knobs, on \`on\` (this seat) or \`policy\` (team defaults): ${POLICY_FLAGS_USAGE}`,
    2,
  );
}

/**
 * Collect the knob flags into a sparse policy object — only explicitly-passed flags enter it, so
 * an enroll without knob flags preserves any existing override (`undefined`), and `--reset-policy`
 * clears back to team defaults (`{}`). Ranges are enforced server-side (the 400 names the range);
 * here we only refuse shapes that cannot travel (non-numbers, malformed durations).
 */
function collectPolicyFlags(parsed: Parsed): ResidencyPolicyOverride | undefined {
  const out: Record<string, unknown> = {};
  const num = (flag: string, key: string, scale = 1) => {
    const raw = flagStr(parsed.flags, flag);
    if (raw === undefined) return;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new CliError(`--${flag} wants a number (got "${raw}")`, 2);
    out[key] = Math.round(n * scale);
  };
  const lane = flagStr(parsed.flags, 'lane');
  if (lane !== undefined) out['lane'] = lane;
  const cooldown = flagStr(parsed.flags, 'cooldown');
  if (cooldown !== undefined) out['cooldown_ms'] = parseDurationMs(cooldown, '--cooldown');
  num('hourly-cap', 'hourly_cap');
  num('attempt-cap', 'attempt_cap');
  const toolPolicy = flagStr(parsed.flags, 'tool-policy');
  if (toolPolicy !== undefined) out['tool_policy'] = toolPolicy;
  const timeout = flagStr(parsed.flags, 'timeout');
  if (timeout !== undefined) out['timeout_ms'] = parseDurationMs(timeout, '--timeout');
  num('max-turns', 'max_turns');
  const budget = flagStr(parsed.flags, 'budget');
  if (budget !== undefined) {
    const n = Number(budget);
    if (!Number.isFinite(n)) throw new CliError(`--budget wants dollars (got "${budget}")`, 2);
    out['budget_usd'] = n;
  }
  num('transcript-max', 'transcript_max_bytes', 1_048_576); // MiB → bytes
  if (parsed.flags['reset-policy'] === true) {
    if (Object.keys(out).length > 0)
      throw new CliError('--reset-policy clears every knob — drop the other policy flags', 2);
    return {};
  }
  return Object.keys(out).length > 0 ? (out as ResidencyPolicyOverride) : undefined;
}

/** One-line policy summary. With `override`, starred knobs are the seat-overridden ones. */
function renderPolicy(policy: ResidencyPolicy, override?: ResidencyPolicyOverride | null): string {
  const star = (key: keyof ResidencyPolicy) => (override && override[key] !== undefined ? '*' : '');
  const bits = [
    `lane ${policy.lane}${star('lane')}`,
    `cooldown ${fmtDurationMs(policy.cooldown_ms)}${star('cooldown_ms')}`,
    `${policy.hourly_cap}/h${star('hourly_cap')}`,
    `${policy.attempt_cap} attempts${star('attempt_cap')}`,
    `${policy.tool_policy}${star('tool_policy')}`,
    `timeout ${fmtDurationMs(policy.timeout_ms)}${star('timeout_ms')}`,
  ];
  if (policy.max_turns !== undefined) bits.push(`${policy.max_turns} turns${star('max_turns')}`);
  if (policy.budget_usd !== undefined)
    bits.push(`budget $${policy.budget_usd}${star('budget_usd')}`);
  bits.push(
    `transcript ${(policy.transcript_max_bytes / 1_048_576).toFixed(0)}MiB${star('transcript_max_bytes')}`,
  );
  return bits.join(' · ');
}

/** Launch defaults ⊕ team defaults ⊕ seat override — the CLI-side twin of the server's
 *  `effectiveWakePolicy`, for rendering only (the daemon derives its own at lease time). */
function mergePolicy(
  defaults: ResidencyPolicy,
  override: ResidencyPolicyOverride | null | undefined,
): ResidencyPolicy {
  if (!override) return defaults;
  const merged: ResidencyPolicy = { ...defaults };
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/** The seat this invocation is about: `--seat` wins, else the workspace binding's fixed seat. */
function resolveSeat(parsed: Parsed): string {
  const flag = flagStr(parsed.flags, 'seat');
  if (flag) return flag;
  const binding = findBinding();
  const bound = binding ? bindingSeat(binding) : undefined;
  if (bound) return bound;
  throw new CliError(
    'no seat to enroll — run this in the agent seat’s workspace (musterd agent <name>), or name ' +
      'one with --seat <agent>. (--as <admin> only says who authorizes, never what gets enrolled.)',
    2,
  );
}

async function onCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const seat = resolveSeat(parsed);
  const binding = findBinding();
  const harness = flagStr(parsed.flags, 'harness') ?? binding?.surface;
  if (!harness) {
    throw new CliError('no harness — pass --harness <class> (e.g. claude-code)', 2);
  }
  const host = flagStr(parsed.flags, 'host') ?? hostname();
  const policy = collectPolicyFlags(parsed);

  const res = await http.enrollResidency(team, {
    seat,
    harness,
    host,
    ...(policy !== undefined ? { policy } : {}),
  });

  // Land the standing grant in this workspace's binding so woken sessions occupy via the seat's
  // own credential (the daemon never holds it) — only when this folder is actually the seat's.
  // The same condition gates the host-registry write: seat → workspace is a fact only the seat's
  // own workspace can assert (ADR 131 §2's third store).
  const dir = findWorkspaceDir();
  let grantSaved = false;
  let registered = false;
  if (dir && binding && bindingSeat(binding) === seat) {
    saveBinding(dir, { ...binding, grant: res.grant });
    grantSaved = true;
    upsertHostEntry({
      server: binding.server,
      team,
      seat,
      workspace: dir,
      harness: res.residency.harness,
      host: res.residency.host,
    });
    registered = true;
  }

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({ residency: res.residency, grant_saved: grantSaved, registered }) + '\n',
    );
    return 0;
  }
  process.stdout.write(
    success(
      `${theme.memberName(seat, 'agent')} is enrolled — offline reads ${theme.accent('offline · wakeable')}`,
    ) + '\n',
  );
  process.stdout.write(
    theme.meta(`  harness ${res.residency.harness} · host ${res.residency.host}`) + '\n',
  );
  if (res.residency.policy && Object.keys(res.residency.policy).length > 0) {
    process.stdout.write(
      theme.meta(`  seat overrides: ${JSON.stringify(res.residency.policy)}`) + '\n',
    );
  } else if (policy !== undefined && Object.keys(policy).length === 0) {
    process.stdout.write(theme.meta('  seat overrides cleared — team defaults govern') + '\n');
  }
  // Grant-rotation trap (dogfood 2026-07-13): re-enrolling rotates the standing grant while a
  // live session still holds the old one in its adapter — say so, or the next daemon bounce
  // surprises with "grant revoked".
  if (res.seat_live) {
    process.stdout.write(
      theme.warn(
        `  ! "${seat}" has a live session — it occupies via the grant this enroll just rotated; ` +
          'the new grant and policy govern from its next wake/claim (a reconnect may need team_join)',
      ) + '\n',
    );
  }
  if (grantSaved) {
    process.stdout.write(
      theme.meta('  standing grant saved to .musterd/binding.json (revoked by `residency off`)') +
        '\n',
    );
    process.stdout.write(
      theme.meta(`  host registry: ${seat} → ${dir} (\`musterd host\` actuates from it)`) + '\n',
    );
  } else {
    process.stdout.write(
      theme.warn(
        `  ! standing grant NOT saved locally (no binding for "${seat}" here) — ` +
          'run this in the seat’s workspace so woken sessions can occupy',
      ) + '\n',
    );
    process.stdout.write(
      theme.warn(
        '  ! host registry NOT updated — `musterd host` on this machine cannot wake ' +
          `"${seat}" until \`residency on\` runs in its workspace`,
      ) + '\n',
    );
    process.stdout.write(theme.meta(`  grant: ${res.grant}`) + '\n');
  }
  return 0;
}

async function offCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const seat = resolveSeat(parsed);
  await http.revokeResidency(team, seat);

  // The server grant is revoked; drop the now-dead token from the local binding too, and take the
  // seat out of this machine's host registry — after the kill switch, `musterd host` must derive
  // *and* hold nothing for it.
  const dir = findWorkspaceDir();
  const binding = findBinding();
  if (dir && binding && bindingSeat(binding) === seat && binding.grant !== undefined) {
    const { grant: _dead, ...rest } = binding;
    saveBinding(dir, rest);
  }
  removeHostEntry({ ...(binding ? { server: binding.server } : {}), team, seat });

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ ok: true, seat }) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`${theme.memberName(seat, 'agent')} is unenrolled — the standing grant is revoked`) +
      '\n',
  );
  return 0;
}

/**
 * `musterd residency policy` — the team-wide wake-policy defaults, same flag vocabulary as `on`
 * (one mental model: `policy` sets the team, `on` overrides one seat). No knob flags = print the
 * current defaults. Sets go read → merge → POST so one knob changes without re-stating the rest;
 * the server re-parses with defaults and audits `policy.change` (admin, ADR 127).
 */
async function policyCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const knobs = collectPolicyFlags(parsed);
  const { policy: current } = await http.getPolicy(team);

  if (knobs === undefined) {
    if (parsed.flags['json']) {
      process.stdout.write(JSON.stringify(current.residency) + '\n');
      return 0;
    }
    process.stdout.write(`${theme.accent('wake policy defaults')} — ${team}\n`);
    process.stdout.write(`  ${renderPolicy(current.residency)}\n`);
    process.stdout.write(
      theme.meta('  set: musterd residency policy --cooldown 15m …  ' + POLICY_FLAGS_USAGE) + '\n',
    );
    return 0;
  }

  const residency =
    Object.keys(knobs).length === 0
      ? // `--reset-policy`: back to launch defaults.
        ResidencyPolicySchema.parse({})
      : mergePolicy(current.residency, knobs);
  const { policy: updated } = await http.setPolicy(team, { ...current, residency });
  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(updated.residency) + '\n');
    return 0;
  }
  process.stdout.write(success(`wake policy defaults updated — ${team}`) + '\n');
  process.stdout.write(`  ${renderPolicy(updated.residency)}\n`);
  return 0;
}

async function statusCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolveRead(parsed.flags);
  const { residency, policy_defaults } = await http.residency(team);

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ residency, policy_defaults }) + '\n');
    return 0;
  }

  process.stdout.write(`${theme.accent('residency')} — ${team} (${residency.length} enrolled)\n`);
  if (policy_defaults) {
    process.stdout.write(theme.meta(`defaults: ${renderPolicy(policy_defaults)}`) + '\n');
  }
  if (residency.length === 0) {
    process.stdout.write(
      theme.meta('no seats enrolled — `musterd residency on` in a seat’s workspace') + '\n',
    );
    return 0;
  }
  for (const r of residency) {
    process.stdout.write(renderResidency(r) + '\n');
    // Effective policy per seat, seat-overridden knobs starred. Only when something differs from
    // the defaults line above — an all-defaults seat stays one line.
    if (r.policy && Object.keys(r.policy).length > 0 && policy_defaults) {
      process.stdout.write(
        theme.meta(
          `    policy: ${renderPolicy(mergePolicy(policy_defaults, r.policy), r.policy)}`,
        ) + '\n',
      );
    }
  }

  // Cross-check the local workspace's stores against the server row (the `init --check` idiom).
  const binding = findBinding();
  const bound = binding ? bindingSeat(binding) : undefined;
  if (binding && bound) {
    const mine = residency.find((r) => r.seat === bound);
    if (mine && binding.grant === undefined) {
      process.stdout.write(
        theme.warn(
          `! drift: "${bound}" is enrolled but this workspace holds no grant — ` +
            're-run `musterd residency on` here',
        ) + '\n',
      );
    } else if (!mine && binding.grant !== undefined) {
      process.stdout.write(
        theme.meta(
          `note: this workspace holds a grant but "${bound}" is not enrolled ` +
            '(an ADR 087 resume grant, or a stale residency token)',
        ) + '\n',
      );
    }
    if (mine && mine.host !== hostname()) {
      process.stdout.write(
        theme.warn(
          `! "${bound}" is enrolled to host ${mine.host} — this machine (${hostname()}) is not its actuator`,
        ) + '\n',
      );
    }
  }

  // Third store (ADR 131 §1): the machine-local host registry. Every enrollment claiming a host
  // label this machine has answered to must have a registry entry, or `musterd host` here will be
  // handed a wake order it cannot map to a workspace.
  const registry = loadHostRegistry();
  const myLabels = new Set([hostname(), ...registry.entries.map((e) => e.host)]);
  for (const r of residency) {
    if (!myLabels.has(r.host)) continue;
    const entry = registry.entries.find((e) => e.team === team && e.seat === r.seat);
    if (!entry) {
      process.stdout.write(
        theme.warn(
          `! drift: "${r.seat}" is enrolled to ${r.host} but missing from this machine's host ` +
            `registry — run \`musterd residency on\` in its workspace`,
        ) + '\n',
      );
    } else if (!existsSync(join(entry.workspace, BINDING_DIR, BINDING_FILE))) {
      process.stdout.write(
        theme.warn(
          `! drift: "${r.seat}"'s registered workspace ${entry.workspace} has no binding — ` +
            `a wake cannot occupy; re-run \`musterd residency on\` there`,
        ) + '\n',
      );
    }
  }
  for (const entry of registry.entries.filter((e) => e.team === team)) {
    if (!residency.some((r) => r.seat === entry.seat)) {
      process.stdout.write(
        theme.meta(
          `note: host registry holds "${entry.seat}" (${hostRegistryPath()}) but the seat is not ` +
            'enrolled — stale after a revoke elsewhere; `musterd residency on` or ignore',
        ) + '\n',
      );
    }
  }
  return 0;
}

function renderResidency(r: Residency): string {
  const since = theme.meta(clock(r.updated_at));
  const authorized = r.authorized_by
    ? theme.meta(`authorized by ${r.authorized_by}`)
    : theme.meta('—');
  return `${since} ${theme.memberName(r.seat, 'agent')} ${theme.meta(`[${r.harness}]`)} ${sym.dot} host ${r.host} ${sym.dot} ${authorized}`;
}
