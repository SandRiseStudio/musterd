import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseRoleFile,
  parseSeatFile,
  parseTeamFile,
  seatNameFromPath,
  serializeRole,
  serializeSeat,
  serializeTeam,
  unknownRosterKeys,
} from '@musterd/protocol';
import type { Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { hint, success, sym } from '../render/ui.js';

/**
 * `musterd fmt [--check]` — the ADR 058 guard-2 (tidiness) tool. Rewrites `.musterd/team.toml` +
 * `seats/*.toml` + `roles/*.toml` to canonical form so PR diffs stay minimal and blame clean; `--check` asserts the
 * committed files are *already* canonical (the CI sibling of `format:check`/the arch-tree drift
 * guard), exiting non-zero with the offending files listed. This is purely cosmetic — correctness
 * rides on the semantic round-trip (guard 1), never on byte-equality of hand edits.
 *
 * ONE SHARP EDGE, pre-existing and uniform across all three classes (measured 2026-08-21; falsify:
 * feed any of parseTeamFile/parseSeatFile/parseRoleFile a file with an unrecognised top-level key
 * and serialize the result — a key that survives means this is fixed). The parsers DROP unknown
 * keys silently, so formatting a file that carries one **deletes** it. Not new here, and roles are
 * no worse than seats or team.toml — but the blast radius includes `roles/` as of 2026-08-21.
 *
 * ~~the hazard is latent rather than active (2026-08-21)~~ **FALSIFIED the same day, by ryder,
 * using the falsifier above.** It is ACTIVE on the live roster: `seats/autorefresh.toml` carries an
 * authored `charter` paragraph and `charter` is in RoleFileSchema but NOT SeatFileSchema, so
 * `musterd fmt` silently deletes 587 characters of human-written prose. Reproduced independently on
 * a copy — raw has `charter`, output does not.
 *
 * My "latent" was drawn from checking only the six ROLE files, which is where my change looked; the
 * live instance was one directory over, in the class fmt had covered all along. Functionally the
 * text is already dead (`members` has no charter column — only `roles` does — so reconcile has been
 * dropping it since 2026-08-05), but it is dead prose a human wrote and may believe is live.
 *
 * PRACTICAL CONSEQUENCE: `musterd fmt` on a roster is not a safe no-op. Diff the writes on a copy
 * before running it anywhere that matters.
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
  // Keys each file carries that its schema does not know — the ones a rewrite would DELETE. Tracked
  // apart from `drifted` on purpose: byte-inequality is cosmetic, a dropped key is data loss, and a
  // guard that reports them with one word teaches the reader to ignore both.
  const dataLoss: Array<{ file: string; keys: string[] }> = [];
  const noteLoss = (rel: string, kind: 'team' | 'seat' | 'role', text: string): void => {
    const keys = unknownRosterKeys(kind, text);
    if (keys.length > 0) dataLoss.push({ file: rel, keys });
  };

  const teamText = readFileSync(teamPath, 'utf8');
  noteLoss('team.toml', 'team', teamText);
  canonical.push(['team.toml', serializeTeam(parseTeamFile(teamText))]);

  const seatsDir = join(dir, 'seats');
  let seatFiles: string[] = [];
  try {
    seatFiles = readdirSync(seatsDir).filter((f) => f.toLowerCase().endsWith('.toml'));
  } catch {
    seatFiles = [];
  }
  for (const f of seatFiles.sort()) {
    const name = seatNameFromPath(f);
    const text = readFileSync(join(seatsDir, f), 'utf8');
    noteLoss(join('seats', f), 'seat', text);
    canonical.push([join('seats', f), serializeSeat(parseSeatFile(text, name))]);
  }

  // Roles are the third durable class the daemon reconciles (ADR 227), and until now the only one
  // with no formatter — so ADR 298's `role create` output was canonical while every hand-written
  // sibling could drift unchecked, and `--check` could not see it. Same stem rule as seats
  // (`seatNameFromPath`), same absence-is-fine handling: a team may define no roles at all.
  const rolesDir = join(dir, 'roles');
  let roleFiles: string[] = [];
  try {
    roleFiles = readdirSync(rolesDir).filter((f) => f.toLowerCase().endsWith('.toml'));
  } catch {
    roleFiles = [];
  }
  for (const f of roleFiles.sort()) {
    const text = readFileSync(join(rolesDir, f), 'utf8');
    noteLoss(join('roles', f), 'role', text);
    canonical.push([join('roles', f), serializeRole(parseRoleFile(text))]);
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
    process.stdout.write(
      JSON.stringify({ check, drifted, dataLoss, total: canonical.length }) + '\n',
    );
    // `dataLoss` deliberately does NOT widen the exit condition, because it cannot: an unknown key
    // is absent from the serialized form, so its file's bytes always differ and every data-loss file
    // is already in `drifted`. Verified, not assumed — a mutation removing `|| dataLoss.length > 0`
    // killed no test, which is what sent me to check the invariant rather than keep defensive dead
    // code. The value here is entirely in SAYING WHICH drifted files are the dangerous kind.
    return check && drifted.length > 0 ? 1 : 0;
  }

  // Data loss is printed FIRST and never folded into the drift list: the drift line ends with "run
  // `musterd fmt`", and running it is exactly what destroys these keys. A reader who acts on the
  // wrong line loses the data the guard was warning about.
  const lossReport = (): string =>
    `${theme.err(sym.err)} ${dataLoss.length} file(s) carry keys no schema knows — ` +
    `\`musterd fmt\` would DELETE these:\n` +
    dataLoss.map((d) => `  ${theme.meta(sym.dot)} ${d.file} — ${d.keys.join(', ')}`).join('\n') +
    `\n${theme.meta('  fix the schema or remove the keys deliberately; do not format past this')}\n`;

  if (check) {
    if (drifted.length === 0 && dataLoss.length === 0) {
      process.stdout.write(success(`${canonical.length} roster file(s) already canonical`) + '\n');
      return 0;
    }
    if (dataLoss.length > 0) process.stdout.write(lossReport());
    if (drifted.length > 0) {
      process.stdout.write(
        `${theme.err(sym.err)} ${drifted.length} roster file(s) are not canonical — run \`musterd fmt\`:\n` +
          drifted.map((d) => `  ${theme.meta(sym.dot)} ${d}`).join('\n') +
          '\n',
      );
    }
    return 1;
  }

  // A WRITE run warns too, before it rewrites anything — this is the last moment anyone sees the
  // keys, because after the write they are gone and the file looks tidy.
  if (dataLoss.length > 0) process.stdout.write(lossReport());

  if (drifted.length === 0) {
    process.stdout.write(success('already canonical — nothing to do') + '\n');
  } else {
    process.stdout.write(
      `${theme.ok(sym.ok)} formatted ${drifted.length} roster file(s):\n` +
        drifted.map((d) => `  ${theme.meta(sym.dot)} ${d}`).join('\n') +
        '\n',
    );
    process.stdout.write(hint('musterd reload — pick up the changes') + '\n');
  }
  return 0;
}
