import type { Parsed } from '../args.js';
import { CliError } from '../errors.js';
import {
  acceptSurface,
  declineSurface,
  isDeclined,
  readDeclined,
  type Tombstone,
} from '../onboard/declined.js';
import {
  claudeRefusableSurfaces,
  removeClaudeSurface,
  SURFACE_STATUSLINE,
} from '../onboard/harnesses/claudeCode.js';
import { theme } from '../render/theme.js';
import { sym } from '../render/ui.js';

/**
 * `musterd surface` — the ADR 332 vocabulary for a **recorded refusal**.
 *
 *   `musterd surface list`            — what can be refused here, and what has been
 *   `musterd surface decline <name>`  — refuse it: remove it if installed, and record that
 *   `musterd surface accept <name>`   — clear the refusal (re-install with `init --refresh-hooks`)
 *
 * The verb exists because provisioning had only *installed* and *absent*, and absence carries no
 * intent. `decline` both removes and records, so one command means one outcome — a user who removes
 * a surface by hand and never runs this still gets the drift line, which is correct: musterd cannot
 * read a mind, only a tombstone.
 */
export function surfaceCommand(parsed: Parsed): number {
  const [sub, name] = parsed.positionals;
  const dir = process.cwd();
  switch (sub) {
    case undefined:
    case 'list':
      return listSurfaces(dir);
    case 'decline':
      return declineOne(dir, requireName(name, 'decline'));
    case 'accept':
      return acceptOne(dir, requireName(name, 'accept'));
    default:
      throw new CliError(`unknown: musterd surface ${sub} — expected list, decline, or accept`, 2);
  }
}

function requireName(name: string | undefined, verb: string): string {
  if (!name) {
    throw new CliError(
      `usage: musterd surface ${verb} <name>  — e.g. ${SURFACE_STATUSLINE}; ` +
        '`musterd surface list` names them all',
      2,
    );
  }
  return name;
}

function listSurfaces(dir: string): number {
  const declined = new Map(readDeclined(dir).map((t) => [t.surface, t]));
  const out: string[] = [];
  for (const s of claudeRefusableSurfaces()) {
    const t = declined.get(s);
    out.push(`  ${s}${t ? '  ' + theme.meta(tombstoneNote(t)) : ''}`);
  }
  // A refusal for a surface this build no longer offers still shows: it is the user's record, and
  // hiding it would make `accept` impossible to spell for a name nothing lists.
  for (const t of declined.values()) {
    if (!claudeRefusableSurfaces().includes(t.surface)) {
      out.push(`  ${t.surface}  ${theme.meta(tombstoneNote(t) + ' — unknown to this build')}`);
    }
  }
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

function tombstoneNote(t: Tombstone): string {
  const day = t.at.slice(0, 10);
  return `declined ${day}${t.by ? ` by ${t.by}` : ''}`;
}

function declineOne(dir: string, name: string): number {
  if (isDeclined(dir, name)) {
    process.stdout.write(`${theme.meta(`${name} is already declined here`)}\n`);
    return 0;
  }
  // Remove as well as record: leaving an installed surface in place while claiming it is refused
  // would make the tombstone a lie about the state of the folder. Refuse the name outright rather
  // than record a refusal we cannot carry out — a tombstone for a surface nothing can remove is the
  // same lie one step removed.
  if (!removeClaudeSurface(dir, name)) {
    throw new CliError(
      `unknown surface: ${name} — \`musterd surface list\` names the ones that can be declined here`,
      2,
    );
  }
  declineSurface(dir, name, process.env['USER']);
  process.stdout.write(
    `${theme.ok(sym.ok)} ${name} declined — musterd will not report it missing here.\n` +
      `  ${theme.meta('`musterd surface accept ' + name + '` to change your mind.')}\n`,
  );
  return 0;
}

function acceptOne(dir: string, name: string): number {
  const removed = acceptSurface(dir, name);
  if (!removed) {
    process.stdout.write(`${theme.meta(`${name} was not declined here — nothing to clear`)}\n`);
    return 0;
  }
  process.stdout.write(
    `${theme.ok(sym.ok)} ${name} no longer declined (was ${tombstoneNote(removed)}).\n` +
      `  ${theme.meta('run `musterd init --refresh-hooks` here to install it.')}\n`,
  );
  return 0;
}
