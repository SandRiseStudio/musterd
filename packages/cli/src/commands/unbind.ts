import { autoClaims } from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { HttpClient } from '../client.js';
import { findBinding, removeBinding } from '../config.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';

/**
 * `musterd unbind` — stop occupying this folder's seat without removing it from the team (ADR 058).
 * Clears the daemon-side held state (`bound_at`) + presence so the seat reads *declared* and is freely
 * re-claimable, then deletes this folder's `binding.json`. The committed `seats/<name>.toml` is
 * untouched. This is the clean separation the file model finally allows: `unbind` = "I leave this
 * seat", `team remove` = "this seat should no longer exist".
 */
export async function unbindCommand(parsed: Parsed): Promise<number> {
  const binding = findBinding();
  if (!binding || !autoClaims(binding)) {
    throw new CliError('this folder holds no seat — nothing to unbind', 2);
  }
  const http = new HttpClient({ server: binding.server, key: binding.agent_key });
  const res = await http.unbind(binding.team);
  removeBinding(process.cwd());

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ team: binding.team, member: res.member }) + '\n');
    return 0;
  }
  process.stdout.write(
    `${theme.ok('✓')} unbound ${theme.memberName(res.member, 'agent')} from this folder — the seat stays on ${binding.team}, free to re-claim\n`,
  );
  process.stdout.write(
    theme.meta(
      'the seat is declared, not deleted; to remove it entirely: musterd team remove ' + res.member,
    ) + '\n',
  );
  return 0;
}
