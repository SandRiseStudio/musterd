import type { NodeSummary } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { heading, success } from '../render/ui.js';
import { resolve, resolveRead } from './helpers.js';

/**
 * `musterd node <invite|join|rotate|revoke|list>` — the machine credential (ADR 328), increment 3a
 * of the ADR 325 federation build.
 *
 * `join` does **not** call the hub. It asks THIS machine's daemon to enroll itself: the daemon
 * holds the v47 `nodes` row whose id gets presented (ADR 331 §Decision 1) and is what will hold the
 * credential, so letting the CLI write that state behind it would put two processes on one file.
 * It is also why join needs no admin identity here — the code is the authority, and the local
 * daemon refuses anything off-machine.
 */

const USAGE =
  'usage:\n' +
  '  musterd node invite [--label "<what machine>"]\n' +
  '  musterd node join <hub-url> <msinv_code>\n' +
  '  musterd node rotate <node-id>\n' +
  '  musterd node revoke <node-id>\n' +
  '  musterd node list [--json]';

function renderNode(n: NodeSummary): string {
  const state = n.revoked_at
    ? theme.warn('revoked')
    : n.enrolled_at
      ? theme.ok('enrolled')
      : theme.meta('local');
  const seen = n.last_seen_at
    ? theme.meta(` last seen ${new Date(n.last_seen_at).toISOString()}`)
    : '';
  // The token KIND, never a slice of the secret — enough to say "this one has a credential".
  const cred = n.credential_prefix ? theme.meta(` ${n.credential_prefix}…`) : '';
  return `  ${theme.meta(n.id)} ${state} "${n.label}"${cred}${seen}`;
}

export async function nodeCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];

  if (sub === 'invite') {
    const { team, http } = resolve(parsed.flags);
    const label = flagStr(parsed.flags, 'label') ?? 'unnamed machine';
    const minted = await http.nodeInvite(team, label);
    const minutes = Math.max(1, Math.round((minted.expires_at - Date.now()) / 60_000));
    process.stdout.write(
      success('enrollment code minted — copy it now, it is not shown again', {
        next: `on the joining machine: musterd node join <this-hub-url> ${minted.invite}`,
      }) +
        '\n' +
        `  ${minted.invite}\n` +
        theme.warn(`  single use, expires in ${minutes} minutes\n`),
    );
    return 0;
  }

  if (sub === 'join') {
    const hubUrl = parsed.positionals[1];
    const code = parsed.positionals[2];
    if (!hubUrl || !code) throw new CliError(USAGE, 2);
    // `resolveRead`, not `resolve`: enrolling a machine is authorised by the invite code and by
    // being on this machine, not by holding an admin seat. A fresh laptop may have no bound
    // identity yet, and refusing there would make the ceremony need a credential it was designed
    // to avoid.
    const { team, http } = resolveRead(parsed.flags);
    const enrolled = await http.nodeEnroll({ hub_url: hubUrl, code, team });
    process.stdout.write(
      success(`this machine is enrolled with ${hubUrl}`, {
        next: 'musterd node list  (on the hub, to see it)',
      }) +
        '\n' +
        `  ${theme.meta(enrolled.node_id)} ${theme.meta(`team ${enrolled.team}`)}\n` +
        // Deliberately not printed: the credential. It went to ~/.musterd/node.json at 0600, and a
        // long-lived machine secret does not belong in terminal scrollback.
        theme.meta('  credential written to ~/.musterd/node.json (0600)\n'),
    );
    return 0;
  }

  if (sub === 'rotate') {
    const nodeId = parsed.positionals[1];
    if (!nodeId) throw new CliError(USAGE, 2);
    const { team, http } = resolve(parsed.flags);
    const rotated = await http.nodeRotate(team, nodeId);
    process.stdout.write(
      success('credential rotated — copy it now, it is not shown again', {
        // The id is unchanged on purpose: every origin stamp already in the log still names it.
        next: `on ${nodeId}: re-run musterd node join with a fresh invite, or write the new credential to ~/.musterd/node.json`,
      }) +
        '\n' +
        `  ${rotated.node_credential}\n`,
    );
    return 0;
  }

  if (sub === 'revoke') {
    const nodeId = parsed.positionals[1];
    if (!nodeId) throw new CliError(USAGE, 2);
    const { team, http } = resolve(parsed.flags);
    const { revoked } = await http.nodeRevoke(team, nodeId);
    process.stdout.write(
      revoked
        ? success(`node ${nodeId} revoked — push, pull and claim refuse it now`) +
            '\n' +
            theme.meta(
              '  events it already sent stay: they are attested history, not a claim being withdrawn.\n' +
                '  lanes its seats hold are NOT released — that stays a human call.\n',
            )
        : theme.meta(`nothing to do — node ${nodeId} is already revoked or unknown\n`),
    );
    return 0;
  }

  if (sub === 'list') {
    const { team, http } = resolveRead(parsed.flags);
    const { nodes } = await http.nodes(team);
    if (parsed.flags['json']) {
      process.stdout.write(`${JSON.stringify({ nodes }, null, 2)}\n`);
      return 0;
    }
    if (nodes.length === 0) {
      process.stdout.write(theme.meta('no nodes — this team has never been enrolled anywhere\n'));
      return 0;
    }
    process.stdout.write(`${heading(`nodes on ${team}`)}\n${nodes.map(renderNode).join('\n')}\n`);
    return 0;
  }

  throw new CliError(USAGE, 2);
}
