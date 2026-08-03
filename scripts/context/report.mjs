/*
 * Report the DYNAMIC half of the standing context (spec 2026-08-03) — what the installed hooks
 * actually print when executed, beyond the static nudge constants `pnpm context:check` gates.
 *
 *   node scripts/context/report.mjs
 *
 * Informational only: never a nonzero exit for size. The dynamic share (init --check-build text,
 * label-nudge output, wire/init fix lines) depends on machine state (`musterd`/`claude` on PATH,
 * daemon freshness), so it cannot be a CI gate — but it is exactly what a real seat's context
 * pays, so the baseline doc cites it alongside the static table.
 *
 * Method: install the hooks into a throwaway CLAUDE_CONFIG_DIR + cwd (so the real ~/.claude is
 * never touched), then run each captured command the way the harness would — `bash -c`, with
 * CLAUDE_PROJECT_DIR pointing at a fixture folder carrying the `musterd:start` primer marker.
 *
 * Needs `pnpm build` first (imports packages/cli/dist).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const distUrl = (rel) => pathToFileURL(join(repoRoot, rel)).href;

let installMusterdHooks, HOOK_NUDGE_TEXTS;
try {
  ({ installMusterdHooks, HOOK_NUDGE_TEXTS } = await import(
    distUrl('packages/cli/dist/onboard/harnesses/claudeCode.js')
  ));
} catch (err) {
  console.error(
    `context report: failed to import packages/cli/dist — run \`pnpm build\` first.\n${String(err)}`,
  );
  process.exit(1);
}

// Install into throwaway dirs; capture the exact commands the harness would run.
const configDir = mkdtempSync(join(tmpdir(), 'musterd-context-config-'));
const hookCwd = mkdtempSync(join(tmpdir(), 'musterd-context-cwd-'));
const fixture = mkdtempSync(join(tmpdir(), 'musterd-context-fixture-'));
writeFileSync(
  join(fixture, 'AGENTS.md'),
  '<!-- musterd:start -->\nfixture primer body\n<!-- musterd:end -->\n',
  'utf8',
);
mkdirSync(join(hookCwd, '.claude'), { recursive: true });

const prevCwd = process.cwd();
const prevConfig = process.env.CLAUDE_CONFIG_DIR;
let commands = {};
try {
  process.env.CLAUDE_CONFIG_DIR = configDir;
  process.chdir(hookCwd);
  installMusterdHooks();
  const global = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf8'));
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const cmd = global.hooks?.[event]?.[0]?.hooks?.[0]?.command;
    if (cmd) commands[event] = cmd;
  }
} finally {
  process.chdir(prevCwd);
  if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfig;
}

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const staticBytes = {
  SessionStart:
    bytes(HOOK_NUDGE_TEXTS.orientation_joined) +
    bytes(HOOK_NUDGE_TEXTS.orientation_wire_fix) +
    bytes(HOOK_NUDGE_TEXTS.orientation_init_fix),
  UserPromptSubmit: bytes(HOOK_NUDGE_TEXTS.prompt_submit_ritual),
};

console.log('standing-context dynamic report (executed hooks, fixture folder)\n');
for (const [event, command] of Object.entries(commands)) {
  let out = '';
  try {
    out = execFileSync('bash', ['-c', command], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: fixture },
      encoding: 'utf8',
      timeout: 15_000,
    });
  } catch (err) {
    // Hooks exit 0 by contract; a non-zero here is machine state (e.g. no bash) — report and move on.
    out = typeof err.stdout === 'string' ? err.stdout : '';
  }
  const printed = bytes(out);
  console.log(`${event}:`);
  console.log(`  printed          ${printed} B  (~${Math.round(printed / 4)} tok)`);
  console.log(
    `  static constants ${staticBytes[event]} B (worst-case sum; branches are exclusive)`,
  );
  console.log(`  output:\n${out.trim().replace(/^/gm, '    ') || '    (empty)'}\n`);
}
console.log(
  'Note: the printed size is per SESSION for SessionStart and per TURN for UserPromptSubmit;\n' +
    'dynamic clauses (init --check-build, label-nudge) vary with machine state.',
);

for (const d of [configDir, hookCwd, fixture]) rmSync(d, { recursive: true, force: true });
