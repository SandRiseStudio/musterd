import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSeatFile,
  parseTeamFile,
  seatNameFromPath,
  serializeSeat,
  serializeTeam,
} from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';

/**
 * `musterd fmt [--check]` — the ADR 058 guard-2 (tidiness) tool. Rewrites `.musterd/team.toml` +
 * `seats/*.toml` to canonical form so PR diffs stay minimal and blame clean; `--check` asserts the
 * committed files are *already* canonical (the CI sibling of `format:check`/the arch-tree drift
 * guard), exiting non-zero with the offending files listed. This is purely cosmetic — correctness
 * rides on the semantic round-trip (guard 1), never on byte-equality of hand edits.
 */
export async function fmtCommand(parsed: Parsed, baseDir: string = process.cwd()): Promise<number> {
  const check = Boolean(parsed.flags['check']);
  const dir = join(baseDir, '.musterd');
  const teamPath = join(dir, 'team.toml');
  if (!existsSync(teamPath)) {
    throw new CliError(
      'no .musterd/team.toml here — run `musterd fmt` in a file-backed team folder',
      2,
    );
  }

  // (relativePath, canonical) for every durable file under .musterd/.
  const canonical: Array<[string, string]> = [];
  canonical.push(['team.toml', serializeTeam(parseTeamFile(readFileSync(teamPath, 'utf8')))]);

  const seatsDir = join(dir, 'seats');
  let seatFiles: string[] = [];
  try {
    seatFiles = readdirSync(seatsDir).filter((f) => f.toLowerCase().endsWith('.toml'));
  } catch {
    seatFiles = [];
  }
  for (const f of seatFiles.sort()) {
    const name = seatNameFromPath(f);
    const seat = parseSeatFile(readFileSync(join(seatsDir, f), 'utf8'), name);
    canonical.push([join('seats', f), serializeSeat(seat)]);
  }

  const drifted: string[] = [];
  for (const [rel, want] of canonical) {
    const abs = join(dir, rel);
    const have = readFileSync(abs, 'utf8');
    if (have === want) continue;
    drifted.push(rel);
    if (!check) writeFileSync(abs, want, 'utf8');
  }

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ check, drifted, total: canonical.length }) + '\n');
    return check && drifted.length > 0 ? 1 : 0;
  }

  if (check) {
    if (drifted.length === 0) {
      process.stdout.write(`${theme.ok('✓')} ${canonical.length} roster file(s) are canonical\n`);
      return 0;
    }
    process.stdout.write(
      `${theme.err('✗')} ${drifted.length} roster file(s) are not canonical — run \`musterd fmt\`:\n` +
        drifted.map((d) => `  ${d}`).join('\n') +
        '\n',
    );
    return 1;
  }

  if (drifted.length === 0) {
    process.stdout.write(`${theme.ok('✓')} already canonical — nothing to do\n`);
  } else {
    process.stdout.write(
      `${theme.ok('✓')} formatted ${drifted.length} roster file(s):\n` +
        drifted.map((d) => `  ${d}`).join('\n') +
        '\n',
    );
  }
  return 0;
}
