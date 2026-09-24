/*
 * Reach-spec lane 3 — move this machine onto the §6 layout (ADR 442):
 *
 *   node scripts/layout/migrate.ts            # plan only: every step, every path, nothing written
 *   node scripts/layout/migrate.ts --apply    # do it (announce first: bounces the daemon AND every
 *                                             #   seat session whose folder moves — including yours)
 *
 * Run it from a shell whose `node` is ≥22 (the daemon's native modules) and NOT from inside a folder
 * that moves — `cd ~` first. Idempotent: a step whose source is gone and target present is skipped,
 * so a run interrupted half-way is resumed by running it again. Every file it rewrites is backed up
 * to `~/.musterd/backups/layout-<ts>/` first.
 *
 * What is path-keyed on this machine, and what happens to each (the inventory lives in
 * docs/wiki/workspace-layout.md):
 *   1. LaunchAgents (daemon, host, guardian, sweep, autorefresh, streamwatch, otel-sink, live) —
 *      booted out, their plists rewritten in place (only the paths; every baked flag survives),
 *      bootstrapped again at the end.
 *   2. `~/agents` → `~/.musterd/runtime`; its `.musterd/binding.json` deleted (unbound); the human
 *      already has `~/musterd/<repo>/<human>`.
 *   3. `~/agents-live` → `~/.musterd/runtime-live`; `~/agents-<seat>` → `~/musterd/<repo>/<seat>`.
 *   4. `git worktree repair` from the runtime with every worktree's new path (moved or not: the
 *      Codex/Claude/tmp worktrees stay put but their gitfiles name the old main).
 *   5. `~/.musterd/config.json` bindings registry re-keyed, old main dropped; host-registry.json,
 *      harness-ledger.json, stream/image.json and the ~/.musterd shell scripts rewritten.
 *   6. `~/.claude.json` re-keyed (projects, mcpServers args, githubRepoPaths);
 *      `~/.claude/projects/<slug>` transcript folders renamed (old main's merge into the human's).
 *   7. The pnpm global `musterd` shim re-linked from the runtime.
 */
import { spawnSync } from 'node:child_process';
import {
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
import { basename, dirname, join } from 'node:path';
import {
  claudeProjectMove,
  defaultLayout,
  legacySeat,
  mapPath,
  pathMapping,
  rewritePaths,
  rewriteJson,
  rewriteRegistry,
} from './plan.ts';

const APPLY = process.argv.includes('--apply');
const HUMAN = argValue('--human') ?? 'nick';
const REPO = argValue('--repo') ?? 'agents';
const LABELS = [
  'studio.sandrise.musterd',
  'studio.sandrise.musterd-host',
  'studio.sandrise.musterd-guardian',
  'studio.sandrise.musterd-sweep',
  'studio.sandrise.musterd-autorefresh',
  'studio.sandrise.musterd-streamwatch',
  'studio.sandrise.musterd-otel-sink',
  'studio.sandrise.musterd-live',
];

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const home = homedir();
const layout = defaultLayout(home, REPO);
const humanHome = join(layout.group, HUMAN);
const launchAgents = join(home, 'Library', 'LaunchAgents');
const musterdHome = join(home, '.musterd');
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

function rewriteFile(file: string, mapping: Map<string, string>): void {
  if (!existsSync(file)) return;
  const before = readFileSync(file, 'utf8');
  const after = rewritePaths(before, mapping);
  if (before === after) return plan(`unchanged ${file}`);
  plan(`rewrite ${file}`);
  if (!APPLY) return;
  backup(file);
  writeFileSync(file, after);
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
function seatDirs(): string[] {
  return readdirSync(home)
    .map((n) => join(home, n))
    .filter((p) => legacySeat(layout, p) !== null && statSync(p).isDirectory());
}

function worktrees(main: string): string[] {
  if (!existsSync(main)) return [];
  return sh('git', ['-C', main, 'worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length));
}

function musterdHomeTextFiles(): string[] {
  const out: string[] = [];
  const skip = new Set([
    'runtime',
    'runtime-live',
    'backups',
    'corpus-snapshots',
    'dataset-exports',
    'node_modules',
    'web',
  ]);
  const walk = (dir: string, depth: number): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 1 && !skip.has(e.name)) walk(p, depth + 1);
      } else if (/\.(json|sh|mjs|toml|env)$/.test(e.name) && statSync(p).size < 5_000_000) {
        if (readFileSync(p, 'utf8').includes(layout.oldMain)) out.push(p);
      }
    }
  };
  walk(musterdHome, 0);
  return out.filter((p) => p !== join(musterdHome, 'config.json'));
}

// ---------------------------------------------------------------- preflight
say(
  `${APPLY ? 'APPLYING' : 'PLAN (dry run — add --apply to execute)'}: reach-spec §6 layout on ${home}`,
);
const node = Number(process.versions.node.split('.')[0]);
if (node < 22) {
  say(
    `✗ node ${process.version} is on PATH; the daemon's plists embed it and need ≥22 — fix PATH first`,
  );
  process.exit(2);
}
if (!existsSync(join(humanHome, '.musterd', 'binding.json'))) {
  say(
    `✗ ${humanHome} is not a bound Workspace — the human's home must exist before the old main is unbound`,
  );
  process.exit(2);
}
const cwd = process.cwd();
const seats = seatDirs();
const mapping = pathMapping(layout, seats);
const inside = [...mapping.keys()].find((k) => cwd === k || cwd.startsWith(k + '/'));
if (inside && APPLY) {
  say(`✗ you are inside ${inside}, which moves — cd ~ and run again`);
  process.exit(2);
}
const trees = worktrees(existsSync(layout.oldMain) ? layout.oldMain : layout.runtime);

say(`\nmapping (${mapping.size} folders):`);
for (const [from, to] of mapping) say(`  ${from} → ${to}`);
say(`worktrees on record: ${trees.length}`);

// ---------------------------------------------------------------- steps
step(1, 'LaunchAgents: boot out every musterd agent');
const uid = userInfo().uid;
for (const label of LABELS) {
  if (!existsSync(join(launchAgents, `${label}.plist`))) continue;
  plan(`launchctl bootout gui/${uid}/${label}`);
  if (APPLY) sh('launchctl', ['bootout', `gui/${uid}/${label}`], { ok: [0, 3, 5, 36, 113] });
}

step(2, `main checkout → unbound runtime`);
moveDir(layout.oldMain, layout.runtime);
const runtimeBinding = join(layout.runtime, '.musterd', 'binding.json');
if (existsSync(runtimeBinding) || existsSync(join(layout.oldMain, '.musterd', 'binding.json'))) {
  plan(`rm ${runtimeBinding} (the runtime confers nobody)`);
  if (APPLY && existsSync(runtimeBinding)) {
    backup(runtimeBinding);
    rmSync(runtimeBinding);
  }
}

step(3, 'live worktree and seat Workspaces');
for (const [from, to] of mapping) if (from !== layout.oldMain) moveDir(from, to);

step(4, 'git worktree repair from the runtime, with every worktree at its new path');
const repaired = trees.map((t) => mapPath(t, mapping)).filter((t) => existsSync(t) || !APPLY);
plan(`git -C ${layout.runtime} worktree repair ${repaired.length} paths`);
if (APPLY) sh('git', ['-C', layout.runtime, 'worktree', 'repair', ...repaired.filter(existsSync)]);

step(5, 'LaunchAgent plists: rewrite paths in place');
for (const label of LABELS) rewriteFile(join(launchAgents, `${label}.plist`), mapping);

step(6, '~/.musterd: bindings registry, host registry, harness ledger, scripts');
const configPath = join(musterdHome, 'config.json');
if (existsSync(configPath)) {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
    bindings?: Record<string, unknown>;
  };
  const next = rewriteRegistry(cfg, layout, mapping);
  plan(
    `rewrite ${configPath} (${Object.keys(cfg.bindings ?? {}).length} → ${Object.keys(next.bindings ?? {}).length} bindings; old main dropped)`,
  );
  if (APPLY) {
    backup(configPath);
    writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
  }
}
for (const f of musterdHomeTextFiles()) rewriteFile(f, mapping);

step(7, '~/.claude.json and ~/.claude/projects transcript folders');
const claudeJson = join(home, '.claude.json');
if (existsSync(claudeJson)) {
  const raw = readFileSync(claudeJson, 'utf8');
  const next = JSON.stringify(rewriteJson(JSON.parse(raw), mapping), null, 2) + '\n';
  const refs = raw.split(layout.oldMain).length - 1;
  plan(`rewrite ${claudeJson} (${refs} references to ${layout.oldMain}*)`);
  if (APPLY) {
    backup(claudeJson);
    writeFileSync(claudeJson, next);
  }
}
const projects = join(home, '.claude', 'projects');
if (existsSync(projects)) {
  for (const name of readdirSync(projects)) {
    const from = join(projects, name);
    const to = claudeProjectMove(from, layout, mapping, humanHome);
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

step(8, 'pnpm global `musterd` shim → the runtime');
const pnpm = ['/Users/nick/Library/pnpm/pnpm', 'pnpm'].find(
  (p) => spawnSync(p, ['--version']).status === 0,
);
if (pnpm) {
  plan(`${pnpm} -C ${join(layout.runtime, 'packages', 'cli')} link --global`);
  if (APPLY) sh(pnpm, ['-C', join(layout.runtime, 'packages', 'cli'), 'link', '--global']);
} else
  plan(
    'pnpm not found — re-link the global shim by hand (AGENTS.md → "Running the CLI from source")',
  );

step(9, 'LaunchAgents: bootstrap every musterd agent again');
for (const label of LABELS) {
  const plist = join(launchAgents, `${label}.plist`);
  if (!existsSync(plist)) continue;
  plan(`launchctl bootstrap gui/${uid} ${plist}`);
  if (APPLY) sh('launchctl', ['bootstrap', `gui/${uid}`, plist]);
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
say(
  `verify: curl -s http://127.0.0.1:4849/health; git -C ${layout.runtime} worktree list; musterd whoami (from ${humanHome} → ${HUMAN}; from ${layout.runtime} → nobody)`,
);
process.exit(failures ? 1 : 0);
