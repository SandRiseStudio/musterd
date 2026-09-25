/*
 * ADR 447 — move this machine onto the team-first layout:
 *
 *   node scripts/layout/migrate.ts            # plan only: every step, every path, nothing written
 *   node scripts/layout/migrate.ts --apply    # do it (announce first: bounces the host AND every
 *                                             #   seat session whose folder moves — including yours)
 *
 * Run it from a shell whose `node` is ≥22 and NOT from inside a folder that moves — `cd ~` first.
 * Idempotent: a step whose source is gone and target present is skipped, so a run interrupted
 * half-way is resumed by running it again. Every file it rewrites is backed up to
 * `~/.musterd/backups/layout-<ts>/` first.
 *
 * What is path-keyed on this machine, and what happens to each (the inventory lives in
 * docs/wiki/workspace-layout.md):
 *   1. LaunchAgents whose plist names a moving folder, plus the host (it wakes seats in their
 *      Workspace and reads the registry once) — booted out, rewritten in place, bootstrapped again.
 *   2. `~/musterd/<repo>/<member>` → `~/musterd/<team>/<repo>/<member>`, for every bound member
 *      Workspace; the team root's own `.musterd/binding.json` deleted (a root is a roof).
 *   3. `git worktree repair` from each moved worktree's main checkout, with every new path.
 *   4. `~/.musterd/config.json` bindings registry re-keyed (root entries dropped, `teamHome` moved
 *      off the root); host-registry.json, harness-ledger.json, stream/image.json and the ~/.musterd
 *      shell scripts rewritten.
 *   5. `~/.claude.json` re-keyed (projects, mcpServers args, githubRepoPaths);
 *      `~/.claude/projects/<slug>` transcript folders renamed; each moved Workspace's own harness
 *      configs (`.codex/config.toml`, `.opencode/opencode.json`, `.cursor/mcp.json`, …) rewritten.
 *   6. The team root's `.gitignore` (it is the roster repo) told to ignore the trees beneath it.
 */
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  type BoundFolder,
  claudeProjectMove,
  mapPath,
  memberMoves,
  rewriteJson,
  rewritePaths,
  rewriteRegistry,
  teamRoots,
} from './plan.ts';

const APPLY = process.argv.includes('--apply');
const HOST_LABEL = 'studio.sandrise.musterd-host';

const home = homedir();
const launchAgents = join(home, 'Library', 'LaunchAgents');
const musterdHome = join(home, '.musterd');
const configPath = join(musterdHome, 'config.json');
const backupDir = join(
  musterdHome,
  'backups',
  `layout-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);

let failures = 0;
const say = (line: string): void => void process.stdout.write(line + '\n');
const step = (n: number, title: string): void => say(`\n${APPLY ? '▶' : '·'} ${n}. ${title}`);
const plan = (line: string): void => say(`    ${line}`);

function sh(cmd: string, args: string[], opts: { cwd?: string; ok?: number[] } = {}): string {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8' });
  if (r.status !== 0 && !(opts.ok ?? []).includes(r.status ?? -1)) {
    failures++;
    say(`    ✗ ${cmd} ${args.join(' ')} → exit ${r.status}: ${(r.stderr || r.stdout).trim()}`);
  }
  return (r.stdout ?? '').trim();
}

function backup(file: string): void {
  if (!existsSync(file)) return;
  mkdirSync(backupDir, { recursive: true });
  cpSync(file, join(backupDir, basename(file)));
}

function rewriteFile(file: string, mapping: Map<string, string>): boolean {
  if (!existsSync(file)) return false;
  const before = readFileSync(file, 'utf8');
  const after = rewritePaths(before, mapping);
  if (before === after) return false;
  plan(`rewrite ${file}`);
  if (!APPLY) return true;
  backup(file);
  writeFileSync(file, after);
  return true;
}

function moveDir(from: string, to: string): void {
  if (!existsSync(from)) {
    plan(existsSync(to) ? `already moved ${from} → ${to}` : `absent ${from} (nothing to move)`);
    return;
  }
  if (existsSync(to)) {
    failures++;
    plan(`✗ both exist: ${from} and ${to} — resolve by hand`);
    return;
  }
  plan(`mv ${from} → ${to}`);
  if (!APPLY) return;
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

// ---------------------------------------------------------------- inventory
/** The main checkout a worktree belongs to (its `.git` file names `<main>/.git/worktrees/<n>`), or null. */
function mainOf(worktree: string): string | null {
  const gitfile = join(worktree, '.git');
  try {
    if (!statSync(gitfile).isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitfile, 'utf8'));
    const gitdir = m?.[1]?.trim();
    if (!gitdir) return null;
    return resolve(gitdir, '..', '..', '..'); // <main>/.git/worktrees/<n> → <main>
  } catch {
    return null;
  }
}

function musterdHomeTextFiles(mapping: Map<string, string>): string[] {
  const out: string[] = [];
  const skip = new Set([
    'runtime',
    'checkout',
    'backups',
    'corpus-snapshots',
    'dataset-exports',
    'node_modules',
    'web',
  ]);
  const keys = [...mapping.keys()];
  const walk = (dir: string, depth: number): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 1 && !skip.has(e.name)) walk(p, depth + 1);
      } else if (/\.(json|sh|mjs|toml|env)$/.test(e.name) && statSync(p).size < 5_000_000) {
        const text = readFileSync(p, 'utf8');
        if (keys.some((k) => text.includes(k))) out.push(p);
      }
    }
  };
  walk(musterdHome, 0);
  return out.filter((p) => p !== configPath);
}

// ---------------------------------------------------------------- preflight
say(`${APPLY ? 'APPLYING' : 'PLAN (dry run — add --apply to execute)'}: ADR 447 layout on ${home}`);
const node = Number(process.versions.node.split('.')[0]);
if (node < 22) {
  say(
    `✗ node ${process.version} is on PATH; the daemon's plists embed it and need ≥22 — fix PATH first`,
  );
  process.exit(2);
}
if (!existsSync(configPath)) {
  say(`✗ ${configPath} missing — nothing is bound on this machine`);
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
  bindings?: Record<string, BoundFolder>;
  teamHome?: Record<string, string>;
};
const bindings = cfg.bindings ?? {};
const mapping = memberMoves(home, bindings);
const roots = teamRoots(home, bindings);
const cwd = process.cwd();
const inside = [...mapping.keys()].find((k) => cwd === k || cwd.startsWith(k + '/'));
if (inside && APPLY) {
  say(`✗ you are inside ${inside}, which moves — cd ~ and run again`);
  process.exit(2);
}
// A root's binding is the human's floor (ADR 176). It can only go once they have a member Workspace
// of that team to stand in instead — otherwise the move would leave the person with no identity.
for (const root of roots) {
  const rootBinding = join(root, '.musterd', 'binding.json');
  if (!existsSync(rootBinding)) continue;
  const b = JSON.parse(readFileSync(rootBinding, 'utf8')) as {
    team?: string;
    claim?: { name?: string };
  };
  const floor = Object.entries(bindings).find(
    ([f, ref]) => ref.team === b.team && ref.seat === b.claim?.name && f !== root,
  );
  if (!floor) {
    say(
      `✗ ${root} is bound as ${b.claim?.name ?? '?'} on ${b.team ?? '?'} and they have no member Workspace — ` +
        `give them one first: cd <checkout> && musterd human ${b.claim?.name ?? '<name>'} --team ${b.team ?? '<team>'}`,
    );
    process.exit(2);
  }
}

say(`\nmapping (${mapping.size} folders):`);
for (const [from, to] of mapping) say(`  ${from} → ${to}`);
say(`team roots: ${roots.join(', ') || '(none)'}`);

// ---------------------------------------------------------------- steps
const uid = userInfo().uid;
const plists = existsSync(launchAgents)
  ? readdirSync(launchAgents)
      .filter((n) => n.startsWith('studio.sandrise.musterd') && n.endsWith('.plist'))
      .map((n) => join(launchAgents, n))
  : [];
const keys = [...mapping.keys()];
const bounce = new Set(
  plists.filter((p) => {
    const text = readFileSync(p, 'utf8');
    return basename(p, '.plist') === HOST_LABEL || keys.some((k) => text.includes(k));
  }),
);

step(1, 'LaunchAgents: boot out the host and any agent whose plist names a moving folder');
for (const p of bounce) {
  const label = basename(p, '.plist');
  plan(`launchctl bootout gui/${uid}/${label}`);
  if (APPLY) sh('launchctl', ['bootout', `gui/${uid}/${label}`], { ok: [0, 3, 5, 36, 113] });
}
if (bounce.size === 0) plan('nothing to bounce');

step(2, 'member Workspaces → ~/musterd/<team>/<repo>/<member>; team roots unbound');
for (const [from, to] of mapping) moveDir(from, to);
for (const root of roots) {
  const rootBinding = join(root, '.musterd', 'binding.json');
  if (!existsSync(rootBinding)) continue;
  plan(`rm ${rootBinding} (a team root is a roof — it confers nobody)`);
  if (APPLY) {
    backup(rootBinding);
    rmSync(rootBinding);
  }
}

step(3, 'git worktree repair from each main checkout, with every worktree at its new path');
const byMain = new Map<string, string[]>();
for (const [from, to] of mapping) {
  const main = mainOf(existsSync(to) ? to : from);
  if (!main) {
    plan(`not a worktree: ${to}`);
    continue;
  }
  byMain.set(main, [...(byMain.get(main) ?? []), to]);
}
for (const [main, paths] of byMain) {
  plan(`git -C ${main} worktree repair ${paths.length} paths`);
  if (APPLY) sh('git', ['-C', main, 'worktree', 'repair', ...paths.filter(existsSync)]);
}

step(4, '~/.musterd: bindings registry, host registry, harness ledger, scripts');
{
  const next = rewriteRegistry(cfg, home, mapping);
  plan(
    `rewrite ${configPath} (${Object.keys(bindings).length} → ${Object.keys(next.bindings ?? {}).length} bindings; teamHome ${JSON.stringify(next.teamHome ?? {})})`,
  );
  if (APPLY) {
    backup(configPath);
    writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
  }
}
let rewrote = 0;
for (const f of musterdHomeTextFiles(mapping)) if (rewriteFile(f, mapping)) rewrote++;
if (rewrote === 0) plan('no other ~/.musterd file names a moving folder');

step(5, '~/.claude.json and ~/.claude/projects transcript folders');
const claudeJson = join(home, '.claude.json');
if (existsSync(claudeJson)) {
  const raw = readFileSync(claudeJson, 'utf8');
  const next = JSON.stringify(rewriteJson(JSON.parse(raw), mapping), null, 2) + '\n';
  const refs = keys.reduce((n, k) => n + raw.split(k).length - 1, 0);
  plan(`rewrite ${claudeJson} (${refs} references to moving folders)`);
  if (APPLY && refs > 0) {
    backup(claudeJson);
    writeFileSync(claudeJson, next);
  }
}
const projects = join(home, '.claude', 'projects');
if (existsSync(projects)) {
  for (const name of readdirSync(projects)) {
    const from = join(projects, name);
    const to = claudeProjectMove(from, mapping);
    if (!to) continue;
    if (!existsSync(to)) {
      plan(`mv ${from} → ${to}`);
      if (APPLY) renameSync(from, to);
    } else {
      plan(`merge ${from} → ${to} (entries not already present)`);
      if (APPLY) {
        for (const entry of readdirSync(from)) {
          if (!existsSync(join(to, entry))) renameSync(join(from, entry), join(to, entry));
        }
        if (readdirSync(from).length === 0) rmSync(from, { recursive: true });
        else
          plan(`  kept ${from}: ${readdirSync(from).length} entries already existed at the target`);
      }
    }
  }
}

step(6, 'per-Workspace harness configs that name a moving folder by absolute path');
// Measured 2026-09-25: `.codex/config.toml`, `.opencode/opencode.json`, `.cursor/mcp.json` and
// `.grok/config.toml` each embed the MCP adapter's dist path — the 2026-09-24 move missed them and
// four harnesses started from the new folders with no musterd tools.
const HARNESS_FILES = [
  '.mcp.json',
  '.claude/settings.local.json',
  '.codex/config.toml',
  '.opencode/opencode.json',
  '.cursor/mcp.json',
  '.grok/config.toml',
  '.grok/hooks/musterd.json',
  '.musterd/workspace.json',
];
let harnessRewrites = 0;
for (const to of mapping.values()) {
  const at = existsSync(to) ? to : mapPath(to, new Map([...mapping].map(([a, b]) => [b, a])));
  for (const rel of HARNESS_FILES) if (rewriteFile(join(at, rel), mapping)) harnessRewrites++;
}
if (harnessRewrites === 0) plan('no harness config names a moving folder');

step(7, 'team roots that are git repos (the roster): ignore the member trees beneath them');
const IGNORE =
  '# ADR 447: the trees beneath a team root are member worktrees of other repos\n/*/\n!/.musterd/\n';
for (const root of roots) {
  const ignore = join(root, '.gitignore');
  if (!existsSync(join(root, '.git'))) continue;
  const text = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  if (text.includes('ADR 447')) {
    plan(`already ignored under ${root}`);
    continue;
  }
  plan(`append to ${ignore}`);
  if (APPLY) {
    backup(ignore);
    appendFileSync(ignore, (text.endsWith('\n') || text === '' ? '' : '\n') + IGNORE);
  }
}

step(8, 'LaunchAgents: rewrite plists in place, bootstrap again');
for (const p of plists) rewriteFile(p, mapping);
for (const p of bounce) {
  plan(`launchctl bootstrap gui/${uid} ${p}`);
  if (APPLY) sh('launchctl', ['bootstrap', `gui/${uid}`, p]);
}

say('');
if (!APPLY) {
  say(
    `dry run complete — ${failures ? `${failures} problem(s) above need resolving first` : 'no problems found'}. Re-run with --apply from ~ to execute.`,
  );
  process.exit(failures ? 1 : 0);
}
say(
  failures
    ? `done with ${failures} failure(s) — see ✗ lines; backups in ${backupDir}`
    : `done — backups in ${backupDir}`,
);
const sample = [...mapping.values()][0];
say(
  `verify: musterd whoami (from ${sample ?? '<member>'} → that member; from ${roots[0] ?? '~/musterd/<team>'} → nobody); git -C <main> worktree list (no prunable)`,
);
process.exit(failures ? 1 : 0);
