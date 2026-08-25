import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Parsed } from '../args.js';
import { CliError } from '../errors.js';
import {
  BUILTIN_TOOLKITS,
  GENERALIST,
  isBuiltin,
  toolkitHomes,
  listToolkitNames,
  loadToolkit,
  userToolkitsDir,
  type Toolkit,
} from '../onboard/toolkit.js';
import { theme } from '../render/theme.js';
import { success, sym } from '../render/ui.js';

/**
 * **Workspace equipment, and nothing else** (ADR 296). A toolkit is what a workspace is equipped
 * with — MCP servers, tools, allow-entries — and it carries *no authority*: it is the "installed"
 * layer of ADR 261's three, sitting under "allowed" (harness permissions) and "authorized"
 * (team-granted capability). Splitting this out of `musterd role` is what ends the two-worlds-
 * under-one-name seam ADR 272 left and ADR 296 named.
 *
 * Derivation flows one way (ADR 296 §1.3): a role may name a default toolkit; a toolkit may never
 * assert a role. That is why nothing here reads the roster, and why being inside a roster home
 * changes nothing about what `create` writes.
 */
export function toolkitCommand(parsed: Parsed): number {
  const sub = parsed.positionals[0];
  if (sub === 'list') return toolkitList(parsed);
  if (sub === 'show') return toolkitShow(parsed);
  if (sub === 'create') return toolkitCreate(parsed);
  throw new CliError('usage: musterd toolkit <list|show|create> ...', 2);
}

/** Where a name came from: a user file shadowing a built-in is an *override* (loadToolkit prefers it). */
function originOf(dir: string, name: string): 'built-in' | 'override' | 'user' {
  const userFile = toolkitHomes(dir).some((home) => existsSync(join(home, `${name}.json`)));
  if (!userFile) return 'built-in';
  return isBuiltin(name) ? 'override' : 'user';
}

function toolkitList(parsed: Parsed): number {
  const dir = process.cwd();
  const rows = listToolkitNames(dir).map((name) => ({ name, origin: originOf(dir, name) }));

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ toolkits: rows }) + '\n');
    return 0;
  }
  process.stdout.write(`${theme.accent('workspace toolkits')} ${theme.meta(`(in ${dir})`)}\n`);
  for (const { name, origin } of rows) {
    const tag =
      origin === 'built-in'
        ? theme.meta('built-in')
        : origin === 'override'
          ? theme.accent('overrides built-in')
          : theme.ok('user');
    const note = name === GENERALIST ? theme.meta(' — nothing extra') : '';
    process.stdout.write(`  ${theme.meta(sym.bullet)} ${name}  ${tag}${note}\n`);
  }
  process.stdout.write(
    theme.meta(
      `inspect with: musterd toolkit show <name>   ${sym.dot}   scaffold: musterd toolkit create <name>`,
    ) + '\n',
  );
  return 0;
}

function toolkitShow(parsed: Parsed): number {
  const name = parsed.positionals[1];
  if (!name) throw new CliError('usage: musterd toolkit show <name>', 2);

  let toolkit: Toolkit;
  try {
    toolkit = loadToolkit(process.cwd(), name);
  } catch (err) {
    throw new CliError((err as Error).message, 4);
  }

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify(toolkit, null, 2) + '\n');
    return 0;
  }
  const origin = originOf(process.cwd(), name);
  process.stdout.write(
    `${theme.accent(toolkit.toolkit)} ${theme.meta(
      origin === 'override'
        ? '(user file, overrides the built-in)'
        : origin === 'built-in'
          ? '(built-in)'
          : '(user)',
    )}\n`,
  );
  if (toolkit.capacity) process.stdout.write(`  capacity: ${toolkit.capacity}\n`);
  process.stdout.write(`  charter:\n${indent(toolkit.charter, 4)}\n`);
  const { mcp_servers, resource_scopes, permissions } = toolkit.tools;
  process.stdout.write(
    `  mcp servers: ${mcp_servers.length ? mcp_servers.map((s) => s.name).join(', ') : theme.meta('none')}\n`,
  );
  process.stdout.write(
    `  resource scopes: ${resource_scopes.length ? resource_scopes.join(', ') : theme.meta('none')} ${theme.meta('(declared — coordination, not a sandbox)')}\n`,
  );
  const permParts = (['allow', 'ask', 'deny'] as const)
    .filter((k) => permissions[k].length)
    .map((k) => `${k}=[${permissions[k].join(', ')}]`);
  process.stdout.write(
    `  permissions: ${permParts.length ? permParts.join('  ') : theme.meta('none')}\n`,
  );
  return 0;
}

export function toolkitCreate(parsed: Parsed): number {
  const name = parsed.positionals[1];
  if (!name)
    throw new CliError('usage: musterd toolkit create <name> [--from <built-in>] [--force]', 2);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new CliError(
      `invalid toolkit name "${name}" — use lowercase letters, numbers, hyphens`,
      2,
    );
  }
  const dir = process.cwd();
  const path = join(userToolkitsDir(dir), `${name}.json`);
  if (existsSync(path) && !parsed.flags['force']) {
    throw new CliError(`${path} already exists — pass --force to overwrite`, 1);
  }

  const from = typeof parsed.flags['from'] === 'string' ? parsed.flags['from'] : undefined;
  const template = from ? fromBuiltin(from, name) : skeleton(name);

  mkdirSync(userToolkitsDir(dir), { recursive: true });
  writeFileSync(path, JSON.stringify(template, null, 2) + '\n', 'utf8');

  if (parsed.flags['json']) {
    process.stdout.write(JSON.stringify({ path, from: from ?? null }) + '\n');
    return 0;
  }
  process.stdout.write(
    success(`wrote ${theme.accent(path)}${from ? theme.meta(` (from built-in "${from}")`) : ''}`, {
      next: 'musterd init',
    }) + '\n',
  );
  process.stdout.write(
    theme.meta(
      'edit it, then provision it via `musterd init` (it overrides a built-in of the same name)',
    ) + '\n',
  );
  return 0;
}

function fromBuiltin(from: string, name: string): Toolkit {
  const base = BUILTIN_TOOLKITS[from];
  if (!base) {
    throw new CliError(
      `unknown built-in "${from}" — one of: ${Object.keys(BUILTIN_TOOLKITS).join(', ')}`,
      2,
    );
  }
  return { ...structuredClone(base), toolkit: name };
}

function skeleton(name: string): Toolkit {
  return {
    toolkit: name,
    charter: `TODO: one or two lines of lens-not-résumé charter for ${name}.`,
    tools: {
      mcp_servers: [],
      resource_scopes: [],
      permissions: { allow: [], ask: [], deny: [] },
    },
  };
}

function indent(text: string, n: number): string {
  const pad = ' '.repeat(n);
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}
