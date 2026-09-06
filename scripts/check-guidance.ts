/*
 * Guidance drift check (ADR 085 / docs/decisions/085-layered-guidance-surface.md).
 *
 *   pnpm guidance:check   — fail (exit 1) if the on-demand skill names a command/tool that no longer
 *                            exists, so a rename can't silently rot the skill.
 *
 * The layering doctrine (ADR 085) allows exactly one kind of duplication between the skill and the
 * rest of the system: command and tool *names*. This gate makes that duplication safe by verifying it
 * mechanically — every name the skill claims in `SKILL_CLI_COMMANDS` must still appear in the CLI
 * `HELP`, and every name in `SKILL_MCP_TOOLS` must still be a registered MCP tool (`TOOL_NAMES`, which
 * `mcp.test.ts` pins to the live server registry). Rename a command/tool and this fails at build/check
 * time instead of shipping a skill that tells an agent to run something that isn't there.
 *
 * Hermetic (the `check-arch-trees.ts` / `check-obs-evals.ts` pattern): imports the names straight from
 * dependency-light source modules, runs on Node's native TypeScript, no build step, no extra deps.
 *
 * ## This check is deliberately one-directional — do not "fix" that
 * It asserts every name the skill CLAIMS still exists. It does NOT assert the converse (every
 * registered tool/command is named by the skill), and it must not: the skill is a playbook, not an
 * index. It names what an agent needs mid-loop and stays silent on the rest (`team_seed_*`,
 * `team_report`, ops commands) precisely so it can be read in one sitting — ADR 085's whole point.
 * The cost of the asymmetry is real and was paid once: `team_availability` shipped and the skill
 * taught only the CLI form for an epoch, invisible to this gate (lane 01M1VD1CQV). The remedy is a
 * human reading the surface map when a tool lands, not a gate that would force every new tool into
 * the playbook.
 */
import { CATALOG } from '../packages/cli/src/help/catalog.ts';
import { TOOL_NAMES } from '../packages/mcp/src/toolNames.ts';
import { SKILL_CLI_COMMANDS, SKILL_MCP_TOOLS } from '../packages/protocol/src/guidance.ts';

const problems: string[] = [];

// Every CLI command the skill names must exist in the CLI command catalog (help/catalog.ts) — the
// single source of truth the `HELP` text and both help renderers derive from. Importing the catalog
// leaf (which has zero relative imports) keeps this check hermetic on Node's native TypeScript.
const commandNames = new Set(CATALOG.map((c) => c.name));
for (const cmd of SKILL_CLI_COMMANDS) {
  if (!commandNames.has(cmd)) {
    problems.push(
      `skill names \`musterd ${cmd}\` but it is not in the CLI command catalog ` +
        `(packages/cli/src/help/catalog.ts) — renamed/removed? update SKILL_CLI_COMMANDS + the skill ` +
        `body in packages/protocol/src/guidance.ts.`,
    );
  }
}

// Every MCP tool the skill names must be a registered tool.
const tools = new Set<string>(TOOL_NAMES);
for (const tool of SKILL_MCP_TOOLS) {
  if (!tools.has(tool)) {
    problems.push(
      `skill names the MCP tool \`${tool}\` but it is not registered (packages/mcp/src/toolNames.ts) — ` +
        `renamed/removed? update SKILL_MCP_TOOLS + the skill body in packages/protocol/src/guidance.ts.`,
    );
  }
}

if (problems.length > 0) {
  console.error('✗ guidance drift — the skill references names that no longer exist:\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nThe skill must only name commands/tools that exist (ADR 085).');
  process.exit(1);
}

console.log(
  `✓ guidance names are current — ${SKILL_CLI_COMMANDS.length} CLI command(s) + ` +
    `${SKILL_MCP_TOOLS.length} MCP tool(s) referenced by the skill all resolve.`,
);
