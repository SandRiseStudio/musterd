import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { grokCandidates } from '../../grokBin.js';
import { isDeclined } from '../declined.js';
import {
  registeredFromEnv,
  type Harness,
  type ProvisionPlan,
  type UnprovisionPlan,
} from '../harness.js';
import {
  launchEntryEnv,
  markerGenerationOfEnv,
  resolveMcpLaunch,
  type McpServerEntry,
} from '../mcpEntry.js';
import { STANDARD_FLOOR } from '../permissions.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  type HarnessAdapter,
} from '../reconcile/fragments.js';
import {
  hasServer,
  readServer,
  readServerEnv,
  removeServers,
  upsertServer,
  type CodexServer,
} from './codexToml.js';

/**
 * Grok CLI (ADR 352). Project-local `.grok/config.toml` for MCP + statusline + permission floor;
 * `.grok/hooks/musterd.json` for Claude-parity hooks. Never writes `~/.grok/config.toml`.
 * Cursor MCP compat stays on (other servers); Cursor *hook* compat is turned off so capture
 * does not keep attesting `cursor`.
 */

export const GROK_SURFACE = 'grok';
export const NOTIFY_MARKER = 'musterd-grok-notify';
export const INTERRUPT_MARKER = 'musterd-grok-interrupt';
export const STOP_MARKER = 'musterd-grok-stop';
export const GATE_MARKER = 'musterd-grok-gate';
export const CAPTURE_MARKER = 'musterd-grok-capture';
export const END_MARKER = 'musterd-grok-end';
export const STATUSLINE_MARKER = 'musterd-grok-statusline';
export const GLOBAL_START_MARKER = 'musterd-grok-global-start';

const GROK_PREFIX = 'grok';
export const SURFACE_STATUSLINE = `${GROK_PREFIX}:statusLine`;

function projectConfigPath(dir: string = process.cwd()): string {
  return join(dir, '.grok', 'config.toml');
}
function projectHooksPath(dir: string = process.cwd()): string {
  return join(dir, '.grok', 'hooks', 'musterd.json');
}
function globalConfigPath(): string {
  return join(homedir(), '.grok', 'config.toml');
}
function globalStartHookPath(): string {
  return join(homedir(), '.grok', 'hooks', 'musterd-sessionstart.json');
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function writeText(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`, 'utf8');
}

function cmd(inner: string, marker: string, discardStdout: boolean): string {
  const redir = discardStdout ? ' >/dev/null 2>&1' : ' 2>/dev/null';
  return `command -v musterd >/dev/null 2>&1 && musterd ${inner}${redir} || true # ${marker}`;
}

/**
 * Grok 1.0.13: PostToolUse stdout and additionalContext JSON are ignored. PreToolUse
 * additionalContext reaches the model after the tool, wrapped in a system-reminder (ADR 370).
 * Empty interrupt-check (the common path) prints nothing, so no context is added.
 */
export const GROK_INTERRUPT_PRE_WRAP =
  'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const t=s.trim();if(t)console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:t}}))})';

export function grokInterruptPreCommand(): string {
  return (
    'command -v musterd >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && ' +
    `musterd inbox --interrupt-check 2>/dev/null | node -e '${GROK_INTERRUPT_PRE_WRAP}' || true # ${INTERRUPT_MARKER}`
  );
}

/**
 * Idle-at-turn-end doorbell (ADR 370). Blocks a genuine end_turn once with the daemon-composed
 * interrupt line; `stopHookActive` and non-end_turn reasons (session shutdown) exit 0.
 */
export const GROK_INTERRUPT_STOP_SCRIPT = [
  'const fs=require("fs");',
  'const {execFileSync}=require("child_process");',
  'let ev={};',
  'try{ev=JSON.parse(fs.readFileSync(0,"utf8"))}catch{}',
  'if(ev.reason!=="end_turn"||ev.stopHookActive)process.exit(0);',
  'let line="";',
  'try{line=execFileSync("musterd",["inbox","--interrupt-check"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim()}catch{}',
  'if(line)console.log(JSON.stringify({decision:"block",reason:line}))',
].join('');

export function grokInterruptStopCommand(): string {
  return (
    'command -v musterd >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && ' +
    `node -e '${GROK_INTERRUPT_STOP_SCRIPT}' || true # ${STOP_MARKER}`
  );
}

interface GrokHookFile {
  hooks?: Record<
    string,
    { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]
  >;
}

function readHooks(path: string): GrokHookFile | null {
  const raw = readText(path);
  if (raw === null) return { hooks: {} };
  try {
    return JSON.parse(raw) as GrokHookFile;
  } catch {
    return null;
  }
}

function upsertJsonHook(
  path: string,
  event: string,
  marker: string,
  command: string,
  matcher?: string,
  timeout?: number,
): string | undefined {
  const file = readHooks(path);
  if (!file) return `could not parse ${path} — left untouched`;
  file.hooks ??= {};
  const list = file.hooks[event] ?? [];
  const kept = list.filter((g) => !g.hooks.some((h) => h.command.includes(marker)));
  kept.push({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command, ...(timeout !== undefined ? { timeout } : {}) }],
  });
  file.hooks[event] = kept;
  writeText(path, `${JSON.stringify(file, null, 2)}\n`);
  return undefined;
}

function dropJsonHook(path: string, event: string, marker: string): void {
  const file = readHooks(path);
  if (!file?.hooks?.[event]) return;
  const kept = file.hooks[event]!.filter((g) => !g.hooks.some((h) => h.command.includes(marker)));
  if (kept.length === file.hooks[event]!.length) return;
  if (kept.length > 0) file.hooks[event] = kept;
  else delete file.hooks[event];
  if (file.hooks && Object.keys(file.hooks).length === 0) {
    try {
      unlinkSync(path);
    } catch {
      writeText(path, '{}\n');
    }
    return;
  }
  writeText(path, `${JSON.stringify(file, null, 2)}\n`);
}

const LOCAL_HOOKS: readonly {
  event: string;
  marker: string;
  command: string;
  matcher?: string;
  missing?: string;
  timeout?: number;
}[] = [
  {
    event: 'Notification',
    marker: NOTIFY_MARKER,
    command: cmd('inbox --waiting', NOTIFY_MARKER, true),
  },
  {
    event: 'PreToolUse',
    marker: INTERRUPT_MARKER,
    command: grokInterruptPreCommand(),
    timeout: 10,
    missing:
      'the Grok PreToolUse interrupt hook is missing from .grok/hooks/musterd.json — a busy agent will not see urgent steering mid-loop (ADR 088/370). Run `musterd init --refresh-hooks`.',
  },
  {
    event: 'PreToolUse',
    marker: GATE_MARKER,
    matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|run_terminal_command|search_replace',
    command: cmd('gate check --stdin', GATE_MARKER, true),
    timeout: 10,
    missing:
      'the Grok PreToolUse enforcement-gate hook is missing from .grok/hooks/musterd.json — declared ADR 150 classes fail open here. Run `musterd init --refresh-hooks`.',
  },
  {
    event: 'Stop',
    marker: STOP_MARKER,
    command: grokInterruptStopCommand(),
    timeout: 10,
    missing:
      'the Grok Stop interrupt hook is missing from .grok/hooks/musterd.json — an idle-at-turn-end agent will not see urgent steering (ADR 370). Run `musterd init --refresh-hooks`.',
  },
  {
    event: 'SessionStart',
    marker: CAPTURE_MARKER,
    // stdout kept: if Grok injects SessionStart stdout, orientation rides (Claude parity).
    command: cmd('session start --stdin', CAPTURE_MARKER, false),
    missing:
      'the Grok SessionStart capture hook is missing from .grok/hooks/musterd.json — wakes will run fresh-only (ADR 131 §5). Run `musterd init --refresh-hooks`.',
  },
  {
    event: 'SessionEnd',
    marker: END_MARKER,
    command: cmd('session end --stdin', END_MARKER, true),
    missing:
      'the Grok SessionEnd hook is missing from .grok/hooks/musterd.json — captured sessions will never be marked ended. Run `musterd init --refresh-hooks`.',
  },
];

export function installMusterdGrokHooks(dir: string = process.cwd()): string[] {
  const path = projectHooksPath(dir);
  const warnings: string[] = [];
  // ADR 370: interrupt moved off PostToolUse (stdout/JSON ignored on Grok 1.0.13).
  dropJsonHook(path, 'PostToolUse', INTERRUPT_MARKER);
  for (const spec of LOCAL_HOOKS) {
    if (isDeclined(dir, `${GROK_PREFIX}:${spec.event}`)) continue;
    const w = upsertJsonHook(
      path,
      spec.event,
      spec.marker,
      spec.command,
      spec.matcher,
      spec.timeout,
    );
    if (w) warnings.push(w);
  }
  const global = installGlobalSessionStart();
  if (global) warnings.push(global);
  return warnings;
}

function installGlobalSessionStart(): string | undefined {
  // Self-gating like Claude's ~/.claude/settings.json SessionStart: silent outside musterd folders.
  const command =
    'grep -q musterd:start AGENTS.md 2>/dev/null || grep -q musterd:start Agents.md 2>/dev/null || exit 0; ' +
    cmd('session start --stdin', GLOBAL_START_MARKER, false);
  return upsertJsonHook(globalStartHookPath(), 'SessionStart', GLOBAL_START_MARKER, command);
}

export function removeMusterdGrokHooks(dir: string = process.cwd()): void {
  const path = projectHooksPath(dir);
  if (!existsSync(path)) return;
  dropJsonHook(path, 'PostToolUse', INTERRUPT_MARKER);
  for (const spec of LOCAL_HOOKS) dropJsonHook(path, spec.event, spec.marker);
}

export function inspectGrokHookDrift(cwd: string): string[] {
  const path = projectHooksPath(cwd);
  const file = readHooks(path);
  if (!file) return [];
  const drift: string[] = [];
  for (const spec of LOCAL_HOOKS) {
    if (!spec.missing) continue;
    if (isDeclined(cwd, `${GROK_PREFIX}:${spec.event}`)) continue;
    const groups = file.hooks?.[spec.event] ?? [];
    const present = groups.some((g) => g.hooks.some((h) => h.command.includes(spec.marker)));
    if (!present) drift.push(spec.missing);
  }
  const leftoverPost = (file.hooks?.['PostToolUse'] ?? []).some((g) =>
    g.hooks.some((h) => h.command.includes(INTERRUPT_MARKER)),
  );
  if (leftoverPost) {
    drift.push(
      'a leftover Grok PostToolUse interrupt hook is still installed — Grok ignores that seam (ADR 370). Run `musterd init --refresh-hooks`.',
    );
  }
  return drift;
}

function ensureCursorHooksOff(toml: string): string {
  if (/\[compat\.cursor\][\s\S]*?hooks\s*=\s*false/.test(toml)) return toml;
  const block = '\n[compat.cursor]\nhooks = false\n';
  return toml.replace(/\s*$/, '') + block;
}

function statuslineCommand(): string {
  return `command -v musterd >/dev/null 2>&1 && musterd session statusline --stdin 2>/dev/null || true # ${STATUSLINE_MARKER}`;
}

function ensureStatusline(toml: string, dir: string): { toml: string; warning?: string } {
  if (isDeclined(dir, SURFACE_STATUSLINE)) return { toml };
  if (/\[ui\.status_line\]/.test(toml)) {
    if (toml.includes(STATUSLINE_MARKER)) return { toml };
    return {
      toml,
      warning:
        '.grok/config.toml already has [ui.status_line] that musterd did not write, so the seat chip was NOT installed.',
    };
  }
  const block = `\n[ui.status_line]\ntype = "command"\ncommand = "${statuslineCommand().replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
  return { toml: toml.replace(/\s*$/, '') + block };
}

function mergePermissionFloor(toml: string): string {
  if (/\[permission\]/.test(toml)) return toml; // existing table is the user's; do not clobber
  const allow = STANDARD_FLOOR.allow.map((e) => `  ${JSON.stringify(e)},`).join('\n');
  return toml.replace(/\s*$/, '') + `\n[permission]\nallow = [\n${allow}\n]\n`;
}

function toTomlServer(entry: McpServerEntry): CodexServer {
  return { command: entry.command, args: entry.args, env: entry.env };
}

export const grok: Harness = {
  id: 'grok',
  label: 'Grok CLI',
  surface: GROK_SURFACE,
  entryScope: 'folder',
  guidance: {
    skillPath: '.grok/skills/musterd/SKILL.md',
    frontmatter: 'claude-code',
    commandsDir: '.grok/commands',
    orientSkillPath: '.grok/skills/musterd-orient/SKILL.md',
  },

  observeModel: (payload) => {
    const id = payload.model_id?.trim() || payload.model?.trim();
    if (id) return id;
    if (!payload.session_id) return undefined;
    try {
      const home = process.env['GROK_HOME'] ?? join(homedir(), '.grok');
      const cwd = payload.cwd ?? process.cwd();
      const encoded = encodeURIComponent(cwd);
      const summary = join(home, 'sessions', encoded, payload.session_id, 'summary.json');
      const raw = readFileSync(summary, 'utf8');
      const parsed = JSON.parse(raw) as { current_model_id?: string };
      const model = parsed.current_model_id?.trim();
      return model || undefined;
    } catch {
      return undefined;
    }
  },

  async detect() {
    const home = join(homedir(), '.grok');
    const installed = existsSync(home) || grokCandidates().some((p) => existsSync(p));
    const projectToml = readText(projectConfigPath()) ?? '';
    const inProject = hasServer(projectToml, 'musterd');
    const globalToml = inProject ? '' : (readText(globalConfigPath()) ?? '');
    const inGlobal = !inProject && hasServer(globalToml, 'musterd');
    const env = inProject
      ? readServerEnv(projectToml, 'musterd')
      : inGlobal
        ? readServerEnv(globalToml, 'musterd')
        : undefined;
    return {
      installed,
      configured: inProject || inGlobal,
      detail: inGlobal
        ? 'registered in ~/.grok/config.toml (machine-global — musterd writes the project file)'
        : installed
          ? '~/.grok present'
          : 'grok install not found',
      ...registeredFromEnv(env),
      hookDrift: inspectGrokHookDrift(process.cwd()),
      ...(inGlobal ? { registeredElsewhere: globalConfigPath() } : {}),
    };
  },

  async configure(entry: McpServerEntry) {
    const path = projectConfigPath();
    let toml = readText(path) ?? '';
    toml = upsertServer(toml, 'musterd', toTomlServer(entry));
    toml = ensureCursorHooksOff(toml);
    const sl = ensureStatusline(toml, process.cwd());
    toml = mergePermissionFloor(sl.toml);
    writeText(path, toml);
    const hookWarnings = installMusterdGrokHooks();
    const warnings = [...hookWarnings, ...(sl.warning ? [sl.warning] : [])];
    return {
      target: path,
      activation:
        'reload MCP in this Grok session (/mcps, disable then enable musterd) — a list refresh does not respawn stdio',
      scope: `wired into this folder only (${path}) — another project needs its own \`musterd init\`, and a second agent needs its own folder`,
      secretPath: path,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  },

  refreshHooks: {
    applies: (dir) => existsSync(projectConfigPath(dir)) || existsSync(projectHooksPath(dir)),
    run: (dir) => {
      const warnings = installMusterdGrokHooks(dir);
      let toml = readText(projectConfigPath(dir)) ?? '';
      if (toml.length > 0) {
        toml = ensureCursorHooksOff(toml);
        const sl = ensureStatusline(toml, dir);
        toml = mergePermissionFloor(sl.toml);
        writeText(projectConfigPath(dir), toml);
        if (sl.warning) warnings.push(sl.warning);
      }
      return { files: [projectHooksPath(dir), projectConfigPath(dir)], warnings };
    },
    surfaces: () => [
      SURFACE_STATUSLINE,
      ...new Set(LOCAL_HOOKS.map((s) => `${GROK_PREFIX}:${s.event}`)),
    ],
  },

  async provision(plan: ProvisionPlan) {
    const path = projectConfigPath();
    let toml = readText(path) ?? '';
    const servers: string[] = [];
    for (const s of plan.servers) {
      toml = upsertServer(toml, s.name, toTomlServer(s));
      servers.push(s.name);
    }
    toml = mergePermissionFloor(toml);
    writeText(path, toml);
    return {
      servers,
      permissions: { allow: STANDARD_FLOOR.allow, ask: [], deny: [] },
      target: path,
      activation: 'reload MCP in this Grok session to pick up new servers',
    };
  },

  async unprovision(plan: UnprovisionPlan) {
    const path = projectConfigPath();
    const toml = readText(path);
    if (toml === null) return;
    const next = removeServers(toml, plan.servers);
    writeText(path, next);
  },
};

interface MusterdGrokPayload {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export const grokAdapter: HarnessAdapter = {
  id: 'grok',
  surface: GROK_SURFACE,
  adapterVersion: 1,

  async availability(ctx) {
    const home = ctx.env['HOME'] ?? homedir();
    const present = existsSync(join(home, '.grok'));
    return present
      ? { available: true, detail: '~/.grok present' }
      : { available: false, detail: 'grok install not found' };
  },

  async target(ctx) {
    return {
      containers: [
        {
          containerKey: `folder ${ctx.worktreeRoot} .grok/config.toml`,
          scope: 'folder',
          handle: 'mcp',
        },
      ],
    };
  },

  async desiredFragments(ctx) {
    const launch = resolveMcpLaunch();
    const payload: MusterdGrokPayload = {
      command: launch.command,
      args: launch.args,
      env: launchEntryEnv(GROK_SURFACE),
    };
    return [
      {
        harness: 'grok',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'grok', 'mcp.musterd'),
        containerKey: `folder ${ctx.worktreeRoot} .grok/config.toml`,
        fragmentKey: 'mcp.musterd',
        scope: 'folder',
        fingerprint: canonicalFingerprint(payload),
        payload,
      },
    ];
  },

  async observe(ctx, intent) {
    if (intent.fragmentKey !== 'mcp.musterd') return { state: 'absent' };
    const toml = ctx.fs.readFile(join(ctx.worktreeRoot, '.grok', 'config.toml'));
    if (toml === null) return { state: 'absent' };
    const entry = readServer(toml, 'musterd');
    if (!entry) return { state: 'absent' };
    // Same payload as desiredFragments — command + args + env — so a write observes as itself
    // (Cursor/Codex/OpenCode). Hashing env alone made every applied entry look drifted.
    const fingerprint = canonicalFingerprint(entry);
    return markerGenerationOfEnv(entry.env) !== 'launch'
      ? { state: 'legacy-launch-marker', fingerprint }
      : { state: 'present', fingerprint };
  },

  async apply(ctx, mutation) {
    if (mutation.intent.fragmentKey !== 'mcp.musterd') {
      throw new Error(`unknown grok fragment ${mutation.intent.fragmentKey}`);
    }
    const path = join(ctx.worktreeRoot, '.grok', 'config.toml');
    const existing = ctx.fs.readFile(path) ?? '';
    let toml = existing;
    if (mutation.kind === 'remove') {
      toml = removeServers(toml, ['musterd']);
    } else if (mutation.kind === 'repair-launch-marker') {
      const observed = readServer(toml, 'musterd');
      if (!observed) return;
      const { ['MUSTERD_SURFACE']: _retired, ...rest } = observed.env;
      toml = upsertServer(toml, 'musterd', {
        command: observed.command,
        args: observed.args,
        env: { ...rest, ...launchEntryEnv(GROK_SURFACE) },
      });
    } else {
      const payload = mutation.intent.payload as MusterdGrokPayload;
      toml = upsertServer(toml, 'musterd', {
        command: payload.command,
        args: payload.args,
        env: payload.env,
      });
    }
    if (mutation.kind !== 'remove') toml = ensureCursorHooksOff(toml);
    ctx.fs.mkdirp(dirname(path));
    ctx.fs.writeFile(path, toml.endsWith('\n') ? toml : `${toml}\n`, 0o644);
  },
};
