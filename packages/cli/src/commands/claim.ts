import { resolveWorkspace } from '@musterd/mcp';
import { bindingSeat, type Binding, type ClaimPolicy, type Surface } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { HttpClient, watchClaim } from '../client.js';
import { findBinding, loadConfig, saveBinding, wsBase } from '../config.js';
import { CliError } from '../errors.js';
import { liveBindingClobber } from '../onboard/guard.js';
import {
  consumePending,
  listPendingForWorkspace,
  writeResolution,
  type PendingMarker,
} from '../onboard/pending.js';
import { theme } from '../render/theme.js';
import { WAIT_TIMEOUT_EXIT } from './inbox.js';
import { renderMemoryLine } from './memory.js';

/** Default `musterd claim` pending-wait bound (seconds) — same window as `inbox --wait`
 *  (ADR 054/077): long enough to give an admin a real chance to approve, short enough a dropped
 *  socket can't hang a script forever. `--timeout 0` waits unbounded. */
const DEFAULT_CLAIM_TIMEOUT_S = 300;

/** What the caller asked to claim — a named seat, or the next open seat in a role pool. */
export type ClaimSeatTarget = { seat: string } | { role: string };

/**
 * `musterd claim <name>` / `--role <x>` — the v0.3 claim handshake (SPEC A.3, ADR 075). The folder's
 * harness presents the **team agent key** (`mskey_`, from `--key`/`MUSTERD_AGENT_KEY`/the binding) and
 * asks to occupy a seat; the server resolves it (a role pool assigns the next free `<role>-<n>`
 * server-side) and returns the `occupied` seat — or `pending` (an admin must approve) / `refused` (with
 * a no-dead-end hint, ADR 055). The resolved seat is written into `.musterd/binding.json` as the
 * folder's standing claim policy so both the CLI and a (re)launched adapter re-occupy it. No per-seat
 * token is minted — the agent key is the authenticator and a `grant` (`msgr_`) skips the approval lane.
 */
export async function claimCommand(parsed: Parsed): Promise<number> {
  const flags = parsed.flags;
  const config = loadConfig();
  const binding = findBinding();
  const server =
    flagStr(flags, 'server') ?? process.env['MUSTERD_SERVER'] ?? binding?.server ?? config.server;
  const team =
    flagStr(flags, 'team') ?? process.env['MUSTERD_TEAM'] ?? binding?.team ?? config.current;
  if (!team) {
    throw new CliError('no team — run init, or pass --team <slug>', 2);
  }

  // v0.3: claiming presents the TEAM AGENT KEY (mskey_), not a per-seat mint. Resolve it from
  // --key / MUSTERD_AGENT_KEY / this folder's binding.
  const agentKey = flagStr(flags, 'key') ?? process.env['MUSTERD_AGENT_KEY'] ?? binding?.agent_key;
  if (!agentKey) {
    throw new CliError(
      'no agent key — claiming a seat needs the team agent key. Set MUSTERD_AGENT_KEY or pass ' +
        '--key mskey_… (get it from `musterd team create` or a team admin).',
      4,
    );
  }
  const grant = flagStr(flags, 'grant') ?? process.env['MUSTERD_GRANT'] ?? binding?.grant;
  const target = resolveTarget(parsed, binding);
  // The seat the adapter will occupy keeps its harness surface; a bare CLI claim defaults to `cli`.
  const surface = (flagStr(flags, 'surface') ?? binding?.surface ?? 'cli') as Surface;

  const http = new HttpClient({ server, surface });
  const { members } = await http.roster(team);
  const workspace = resolveWorkspace();

  // Consolidated self-service (ADR 087): a bare `musterd claim` (no seat/role given) in a folder whose
  // bound seat is already live *in this workspace* is a "who am I" confirmation, not a re-claim — print
  // the identity and stop, folding whoami into the one verb an agent reaches for. An explicit target, or
  // a seat that's offline or live in another workspace, still runs the claim handshake below.
  const boundSeat = binding ? bindingSeat(binding) : undefined;
  const bareClaim = !parsed.positionals[0] && flagStr(flags, 'role') === undefined;
  if (bareClaim && boundSeat) {
    const liveHere = members
      .find((m) => m.name === boundSeat)
      ?.presences.some((p) => p.status !== 'offline' && p.workspace === workspace);
    if (liveHere) {
      if (flags['json']) {
        process.stdout.write(
          JSON.stringify({ team, member: boundSeat, live: true, already: true }) + '\n',
        );
      } else {
        process.stdout.write(
          `${theme.ok('✓')} ${theme.memberName(boundSeat, 'agent')} — already live on ${theme.accent(team)} ` +
            `in this folder ${theme.dim(`(${surface})`)}\n`,
        );
      }
      return 0;
    }
  }

  // ADR 066 clobber guard (amended by ADR 105). Claiming a *different* seat into a folder silently
  // repoints its binding — fine for a stale/offline seat, a collision when the bound member is live *or
  // held within its reclaim grace* (a reservation that may be reconnecting). Refuse and point at the
  // isolated-workspace path; --force repoints anyway. Checked before the claim, so a refusal is clean.
  const guardTarget = 'seat' in target ? target.seat : null;
  const clobber = liveBindingClobber(binding, members, guardTarget);
  if (clobber && !flags['force']) {
    const status = clobber.reclaimable
      ? `disconnected moments ago and may be reconnecting (within its reclaim grace)`
      : `live right now${clobber.workspace ? ` (live in ${clobber.workspace})` : ''}`;
    throw new CliError(
      `this folder is already bound to ${clobber.member}, who is ${status} — ` +
        `claiming here would evict them and point both sessions at one working tree. ` +
        `Give the new agent its own workspace instead: musterd agent <name> ` +
        `(adds the seat + a git worktree + binding), or run this claim from a separate worktree. ` +
        `Re-run with --force to repoint this folder anyway.`,
      2,
    );
  }

  // Disambiguate which pending session (if any) this claim is for. Informational + lets `--for`
  // scope the marker that gets cleared; the resolved seat is delivered via the resolution sidecar.
  // Scope to *this* workspace so a marker written by a sibling launch sharing the same `.musterd`
  // (or a pre-fix leaked global marker) can't trip the multi-pending guard on an unrelated claim.
  const pendings = listPendingForWorkspace(process.cwd(), team, workspace);
  const forCode = flagStr(flags, 'for');
  if (!forCode && pendings.length > 1) {
    const list = pendings
      .map(
        (p) => `  ${theme.bold(p.code)}  ${p.surface}${p.driver ? ` · driven by ${p.driver}` : ''}`,
      )
      .join('\n');
    throw new CliError(
      `several unclaimed sessions are waiting here — re-run with --for <code>:\n${list}`,
      2,
    );
  }
  const marker: PendingMarker | undefined =
    (forCode ? pendings.find((p) => p.code === forCode) : pendings[0]) ?? undefined;
  if (forCode && !marker) {
    throw new CliError(`no pending session with code "${forCode}" in this folder`, 2);
  }

  const timeoutRaw = flagStr(flags, 'timeout');
  const timeoutS = timeoutRaw !== undefined ? Number(timeoutRaw) : DEFAULT_CLAIM_TIMEOUT_S;
  if (Number.isNaN(timeoutS) || timeoutS < 0) {
    throw new CliError('--timeout must be a non-negative number of seconds', 2);
  }

  // The v0.3 claim handshake (ADR 075/077) over a live WS: `occupied`/`refused` resolve immediately,
  // same as the old one-shot HTTP mirror; `pending` (the seat is held elsewhere) now holds the socket
  // open and waits for the server-pushed terminal frame once an admin decides (`musterd requests
  // decide`) instead of dead-ending the process (the old `http.claim` one-shot mirror's fate).
  return new Promise<number>((resolveP, rejectP) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      process.off('SIGINT', onSigint);
      session.close();
      fn();
    };
    const onSigint = () => {
      finish(() =>
        rejectP(
          new CliError(
            'stopped waiting — the request is still open; approve it with ' +
              '`musterd requests decide <id> --approve` and re-run `musterd claim` once it is',
            130,
          ),
        ),
      );
    };
    process.on('SIGINT', onSigint);

    const session = watchClaim({
      wsUrl: wsBase(server) + '/ws',
      team,
      key: agentKey,
      target,
      surface,
      workspace,
      ...(grant !== undefined ? { grant } : {}),
      onOccupied: (occupiedSeat, _presenceId, resumeGrant, memory) => {
        const seat = occupiedSeat.name;
        // Prefer a freshly-delivered resume token (ADR 087, first approval) over any grant we claimed
        // with, so `binding.grant` carries the reusable token that re-occupies this seat silently.
        const effectiveGrant = resumeGrant ?? grant;
        const next: Binding = {
          server,
          team,
          agent_key: agentKey,
          surface: surface as Binding['surface'],
          // Record the resolved seat as the folder's standing policy so re-launches re-occupy it.
          claim: { mode: 'seat', name: seat },
          ...(effectiveGrant !== undefined ? { grant: effectiveGrant } : {}),
          // Preserve the attested model across the rewrite (ADR 101) — a claim resolves a seat, it
          // never redeclares which model sits in it. Dropping it here reverted a provisioned seat to
          // `unknown` on the next adapter boot.
          ...(binding?.model !== undefined ? { model: binding.model } : {}),
        };
        saveBinding(process.cwd(), next);

        // Bring a matched waiting session online now (ADR 034): hand it the resolved seat via a
        // sidecar its watcher adopts (it already holds the team agent key), then drop the marker.
        let live = false;
        if (marker) {
          writeResolution(process.cwd(), marker.code, { seat });
          consumePending(process.cwd(), marker.code);
          live = true;
        }

        finish(() => {
          if (flags['json']) {
            process.stdout.write(JSON.stringify({ team, member: seat, live }) + '\n');
            resolveP(0);
            return;
          }
          const tail = live
            ? `the waiting ${marker!.surface} session is going online as ${seat} now.`
            : `bound this folder to ${seat}; the agent here will occupy it on launch (or call team_join).`;
          // The continuity one-liner (ADR 093 §3): headline + age, never the body.
          const memLine = memory ? `${renderMemoryLine(memory)}\n` : '';
          process.stdout.write(
            `${theme.ok('✓')} ${theme.memberName(seat, 'agent')} — occupied on ${team}\n` +
              `${theme.dim(tail)}\n` +
              memLine,
          );
          resolveP(0);
        });
      },
      onRefused: (code, message, claimable, hint) => {
        finish(() => {
          const tail = hint ? ` — ${hint}` : '';
          rejectP(new CliError(`claim refused (${code}): ${message}${tail}`, 4));
        });
      },
      onPending: (requestId, message) => {
        if (flags['json']) {
          process.stdout.write(JSON.stringify({ team, pending: true, request: requestId }) + '\n');
        } else {
          process.stdout.write(
            `${theme.meta('⧖')} ${message}\n` +
              theme.dim(
                `waiting for an admin to approve (request ${requestId}) — have an admin run ` +
                  `\`musterd requests decide ${requestId} --approve\`; ^C to stop waiting.`,
              ) +
              '\n',
          );
        }
        if (timeoutS > 0) {
          timer = setTimeout(() => {
            finish(() =>
              rejectP(
                new CliError(
                  `still waiting on request ${requestId} after ${timeoutS}s — check ` +
                    '`musterd requests` and re-run `musterd claim` once it is approved',
                  WAIT_TIMEOUT_EXIT,
                ),
              ),
            );
          }, timeoutS * 1000);
        }
      },
      onDeliver: () => {},
      onError: (msg) => {
        finish(() => rejectP(new CliError(`claim failed: ${msg}`, 1)));
      },
    });
  });
}

function resolveTarget(parsed: Parsed, binding: Binding | null): ClaimSeatTarget {
  const name = parsed.positionals[0];
  const role = flagStr(parsed.flags, 'role');
  if (name && role) {
    throw new CliError('pass a seat name or --role <x>, not both', 2);
  }
  if (name) return { seat: name };
  if (role) return { role };
  // No explicit target → fall back to the folder claim policy (ADR 018 ladder), if any.
  const policy = bindingPolicy(parsed, binding);
  if (policy.mode === 'seat') return { seat: policy.name };
  if (policy.mode === 'role') return { role: policy.role };
  throw new CliError(
    'name the seat to claim: `musterd claim <name>` or `musterd claim --role <role>`',
    2,
  );
}

function bindingPolicy(_parsed: Parsed, binding: Binding | null): ClaimPolicy {
  return binding?.claim ?? { mode: 'chat' };
}
