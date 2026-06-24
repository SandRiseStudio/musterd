import { AvailabilityStatusSchema } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';

/**
 * `musterd availability <available|away|dnd> [--until <iso>]` — set your own availability axis
 * (SPEC A.6 Axis 2; ADR 044). Explicit and self-only: never inferred, never set on your behalf.
 * `away --until <iso>` is the `away_until` encoding the roster renders as `off until <ts>`. The
 * notify loop reads this back to tier deliveries (away holds all but `urgent`; dnd passes directed +
 * `urgent`). This is the localhost down-payment; the governed superset is the v0.3 seam.
 */
export async function availabilityCommand(parsed: Parsed): Promise<number> {
  const { team, http } = resolve(parsed.flags);
  const raw = parsed.positionals[0];
  const status = AvailabilityStatusSchema.safeParse(raw);
  if (!status.success) {
    throw new CliError('usage: musterd availability <available|away|dnd> [--until <iso>]', 2);
  }

  const untilStr = flagStr(parsed.flags, 'until');
  let until: number | undefined;
  if (untilStr) {
    if (status.data !== 'away') {
      throw new CliError('--until only applies to `away` (the away_until encoding)', 2);
    }
    const parsedTs = Date.parse(untilStr);
    if (Number.isNaN(parsedTs)) throw new CliError(`--until is not a valid date: ${untilStr}`, 2);
    until = parsedTs;
  }

  const res = await http.setAvailability(team, {
    status: status.data,
    ...(until ? { until } : {}),
  });

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(res.member) + '\n');
    return 0;
  }
  const tail = until ? theme.meta(` until ${new Date(until).toISOString()}`) : '';
  process.stdout.write(
    `${theme.ok('✓')} availability set to ${theme.accent(status.data)}${tail}\n`,
  );
  return 0;
}
