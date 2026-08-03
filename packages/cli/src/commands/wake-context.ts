import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';

/** Read ADR 204's bounded wake orientation index without loading an Act or memory body. */
export async function wakeContextCommand(parsed: Parsed): Promise<number> {
  const act = flagStr(parsed.flags, 'act');
  const lane = flagStr(parsed.flags, 'lane');
  if ((act === undefined) === (lane === undefined)) {
    throw new CliError('usage: musterd wake-context --act <id> | --lane <id>', 2);
  }
  const { team, http } = resolve(parsed.flags);
  const context = await http.wakeContext(team, act ? { act_id: act } : { lane_id: lane! });
  if (parsed.flags.json) {
    process.stdout.write(JSON.stringify(context) + '\n');
    return 0;
  }
  const target = context.wake.act_id ?? context.wake.lane_id;
  process.stdout.write(
    `${theme.accent(`wake ${context.wake.kind}`)} ${theme.meta(`· ${target}`)}\n` +
      `${theme.meta(`objective: ${context.objective.action} · delivery: ${context.delivery.requirement}/${context.delivery.intended}`)}\n` +
      `${theme.meta(`explicit fetch: ${context.fetch.join(', ')}`)}\n`,
  );
  return 0;
}
