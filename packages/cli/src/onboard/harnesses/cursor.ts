import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyFileMap, guidanceFileMap, observeFileMap } from '../guidance.js';
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
import type { FsSeam } from '../reconcile/context.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  type HarnessAdapter,
} from '../reconcile/fragments.js';

interface CursorConfig {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

/** Cursor's project hooks file (ADR 198) — versioned map of event → command hooks. */
interface CursorHooksFile {
  version: number;
  hooks?: Record<string, CursorHookDef[]>;
}

interface CursorHookDef {
  command: string;
  matcher?: string;
  timeout?: number;
}

function projectConfigPath(dir: string = process.cwd()): string {
  return join(dir, '.cursor', 'mcp.json');
}
function projectHooksPath(dir: string = process.cwd()): string {
  return join(dir, '.cursor', 'hooks.json');
}
function globalConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json');
}

function readConfig(path: string): CursorConfig | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CursorConfig;
  } catch {
    return null;
  }
}

function writeConfig(path: string, cfg: CursorConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function hasMusterd(path: string): boolean {
  const cfg = readConfig(path);
  return Boolean(cfg?.mcpServers?.['musterd']);
}

/** Our own registered entry from a Cursor config, or null when this file does not carry one. */
function musterdEntry(path: string): NonNullable<CursorConfig['mcpServers']>[string] | null {
  return readConfig(path)?.mcpServers?.['musterd'] ?? null;
}

function readHooksSafe(path: string): CursorHooksFile | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CursorHooksFile;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, hooks: {} };
    return null; // unparseable — never clobber
  }
}

/** Markers so upsert/drop target our entries without absorbing the user's other hooks. */
export const CURSOR_OBSERVE_HOOK_MARKER = 'musterd-cursor-observe';
export const CURSOR_END_HOOK_MARKER = 'musterd-cursor-end';
export const CURSOR_GATE_HOOK_MARKER = 'musterd-cursor-gate';

function observeHookCommand(): string {
  // ADR 198: pipe Cursor's common-schema stdin (conversation_id, model_id, …) into session observe.
  // cd to the project so binding resolves; never-fail; silent so Agent context stays clean.
  return (
    'cd "${CURSOR_PROJECT_DIR:-.}" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd session observe --stdin >/dev/null 2>&1 || true ' +
    `# ${CURSOR_OBSERVE_HOOK_MARKER}`
  );
}

/** ADR 369: postToolUse observes model, plus checks for urgent interrupt acts via --interrupt.
 *  Stderr discarded; stdout is the Cursor injection seam for { additional_context } (do NOT redirect it). */
function postToolUseHookCommand(): string {
  return (
    'cd "${CURSOR_PROJECT_DIR:-.}" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd session observe --stdin --interrupt 2>/dev/null || true ' +
    `# ${CURSOR_OBSERVE_HOOK_MARKER}`
  );
}

/** ADR 369: PreToolUse enforcement gate for Cursor Agent.
 *  Pipe stdin ({tool_name, tool_input, cwd}) into gate check. Stderr discarded; stdout kept so
 *  Cursor receives JSON `{ permission: 'deny', ... }`. Matcher filters to write/shell/task tools. */
function preToolUseHookCommand(): string {
  return (
    'cd "${CURSOR_PROJECT_DIR:-.}" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd gate check --stdin 2>/dev/null || true ' +
    `# ${CURSOR_GATE_HOOK_MARKER}`
  );
}

/** ADR 333: sessionStart still observes, then emits JSON `{ additional_context }` on stdout.
 *  Stderr discarded; stdout is the Cursor injection seam (do NOT redirect it). */
function sessionStartHookCommand(): string {
  return (
    'cd "${CURSOR_PROJECT_DIR:-.}" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd session observe --stdin --orient 2>/dev/null || true ' +
    `# ${CURSOR_OBSERVE_HOOK_MARKER}`
  );
}

function sessionEndHookCommand(): string {
  return (
    'cd "${CURSOR_PROJECT_DIR:-.}" 2>/dev/null; ' +
    'command -v musterd >/dev/null 2>&1 && musterd session end --stdin >/dev/null 2>&1 || true ' +
    `# ${CURSOR_END_HOOK_MARKER}`
  );
}

function isMusterdCursorHook(h: CursorHookDef, marker: string): boolean {
  return h.command.includes(marker);
}

/**
 * Idempotent upsert of a Cursor hook command under `event`. Replaces a prior musterd entry with the
 * same marker; leaves every other hook alone. Returns a warning when the file is unreadable.
 */
function upsertCursorHook(
  path: string,
  event: string,
  marker: string,
  command: string,
  matcher?: string,
): string | undefined {
  const file = readHooksSafe(path);
  if (!file) {
    return `could not parse ${path} — left untouched (fix or remove it, then re-run init)`;
  }
  file.version = file.version || 1;
  file.hooks = file.hooks ?? {};
  const list = file.hooks[event] ?? [];
  const kept = list.filter((h) => !isMusterdCursorHook(h, marker));
  kept.push({ command, ...(matcher ? { matcher } : {}) });
  file.hooks[event] = kept;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', 'utf8');
  return undefined;
}

function dropCursorHook(path: string, event: string, marker: string): void {
  const file = readHooksSafe(path);
  if (!file?.hooks?.[event]) return;
  const kept = file.hooks[event]!.filter((h) => !isMusterdCursorHook(h, marker));
  if (kept.length === file.hooks[event]!.length) return;
  if (kept.length > 0) file.hooks[event] = kept;
  else delete file.hooks[event];
  if (file.hooks && Object.keys(file.hooks).length === 0) delete file.hooks;
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', 'utf8');
}

/**
 * Install musterd's Cursor Agent hooks (ADR 198 / 265 / 369): preToolUse gate + sessionStart + postToolUse
 * interrupt + afterShellExecution + afterMCPExecution observe the live `model_id`; sessionEnd stamps
 * ended_at. Project-local `.cursor/hooks.json` only.
 */
export function installMusterdCursorHooks(dir: string = process.cwd()): string[] {
  const path = projectHooksPath(dir);
  const warnings: string[] = [];
  for (const [event, marker, command, matcher] of [
    [
      'preToolUse',
      CURSOR_GATE_HOOK_MARKER,
      preToolUseHookCommand(),
      'Shell|Write|Delete|Edit|Task',
    ] as const,
    ['sessionStart', CURSOR_OBSERVE_HOOK_MARKER, sessionStartHookCommand(), undefined] as const,
    ['postToolUse', CURSOR_OBSERVE_HOOK_MARKER, postToolUseHookCommand(), undefined] as const,
    // ADR 265: cursor-agent's event surface is a subset of the IDE's. Older CLIs (measured:
    // 2026.01.23) never dispatch sessionStart/postToolUse/sessionEnd; they do dispatch
    // afterShellExecution. afterMCPExecution covers a CLI session that is almost entirely MCP.
    ['afterShellExecution', CURSOR_OBSERVE_HOOK_MARKER, observeHookCommand(), undefined] as const,
    ['afterMCPExecution', CURSOR_OBSERVE_HOOK_MARKER, observeHookCommand(), undefined] as const,
    ['sessionEnd', CURSOR_END_HOOK_MARKER, sessionEndHookCommand(), undefined] as const,
  ]) {
    const w = upsertCursorHook(path, event, marker, command, matcher);
    if (w) warnings.push(w);
  }
  return warnings;
}

export function removeMusterdCursorHooks(dir: string = process.cwd()): void {
  const path = projectHooksPath(dir);
  if (!existsSync(path)) return;
  dropCursorHook(path, 'preToolUse', CURSOR_GATE_HOOK_MARKER);
  dropCursorHook(path, 'sessionStart', CURSOR_OBSERVE_HOOK_MARKER);
  dropCursorHook(path, 'postToolUse', CURSOR_OBSERVE_HOOK_MARKER);
  dropCursorHook(path, 'afterShellExecution', CURSOR_OBSERVE_HOOK_MARKER);
  dropCursorHook(path, 'afterMCPExecution', CURSOR_OBSERVE_HOOK_MARKER);
  dropCursorHook(path, 'sessionEnd', CURSOR_END_HOOK_MARKER);
}

/** Cursor: configured via .cursor/mcp.json. We write the project-scoped file in cwd. */
export const cursor: Harness = {
  id: 'cursor',
  label: 'Cursor',
  surface: 'cursor',
  // `.cursor/mcp.json` is per-folder — and lives in the working tree, so a secret here is committable.
  entryScope: 'folder',
  // ADR 085: Cursor's closest skill equivalent is a description-gated ("Agent Requested") rule; slash
  // commands land as project commands. Same body as the canonical skill, different frontmatter shell.
  guidance: {
    skillPath: '.cursor/rules/musterd.mdc',
    frontmatter: 'cursor',
    commandsDir: '.cursor/commands',
    // ADR 186: Cursor can rename the *current* chat via `rename_chat` (when cursor-app-control is
    // present) — not a peer sweep. Self-label guidance is a separate unit from Claude's cross-rename.
    selfLabelSkillPath: '.cursor/rules/musterd-label-session.mdc',
    // ADR 333: catalog the orient ritual as a description-gated rule. The sessionStart hook injects
    // the block once; there is no repeating nudge on Cursor (beforeSubmitPrompt cannot inject).
    orientSkillPath: '.cursor/rules/musterd-orient.mdc',
  },

  // ADR 198: Cursor Agent hooks carry `model_id` / `model` on the common schema. Prefer the
  // structured id; ignore transcript_path — Cursor JSONL still has no message.model (Claude/Codex
  // pattern does not apply). Empty payload → undefined (honest degradation).
  observeModel: (payload) => {
    const id = payload.model_id?.trim() || payload.model?.trim();
    return id || undefined;
  },

  async detect() {
    const installed = existsSync(join(homedir(), '.cursor'));
    // The project entry is the one musterd writes, so it is the one to inspect; fall back to the
    // global entry only when this folder has none, mirroring `configured` below.
    const projectEntry = musterdEntry(projectConfigPath());
    const fromGlobal = projectEntry === null && hasMusterd(globalConfigPath());
    const entry = projectEntry ?? (fromGlobal ? musterdEntry(globalConfigPath()) : null);
    const configured = hasMusterd(projectConfigPath()) || hasMusterd(globalConfigPath());
    return {
      installed,
      configured,
      detail: fromGlobal
        ? 'registered in ~/.cursor/mcp.json (machine-global — musterd writes the project file)'
        : installed
          ? '~/.cursor present'
          : '~/.cursor not found',
      // Everything below describes the GLOBAL file when the fallback fired, and `configure` writes
      // the project one — so say which file it is, or the doctor prescribes a repair that rewrites
      // something else and reports success (ADR 168).
      ...(fromGlobal ? { registeredElsewhere: globalConfigPath() } : {}),
      // Read our own entry back so the doctor can flag a baked legacy value here too. This is where
      // the gap was measured (2026-08-03): a pre-ADR-165 `.cursor/mcp.json` carrying a per-seat
      // AGENT KEY and GRANT plus a stale MUSTERD_SURFACE, none of it reportable because nothing
      // outside Claude Code's `claude mcp get` was ever parsed.
      ...registeredFromEnv(entry?.env),
      ...(entry?.args ? { registeredArgs: entry.args } : {}),
    };
  },

  async configure(entry: McpServerEntry) {
    const path = projectConfigPath();
    const cfg = readConfig(path) ?? {};
    cfg.mcpServers = cfg.mcpServers ?? {};
    cfg.mcpServers['musterd'] = { command: entry.command, args: entry.args, env: entry.env };
    writeConfig(path, cfg);
    let hookWarnings: string[] = [];
    try {
      hookWarnings = installMusterdCursorHooks();
    } catch {
      /* non-fatal — MCP wiring is what matters; hooks are the observation seam */
    }
    return {
      target: path,
      activation:
        'open this folder in Cursor (or reload the window) so Cursor starts the musterd MCP server',
      scope: `wired into this folder only (${path}) — another project needs its own \`musterd init\`, and a second agent needs its own folder`,
      secretPath: path,
      ...(hookWarnings.length > 0 ? { warnings: hookWarnings } : {}),
    };
  },

  refreshHooks: {
    applies: (dir) => existsSync(projectConfigPath(dir)) || existsSync(projectHooksPath(dir)),
    run: (dir) => {
      const warnings = installMusterdCursorHooks(dir);
      return { files: [projectHooksPath(dir)], warnings };
    },
  },

  // Provision a role's MCP servers into the project-local `.cursor/mcp.json` map, additively
  // (ADR 027 — never clobber the user's other servers). `${ENV}` secrets are written as references;
  // Cursor expands them at launch (it is never resolved/baked here). Cursor has no managed
  // allow/ask/deny permission model, so permissions are *not* provisioned — they degrade to the
  // role's declared intent (charter); `provision` reports none added.
  async provision(plan: ProvisionPlan) {
    const path = projectConfigPath();
    const cfg = readConfig(path) ?? {};
    cfg.mcpServers = cfg.mcpServers ?? {};
    const servers: string[] = [];
    for (const s of plan.servers) {
      cfg.mcpServers[s.name] = { command: s.command, args: s.args, env: s.env };
      servers.push(s.name);
    }
    if (servers.length > 0) writeConfig(path, cfg);
    return {
      servers,
      permissions: { allow: [], ask: [], deny: [] },
      target: path,
      activation: 'reload Cursor (or reopen this folder) to pick up the new MCP servers',
    };
  },

  // Reverse a provision (ADR 027): remove exactly the named servers from `.cursor/mcp.json`.
  async unprovision(plan: UnprovisionPlan) {
    const path = projectConfigPath();
    const cfg = readConfig(path);
    if (!cfg?.mcpServers) return;
    let changed = false;
    for (const name of plan.servers) {
      if (name in cfg.mcpServers) {
        delete cfg.mcpServers[name];
        changed = true;
      }
    }
    if (changed) writeConfig(path, cfg);
    try {
      removeMusterdCursorHooks();
    } catch {
      /* best-effort */
    }
  },
};

// ── The fragment adapter (ADR 281/282/286, Task 5) ───────────────────────────────────────────────
// Cursor as MANAGED FRAGMENTS: `.cursor/mcp.json`'s musterd entry, the `.cursor/hooks.json`
// musterd hook set, and the `.cursor/rules` guidance files — each an independent fragment with its
// own key, in per-folder containers, parsed and validated as complete JSON before every scoped
// replacement. All access rides the injected FsSeam.

const CURSOR_HOOK_EVENTS = [
  ['preToolUse', CURSOR_GATE_HOOK_MARKER, 'Shell|Write|Delete|Edit|Task'],
  ['sessionStart', CURSOR_OBSERVE_HOOK_MARKER, undefined],
  ['postToolUse', CURSOR_OBSERVE_HOOK_MARKER, undefined],
  ['afterShellExecution', CURSOR_OBSERVE_HOOK_MARKER, undefined],
  ['afterMCPExecution', CURSOR_OBSERVE_HOOK_MARKER, undefined],
  ['sessionEnd', CURSOR_END_HOOK_MARKER, undefined],
] as const;

function cursorHooksPayload(): { event: string; command: string; matcher?: string }[] {
  return sortHookList(
    CURSOR_HOOK_EVENTS.map(([event, marker, matcher]) => ({
      event,
      command:
        marker === CURSOR_END_HOOK_MARKER
          ? sessionEndHookCommand()
          : marker === CURSOR_GATE_HOOK_MARKER
            ? preToolUseHookCommand()
            : event === 'sessionStart'
              ? sessionStartHookCommand()
              : event === 'postToolUse'
                ? postToolUseHookCommand()
                : observeHookCommand(),
      ...(matcher ? { matcher } : {}),
    })),
  );
}

/** One canonical order, shared by desire and observation, so equal state hashes equal. */
function sortHookList<T extends { event: string; command: string; matcher?: string }>(
  list: T[],
): T[] {
  return [...list].sort((a, b) =>
    a.event === b.event ? (a.command < b.command ? -1 : 1) : a.event < b.event ? -1 : 1,
  );
}

function readJsonSeam<T>(fs: FsSeam, path: string): T | null | undefined {
  const raw = fs.readFile(path);
  if (raw === null) return undefined; // absent
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null; // invalid
  }
}

function writeJsonSeam(fs: FsSeam, path: string, value: unknown): void {
  fs.mkdirp(dirname(path));
  fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 0o644);
}

const CURSOR_SURFACE = 'cursor';

export const cursorAdapter: HarnessAdapter = {
  id: 'cursor',
  surface: 'cursor',
  adapterVersion: 2,

  async availability(ctx) {
    // Installed iff the user-level Cursor dir exists. Read through the seam so scenario tests can
    // model a machine without Cursor; HOME comes from ctx.env, never ambient.
    const home = ctx.env['HOME'] ?? homedir();
    const present = ctx.fs.readFile(join(home, '.cursor', 'mcp.json')) !== null;
    const dirPresent = present || existsSync(join(home, '.cursor'));
    return dirPresent
      ? { available: true, detail: '~/.cursor present' }
      : { available: false, detail: '~/.cursor not found' };
  },

  async target(ctx) {
    return {
      containers: [
        {
          containerKey: `folder ${ctx.worktreeRoot} .cursor/mcp.json`,
          scope: 'folder',
          handle: 'mcp',
        },
        {
          containerKey: `folder ${ctx.worktreeRoot} .cursor/hooks.json`,
          scope: 'folder',
          handle: 'hooks',
        },
        {
          containerKey: `folder ${ctx.worktreeRoot} cursor-guidance`,
          scope: 'folder',
          handle: 'guidance',
        },
      ],
    };
  },

  async desiredFragments(ctx) {
    const launch = resolveMcpLaunch();
    const mcpPayload = {
      command: launch.command,
      args: launch.args,
      env: launchEntryEnv(CURSOR_SURFACE),
    };
    const hooks = cursorHooksPayload();
    const guidancePayload = guidanceFileMap(cursor.guidance!, ctx.team ?? '');
    return [
      {
        harness: 'cursor',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'cursor', 'mcp.musterd'),
        containerKey: `folder ${ctx.worktreeRoot} .cursor/mcp.json`,
        fragmentKey: 'mcp.musterd',
        scope: 'folder',
        fingerprint: canonicalFingerprint(mcpPayload),
        payload: mcpPayload,
      },
      {
        harness: 'cursor',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'cursor', 'hooks'),
        containerKey: `folder ${ctx.worktreeRoot} .cursor/hooks.json`,
        fragmentKey: 'hooks',
        scope: 'folder',
        fingerprint: canonicalFingerprint(hooks),
        payload: hooks,
      },
      {
        harness: 'cursor',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'cursor', 'guidance'),
        containerKey: `folder ${ctx.worktreeRoot} cursor-guidance`,
        fragmentKey: 'guidance',
        scope: 'folder',
        fingerprint: canonicalFingerprint(guidancePayload),
        payload: guidancePayload,
      },
    ];
  },

  async observe(ctx, intent) {
    switch (intent.fragmentKey) {
      case 'mcp.musterd': {
        const path = join(ctx.worktreeRoot, '.cursor', 'mcp.json');
        const cfg = readJsonSeam<CursorConfig>(ctx.fs, path);
        if (cfg === undefined) return { state: 'absent' };
        if (cfg === null || typeof cfg !== 'object') {
          return {
            state: 'invalid-container',
            issues: [{ path: '<.cursor/mcp.json>', message: 'not valid JSON' }],
          };
        }
        const entry = cfg.mcpServers?.['musterd'];
        if (!entry) return { state: 'absent' };
        const observed = { command: entry.command, args: entry.args ?? [], env: entry.env ?? {} };
        const fingerprint = canonicalFingerprint(observed);
        // 'legacy' (the retired MUSTERD_SURFACE) and 'none' (the ADR 165 marker-less shape — the
        // COMMON pre-286 fleet registration) are both the pre-ADR-286 class: neither can attach,
        // and confirmed configure's marker-only repair converts both while preserving the entry.
        return markerGenerationOfEnv(observed.env) !== 'launch'
          ? { state: 'legacy-launch-marker', fingerprint }
          : { state: 'present', fingerprint };
      }
      case 'hooks': {
        const path = join(ctx.worktreeRoot, '.cursor', 'hooks.json');
        const file = readJsonSeam<CursorHooksFile>(ctx.fs, path);
        if (file === undefined) return { state: 'absent' };
        if (file === null || typeof file !== 'object') {
          return {
            state: 'invalid-container',
            issues: [{ path: '<.cursor/hooks.json>', message: 'not valid JSON' }],
          };
        }
        // Fingerprint the SORTED physical form — payload-independent, so a release intent rebuilt
        // from ledger evidence observes the same fingerprint the write recorded.
        const observed: { event: string; command: string; matcher?: string }[] = [];
        for (const [event, defs] of Object.entries(file.hooks ?? {})) {
          for (const def of defs) {
            if (
              isMusterdCursorHook(def, CURSOR_OBSERVE_HOOK_MARKER) ||
              isMusterdCursorHook(def, CURSOR_END_HOOK_MARKER) ||
              isMusterdCursorHook(def, CURSOR_GATE_HOOK_MARKER)
            ) {
              observed.push({
                event,
                command: def.command,
                ...(def.matcher ? { matcher: def.matcher } : {}),
              });
            }
          }
        }
        if (observed.length === 0) return { state: 'absent' };
        return { state: 'present', fingerprint: canonicalFingerprint(sortHookList(observed)) };
      }
      case 'guidance':
        return observeFileMap(
          ctx.fs,
          ctx.worktreeRoot,
          (intent.payload as Record<string, string> | undefined) ??
            guidanceFileMap(cursor.guidance!, ctx.team ?? ''),
        );
      default:
        return { state: 'absent' };
    }
  },

  async apply(ctx, mutation) {
    const { intent } = mutation;
    switch (intent.fragmentKey) {
      case 'mcp.musterd': {
        const path = join(ctx.worktreeRoot, '.cursor', 'mcp.json');
        const read = readJsonSeam<CursorConfig>(ctx.fs, path);
        if (read === null) throw new Error('.cursor/mcp.json invalid at apply time');
        const cfg = read ?? {};
        const next: CursorConfig = { ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}) } };
        if (mutation.kind === 'remove') {
          delete next.mcpServers!['musterd'];
        } else if (mutation.kind === 'repair-launch-marker') {
          // Swap ONLY the retired marker on the existing entry; preserve everything else in it.
          const existing = next.mcpServers!['musterd'];
          if (existing) {
            const { ['MUSTERD_SURFACE']: _retired, ...rest } = existing.env ?? {};
            next.mcpServers!['musterd'] = {
              ...existing,
              env: { ...rest, ...launchEntryEnv(CURSOR_SURFACE) },
            };
          }
        } else {
          const payload = intent.payload as {
            command: string;
            args: string[];
            env: Record<string, string>;
          };
          next.mcpServers!['musterd'] = {
            command: payload.command,
            args: payload.args,
            env: payload.env,
          };
        }
        if (next.mcpServers && Object.keys(next.mcpServers).length === 0) delete next.mcpServers;
        writeJsonSeam(ctx.fs, path, next);
        return;
      }
      case 'hooks': {
        const path = join(ctx.worktreeRoot, '.cursor', 'hooks.json');
        const read = readJsonSeam<CursorHooksFile>(ctx.fs, path);
        if (read === null) throw new Error('.cursor/hooks.json invalid at apply time');
        const file = read ?? { version: 1, hooks: {} };
        const next: CursorHooksFile = {
          version: file.version || 1,
          hooks: { ...(file.hooks ?? {}) },
        };
        const desired =
          (intent.payload as { event: string; command: string; matcher?: string }[] | undefined) ??
          cursorHooksPayload();
        const events = new Set(desired.map((d) => d.event));
        for (const event of events) {
          const keep = (next.hooks![event] ?? []).filter(
            (h) =>
              !isMusterdCursorHook(h, CURSOR_OBSERVE_HOOK_MARKER) &&
              !isMusterdCursorHook(h, CURSOR_END_HOOK_MARKER) &&
              !isMusterdCursorHook(h, CURSOR_GATE_HOOK_MARKER),
          );
          const added =
            mutation.kind === 'remove'
              ? []
              : desired
                  .filter((d) => d.event === event)
                  .map((d) => ({
                    command: d.command,
                    ...(d.matcher ? { matcher: d.matcher } : {}),
                  }));
          const merged = [...keep, ...added];
          if (merged.length > 0) next.hooks![event] = merged;
          else delete next.hooks![event];
        }
        if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;
        writeJsonSeam(ctx.fs, path, next);
        return;
      }
      case 'guidance':
        applyFileMap(
          ctx.fs,
          ctx.worktreeRoot,
          (intent.payload as Record<string, string> | undefined) ??
            guidanceFileMap(cursor.guidance!, ctx.team ?? ''),
          mutation.kind === 'remove' ? 'remove' : 'write',
        );
        return;
      default:
        throw new Error(`unknown cursor fragment ${intent.fragmentKey}`);
    }
  },
};
