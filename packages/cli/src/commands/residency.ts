import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { BINDING_DIR, BINDING_FILE, bindingSeat, type Residency } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
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
import { resolve, resolveRead } from './helpers.js';

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
 */
export async function residencyCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'on') return onCommand(parsed);
  if (sub === 'off') return offCommand(parsed);
  if (sub === 'status' || sub === undefined) return statusCommand(parsed);
  throw new CliError(
    'usage: musterd residency on | off | status  ' +
      '(--seat <agent> = what gets enrolled, default this workspace’s seat; --as <admin> = who authorizes)',
    2,
  );
}

/** Walk up from cwd to the folder holding `.musterd/binding.json` (the workspace root), or null. */
function findWorkspaceDir(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, BINDING_DIR, BINDING_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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

  const res = await http.enrollResidency(team, { seat, harness, host });

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

async function statusCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolveRead(parsed.flags);
  const { residency } = await http.residency(team);

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(residency) + '\n');
    return 0;
  }

  process.stdout.write(`${theme.accent('residency')} — ${team} (${residency.length} enrolled)\n`);
  if (residency.length === 0) {
    process.stdout.write(
      theme.meta('no seats enrolled — `musterd residency on` in a seat’s workspace') + '\n',
    );
    return 0;
  }
  for (const r of residency) process.stdout.write(renderResidency(r) + '\n');

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
