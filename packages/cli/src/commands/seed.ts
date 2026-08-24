import { readFileSync } from 'node:fs';
import { SeedBriefSchema, seedInActiveTray, type Seed } from '@musterd/protocol';
import { flagStr, type Parsed } from '../args.js';
import { CliError } from '../errors.js';
import { theme } from '../render/theme.js';
import { resolve } from './helpers.js';

const USAGE =
  'usage:\n' +
  '  musterd seed list [--history] [--json]\n' +
  '  musterd seed show <id> [--json]\n' +
  '  musterd seed claim <id>\n' +
  '  musterd seed ask <id> "<question>"\n' +
  '  musterd seed answer <id> "<answer>"\n' +
  '  musterd seed brief <id> --file <path>\n' +
  '  musterd seed conclude <id> --file <path> "<conclusion>"\n' +
  '  musterd seed promote <id> [--title <title>] [--detail <detail>]';

export async function seedCommand(parsed: Parsed): Promise<number> {
  const sub = parsed.positionals[0];
  const id = parsed.positionals[1];
  const { team, http } = resolve(parsed.flags);

  if (sub === 'list') {
    const seeds = await http.seeds(team);
    const visible = parsed.flags['history'] === true ? seeds : seeds.filter(seedInActiveTray);
    if (parsed.flags['json'] === true) {
      process.stdout.write(JSON.stringify({ seeds: visible }) + '\n');
    } else if (visible.length === 0) {
      process.stdout.write("no active Seeds — send an idea through the Team's Slack capture\n");
    } else {
      for (const seed of visible) process.stdout.write(renderSeed(seed) + '\n');
    }
    return 0;
  }

  if (sub === 'show' && id) {
    const seed = await http.seed(team, id);
    if (parsed.flags['json'] === true) process.stdout.write(JSON.stringify({ seed }) + '\n');
    else process.stdout.write(renderSeedDetail(seed) + '\n');
    return 0;
  }

  if (!id) throw new CliError(USAGE, 2);

  if (sub === 'claim') {
    const seed = await http.claimSeed(team, id);
    process.stdout.write(
      `${theme.ok('✓')} Seed ${seed.id} — exploring as ${seed.explorer ?? 'unowned'}\n`,
    );
    return 0;
  }

  if (sub === 'ask') {
    const question = parsed.positionals[2];
    if (!question) throw new CliError(USAGE, 2);
    const seed = await http.askSeed(team, id, question);
    process.stdout.write(`${theme.ok('✓')} Seed ${seed.id} — waiting for ${seed.submitted_by}\n`);
    return 0;
  }

  if (sub === 'answer') {
    const answer = parsed.positionals[2];
    if (!answer) throw new CliError(USAGE, 2);
    const seed = await http.answerSeed(team, id, answer);
    process.stdout.write(`${theme.ok('✓')} Seed ${seed.id} — clarified\n`);
    return 0;
  }

  if (sub === 'brief' || sub === 'conclude') {
    const brief = readBrief(flagStr(parsed.flags, 'file'));
    const conclusion = parsed.positionals[2];
    if (sub === 'conclude' && !conclusion) throw new CliError(USAGE, 2);
    const seed = await http.submitSeed(
      team,
      id,
      sub === 'brief'
        ? { result: 'promote', brief }
        : { result: 'complete', brief, conclusion: conclusion! },
    );
    process.stdout.write(
      sub === 'brief'
        ? `${theme.ok('✓')} Seed ${seed.id} — promoted to Lane ${seed.linked_lane_id}\n`
        : `${theme.ok('✓')} Seed ${seed.id} — completed\n`,
    );
    return 0;
  }

  if (sub === 'promote') {
    const seed = await http.promoteSeed(team, id, {
      ...(flagStr(parsed.flags, 'title') ? { title: flagStr(parsed.flags, 'title')! } : {}),
      ...(flagStr(parsed.flags, 'detail') ? { detail: flagStr(parsed.flags, 'detail')! } : {}),
    });
    process.stdout.write(
      `${theme.ok('✓')} Seed ${seed.id} — promoted to Lane ${seed.linked_lane_id}\n`,
    );
    return 0;
  }

  throw new CliError(USAGE, 2);
}

function readBrief(path: string | undefined) {
  if (!path) throw new CliError(USAGE, 2);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CliError(`can't read Seed brief JSON from ${path}`, 2);
  }
  const parsed = SeedBriefSchema.safeParse(raw);
  if (!parsed.success) throw new CliError('Seed brief does not match the protocol schema', 2);
  return parsed.data;
}

function renderSeed(seed: Seed): string {
  const state =
    seed.state === 'completed' || seed.state === 'promoted'
      ? theme.ok(seed.state)
      : seed.state === 'needs_clarification'
        ? theme.warn(seed.state)
        : seed.state;
  const body = seed.body.replace(/\s+/g, ' ').trim();
  const explorer = seed.explorer ? ` — ${seed.explorer}` : '';
  return `${theme.meta(seed.id)} ${state}${explorer} · ${body}`;
}

function renderSeedDetail(seed: Seed): string {
  const thread = seed.thread.map((entry) => `  ${entry.kind} · ${entry.by}: ${entry.body}`);
  return [
    renderSeed(seed),
    `  submitted by ${seed.submitted_by} via Slack`,
    ...thread,
    ...(seed.conclusion ? [`  conclusion: ${seed.conclusion}`] : []),
    ...(seed.linked_lane_id ? [`  Lane: ${seed.linked_lane_id}`] : []),
  ].join('\n');
}
