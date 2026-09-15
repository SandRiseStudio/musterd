/*
 * Intents ingest — a document-recorded intention becomes a Seed (ADR 373 increment 2).
 *
 *   pnpm intents:ingest            capture into the daemon via `musterd seed capture --batch -`
 *   pnpm intents:ingest --dry-run  print the JSON lines and capture nothing
 *
 * The same scan `intents:check` runs, read the other way round. The gate asks "does this sentence
 * name a disposition?"; this asks "what has been captured and never promoted?" and hands the answer
 * to the Seed tray, where `team_seed_list` (and, per increment 4, `next`) already show it. Every
 * forward reference that is not noise and not disposed `none` becomes a Seed keyed on its repo
 * path + anchor: an undisposed or deferred one lands OPEN; one whose `Follows-up:` names a lane
 * lands PROMOTED with `linked_lane_id` set, which is the seed → lane provenance edge ADR 248 built.
 *
 * Idempotent: the daemon returns the existing Seed for a `ref` it has seen, body untouched. Run it
 * after every merge, or never — either way nothing is captured twice.
 *
 * Capture, never interpret (ADR 248): the body is the line as written and where it was written.
 * Runs on Node's native TypeScript (no build step, no deps), like its sibling gates.
 */
import { spawnSync } from 'node:child_process';
import { collectForwardReferences, repoRoot } from './intents-corpus.ts';
import { ingestCandidates } from './intents.ts';

const dryRun = process.argv.includes('--dry-run');
const candidates = ingestCandidates(collectForwardReferences());
const lines = candidates
  .map(({ ref, body, lane_id }) => JSON.stringify(lane_id ? { ref, body, lane_id } : { ref, body }))
  .join('\n');

const byKind = { undisposed: 0, deferred: 0, lane: 0 };
for (const c of candidates) byKind[c.kind] += 1;
const summary =
  `${candidates.length} intention(s): ${byKind.undisposed} undisposed, ${byKind.deferred} deferred, ` +
  `${byKind.lane} already naming a lane`;

if (dryRun) {
  process.stdout.write(lines + (lines ? '\n' : ''));
  process.stderr.write(`intents:ingest --dry-run — ${summary}; nothing captured\n`);
  process.exit(0);
}

const bin = process.env['MUSTERD_BIN'] ?? 'musterd';
const run = spawnSync(bin, ['seed', 'capture', '--batch', '-'], {
  cwd: repoRoot,
  input: lines + '\n',
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (run.error) {
  process.stderr.write(
    `✗ intents:ingest — could not run \`${bin}\`: ${run.error.message}\n` +
      `    set MUSTERD_BIN, or run from a folder \`musterd init\` has bound to a team\n`,
  );
  process.exit(1);
}
process.stderr.write(`intents:ingest — ${summary}\n`);
process.exit(run.status ?? 1);
