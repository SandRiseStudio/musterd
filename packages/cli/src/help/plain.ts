/**
 * The plain (uncolored) `HELP` string, derived from the command catalog. This is the guidance-safe
 * form: `scripts/check-guidance.ts` imports it and asserts every skill-named command appears as a
 * `musterd <name>` substring. Because it walks the whole {@link CATALOG}, that invariant holds by
 * construction — adding/renaming a command in one place keeps the check green.
 *
 * Pure string work, no color, no picocolors — so the check stays hermetic (Node native TS, no build).
 */
import { ACTS, CATALOG, GLOBAL_FLAGS, GROUPS } from './catalog.js';

export function renderPlainHelp(): string {
  const lines: string[] = [
    'musterd — muster your agents and humans into persistent teams',
    '',
    'usage:',
  ];

  for (const group of GROUPS) {
    lines.push('', `  ${group.title}:`);
    for (const cmd of CATALOG.filter((c) => c.group === group.id)) {
      const sig = cmd.signature ? ` ${cmd.signature}` : '';
      lines.push(`    musterd ${cmd.name}${sig}`);
      lines.push(`        ${cmd.summary}`);
    }
  }

  lines.push('');
  lines.push('global flags:');
  for (const f of GLOBAL_FLAGS) lines.push(`  ${f.flag}   ${f.summary}`);
  lines.push('');
  lines.push(`acts: ${ACTS.join(' ')}`);
  lines.push('');
  lines.push('musterd help <command>   detail + examples for one command');
  lines.push('musterd help --json      the whole command catalog as JSON');

  return lines.join('\n');
}
