import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { BINDING_DIR, BINDING_FILE, bindingSeat, type Residency } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { findBinding, saveBinding } from '../config.js';
import { CliError } from '../errors.js';
import { clock, theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';
import { resolve, resolveRead } from './helpers.js';

/**
 * `musterd residency on|off|status` (ADR 131, increment 2) — enroll this workspace's seat into
 * harness residency so a directed act can wake it while offline. `on` is the authorization event
 * (admin-authorized server-side): it writes the server enrollment row + a **standing** resume grant,
 * and lands the grant token in this workspace's `binding.grant` so woken sessions occupy via the
 * seat's own credential. `off` reverses both — the kill switch. `status` cross-checks the stores and
 * names drift (the `init --check` idiom). The machine-local host registry (seat → workspace path)
 * is increment 3's `musterd host`; re-running `residency on` there backfills it.
 */
export async function residencyCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  if (sub === 'on') return onCommand(parsed);
  if (sub === 'off') return offCommand(parsed);
  if (sub === 'status' || sub === undefined) return statusCommand(parsed);
  throw new CliError('usage: musterd residency on | off | status', 2);
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
    'no seat — run inside a bound workspace (musterd agent <name>) or pass --seat <name>',
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
  const dir = findWorkspaceDir();
  let grantSaved = false;
  if (dir && binding && bindingSeat(binding) === seat) {
    saveBinding(dir, { ...binding, grant: res.grant });
    grantSaved = true;
  }

  if (parsed.flags['json']) {
    process.stdout.write(
      JSON.stringify({ residency: res.residency, grant_saved: grantSaved }) + '\n',
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
  } else {
    process.stdout.write(
      theme.warn(
        `  ! standing grant NOT saved locally (no binding for "${seat}" here) — ` +
          'run this in the seat’s workspace so woken sessions can occupy',
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

  // The server grant is revoked; drop the now-dead token from the local binding too.
  const dir = findWorkspaceDir();
  const binding = findBinding();
  if (dir && binding && bindingSeat(binding) === seat && binding.grant !== undefined) {
    const { grant: _dead, ...rest } = binding;
    saveBinding(dir, rest);
  }

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
  return 0;
}

function renderResidency(r: Residency): string {
  const since = theme.meta(clock(r.updated_at));
  const authorized = r.authorized_by
    ? theme.meta(`authorized by ${r.authorized_by}`)
    : theme.meta('—');
  return `${since} ${theme.memberName(r.seat, 'agent')} ${theme.meta(`[${r.harness}]`)} ${sym.dot} host ${r.host} ${sym.dot} ${authorized}`;
}
