import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  registeredFromEnv,
  type Harness,
  type ProvisionPlan,
  type UnprovisionPlan,
} from '../harness.js';
import type { McpServerEntry } from '../mcpEntry.js';
import { launchEntryEnv, markerGenerationOfEnv, resolveMcpLaunch } from '../mcpEntry.js';
import type { FsSeam } from '../reconcile/context.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  type HarnessAdapter,
} from '../reconcile/fragments.js';

/**
 * OpenCode. OpenCode reads MCP servers from the `mcp` map of a JSON config that can be
 * **global** (`~/.config/opencode/opencode.json[|c]`) or **project-local**
 * (`.opencode/opencode.json[|c]`). musterd writes the **project-local plain-JSON** file only —
 * the same non-invasive posture as Codex's `.codex/config.toml` and Cursor's `.cursor/mcp.json`
 * (ADR 027): one folder, in-tree, gitignorable, cleanly removable, never touching the user's
 * global setup (the ADR 031 rule; ADR 321 §3 carries it here).
 *
 * The managed entry follows the published config schema exactly (`McpLocalConfig`):
 * `{ type: 'local', command: string[], enabled?: boolean, environment?: Record<string,string> }`
 * — note `environment`, not `env`; and the schema sets `additionalProperties: false`, so the
 * writer must not invent fields.
 *
 * Guidance needs nothing new (ADR 321 §4): OpenCode reads AGENTS.md natively, so the primer's
 * managed block is already its guidance shell, pointing at the harness-neutral canonical skill.
 * It also has no hook table — capture rides heartbeat-side reconciliation (ADR 270), which is
 * why this adapter declares no `refreshHooks` slot and its `observeModel` honestly degrades.
 */

/**
 * The jsonc honesty rule (ADR 321 §3): musterd manages **plain JSON** only. If the folder (or,
 * for detection reporting, the global location) carries `opencode.jsonc`, writing a parallel
 * `.json` would leave two live configs whose merge precedence is opencode's private concern —
 * so we refuse and say why instead of picking a winner silently.
 */
export function jsoncConflict(dir: string = process.cwd()): string | undefined {
  const projectJsonc = join(dir, '.opencode', 'opencode.jsonc');
  if (existsSync(projectJsonc)) return projectJsonc;
  return undefined;
}

function projectConfigPath(dir: string = process.cwd()): string {
  return join(dir, '.opencode', 'opencode.json');
}

/** Read-only, same rule as every adapter's global path (ADR 031): inspected, never written. */
function globalConfigPath(): string {
  return join(homedir(), '.config', 'opencode', 'opencode.json');
}

interface OpencodeLocalMcp {
  type: 'local';
  command: string[];
  enabled?: boolean;
  cwd?: string;
  timeout?: number;
  environment?: Record<string, string>;
}

type OpencodeMcpEntry = OpencodeLocalMcp | { type: 'remote'; url: string };

interface OpencodeConfig {
  mcp?: Record<string, OpencodeMcpEntry>;
  [key: string]: unknown;
}

function readConfig(path: string): OpencodeConfig | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as OpencodeConfig;
  } catch {
    return null;
  }
}

function writeConfig(path: string, cfg: OpencodeConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

function toOpencodeServer(entry: McpServerEntry): OpencodeLocalMcp {
  return {
    type: 'local',
    command: [entry.command, ...entry.args],
    enabled: true,
    environment: entry.env,
  };
}

/** Our registered entry from an opencode config, or undefined when the file does not carry one. */
function musterdEntry(cfg: OpencodeConfig | null): OpencodeLocalMcp | undefined {
  const entry = cfg?.mcp?.['musterd'];
  return entry && entry.type === 'local' ? entry : undefined;
}

export const opencode: Harness = {
  id: 'opencode',
  label: 'OpenCode',
  surface: 'opencode',
  // `.opencode/opencode.json` is per-folder — and in-tree, so a secret here is committable
  // (same story as .cursor/mcp.json; secretPath is set in configure).
  entryScope: 'folder',

  // ADR 321 §8: no hook channel exists for live model events, but the opencode session DB
  // (`~/.local/share/opencode/opencode.db`) records the model for every session. Reading the most
  // recent session for this workspace gives an `observed` attestation that outranks the declared
  // `binding.model` tier — so a `muse-spark` session attests as `observed` rather than `binding`.
  // Falls back to `undefined` (honest degradation) when the DB is absent or unreadable.
  observeModel: () => {
    try {
      const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
      if (!existsSync(dbPath)) return undefined;
      const cwd = process.cwd();
      const out = execFileSync(
        'sqlite3',
        [
          dbPath,
          `SELECT model FROM session WHERE directory='${cwd.replace(/'/g, "''")}' ORDER BY time_updated DESC LIMIT 1;`,
        ],
        { encoding: 'utf8', timeout: 1000 },
      ).trim();
      if (!out) return undefined;
      const parsed = JSON.parse(out) as { id?: string; modelID?: string; model?: string };
      const id = parsed.id ?? parsed.modelID ?? parsed.model;
      return typeof id === 'string' && id.trim() ? id.trim().slice(0, 120) : undefined;
    } catch {
      return undefined;
    }
  },

  async detect() {
    const installed =
      existsSync(join(homedir(), '.local', 'share', 'opencode')) ||
      existsSync(join(homedir(), '.config', 'opencode'));
    const conflict = jsoncConflict();
    if (conflict) {
      return {
        installed,
        configured: false,
        detail: `${conflict} present — musterd manages plain opencode.json only; wire the server into it by hand or rename the file`,
      };
    }
    const projectCfg = readConfig(projectConfigPath());
    const inProject = musterdEntry(projectCfg) !== undefined;
    const globalCfg = inProject ? null : readConfig(globalConfigPath());
    const inGlobal = !inProject && musterdEntry(globalCfg) !== undefined;
    const configured = inProject || inGlobal;
    const entry = inProject ? musterdEntry(projectCfg) : musterdEntry(globalCfg);
    return {
      installed,
      configured,
      detail: inGlobal
        ? 'registered in ~/.config/opencode/opencode.json (machine-global — musterd writes the project file)'
        : conflict
          ? conflict
          : installed
            ? '~/.local/share/opencode present'
            : 'opencode install not found',
      ...(entry ? registeredFromEnv(entry.environment) : {}),
      ...(inGlobal ? { registeredElsewhere: globalConfigPath() } : {}),
    };
  },

  async configure(entry: McpServerEntry) {
    const conflict = jsoncConflict();
    if (conflict) {
      throw new Error(
        `${conflict} present — musterd writes plain .opencode/opencode.json and will not race a jsonc config`,
      );
    }
    const path = projectConfigPath();
    const cfg = readConfig(path) ?? {};
    cfg.mcp = cfg.mcp ?? {};
    cfg.mcp['musterd'] = toOpencodeServer(entry);
    writeConfig(path, cfg);
    return {
      target: path,
      activation: '(re)start opencode in this folder so it starts the musterd MCP server',
      scope: `wired into this folder only (${path}) — another project needs its own \`musterd init\`, and a second agent needs its own folder`,
      secretPath: path,
    };
  },

  // Provision a role's MCP servers into the project-local `.opencode/opencode.json`, additively
  // (ADR 027 — never clobber the user's other `mcp.*` entries or any of their other settings).
  // `${ENV}` secrets are written as references, never resolved/baked here. OpenCode has no
  // per-tool allowlist model, so permissions degrade to declared intent (none added).
  async provision(plan: ProvisionPlan) {
    const path = projectConfigPath();
    const cfg = readConfig(path) ?? {};
    cfg.mcp = cfg.mcp ?? {};
    const servers: string[] = [];
    for (const s of plan.servers) {
      cfg.mcp[s.name] = toOpencodeServer(s);
      servers.push(s.name);
    }
    if (servers.length > 0) writeConfig(path, cfg);
    return {
      servers,
      permissions: { allow: [], ask: [], deny: [] },
      target: path,
      activation: 'restart opencode in this folder to pick up the new MCP servers',
    };
  },

  // Reverse a provision (ADR 027): remove exactly the named `mcp.*` entries.
  async unprovision(plan: UnprovisionPlan) {
    const path = projectConfigPath();
    const cfg = readConfig(path);
    if (!cfg?.mcp) return;
    let changed = false;
    for (const name of plan.servers) {
      if (name in cfg.mcp) {
        delete cfg.mcp[name];
        changed = true;
      }
    }
    if (!changed) return;
    if (Object.keys(cfg.mcp).length === 0) delete cfg.mcp;
    writeConfig(path, cfg);
  },
};

// ── The fragment adapter (ADR 281/282/286; ADR 321 §5) ───────────────────────────────────────────
// OpenCode as MANAGED FRAGMENTS: the single `mcp.musterd` local-server entry inside
// `.opencode/opencode.json` — every other key in the file passes through untouched (JSON
// round-trip, minimal diff, ADR 321 §3). No hooks fragment exists to manage (§8), and guidance
// stays the canonical musterd-core fragment produced by the engine itself.

const OPENCODE_SURFACE = 'opencode';

/** The canonical physical form we fingerprint — desired and observed reconstruct it identically. */
interface MusterdOpencodePayload {
  type: 'local';
  command: string[];
  enabled: boolean;
  environment: Record<string, string>;
}

function toPayload(server: OpencodeLocalMcp): MusterdOpencodePayload {
  return {
    type: 'local',
    command: server.command,
    enabled: server.enabled ?? true,
    environment: server.environment ?? {},
  };
}

function readJsonSeam(fs: FsSeam, path: string): OpencodeConfig | null | undefined {
  const raw = fs.readFile(path);
  if (raw === null) return undefined; // absent
  try {
    return JSON.parse(raw) as OpencodeConfig;
  } catch {
    return null; // invalid
  }
}

export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode',
  surface: OPENCODE_SURFACE,
  adapterVersion: 1,

  async availability(ctx) {
    const home = ctx.env['HOME'] ?? homedir();
    const present =
      existsSync(join(home, '.local', 'share', 'opencode')) ||
      existsSync(join(home, '.config', 'opencode'));
    return present
      ? { available: true, detail: '~/.local/share/opencode present' }
      : { available: false, detail: 'opencode install not found' };
  },

  async target(ctx) {
    return {
      containers: [
        {
          containerKey: `folder ${ctx.worktreeRoot} .opencode/opencode.json`,
          scope: 'folder',
          handle: 'mcp',
        },
      ],
    };
  },

  async desiredFragments(ctx) {
    const launch = resolveMcpLaunch();
    const mcpPayload: MusterdOpencodePayload = {
      type: 'local',
      command: [launch.command, ...launch.args],
      enabled: true,
      environment: launchEntryEnv(OPENCODE_SURFACE),
    };
    return [
      {
        harness: 'opencode',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'opencode', 'mcp.musterd'),
        containerKey: `folder ${ctx.worktreeRoot} .opencode/opencode.json`,
        fragmentKey: 'mcp.musterd',
        scope: 'folder',
        fingerprint: canonicalFingerprint(mcpPayload),
        payload: mcpPayload,
      },
    ];
  },

  async observe(ctx, intent) {
    if (intent.fragmentKey !== 'mcp.musterd') return { state: 'absent' };
    const path = join(ctx.worktreeRoot, '.opencode', 'opencode.json');
    const cfg = readJsonSeam(ctx.fs, path);
    if (cfg === undefined) return { state: 'absent' };
    if (cfg === null || typeof cfg !== 'object') {
      return {
        state: 'invalid-container',
        issues: [{ path: '<.opencode/opencode.json>', message: 'not valid JSON' }],
      };
    }
    const entry = cfg.mcp?.['musterd'];
    if (!entry || entry.type !== 'local') return { state: 'absent' };
    const observed = toPayload(entry);
    const fingerprint = canonicalFingerprint(observed);
    // Same marker classification as every sibling adapter (ADR 286): 'legacy' (the retired
    // MUSTERD_SURFACE) and 'none' (marker-less, the common pre-286 registration) are the
    // pre-ADR-286 class that confirmed configure's repair converts in place.
    return markerGenerationOfEnv(observed.environment) !== 'launch'
      ? { state: 'legacy-launch-marker', fingerprint }
      : { state: 'present', fingerprint };
  },

  async apply(ctx, mutation) {
    if (mutation.intent.fragmentKey !== 'mcp.musterd') {
      throw new Error(`unknown opencode fragment ${mutation.intent.fragmentKey}`);
    }
    const path = join(ctx.worktreeRoot, '.opencode', 'opencode.json');
    const read = readJsonSeam(ctx.fs, path);
    if (read === null) throw new Error('.opencode/opencode.json invalid at apply time');
    const cfg: OpencodeConfig = { ...read };
    const mcp: Record<string, OpencodeMcpEntry> = { ...(cfg.mcp ?? {}) };
    if (mutation.kind === 'remove') {
      delete mcp['musterd'];
    } else if (mutation.kind === 'repair-launch-marker') {
      const existing = mcp['musterd'];
      if (existing && existing.type === 'local') {
        const { ['MUSTERD_SURFACE']: _retired, ...rest } = existing.environment ?? {};
        mcp['musterd'] = {
          ...existing,
          environment: { ...rest, ...launchEntryEnv(OPENCODE_SURFACE) },
        };
      }
    } else {
      // The intended shape came through the strict representation gate before the write opened;
      // the JSON round-trip preserves every key this file had that musterd does not own.
      mcp['musterd'] = mutation.intent.payload as OpencodeLocalMcp;
    }
    if (Object.keys(mcp).length > 0) cfg.mcp = mcp;
    else delete cfg.mcp;
    ctx.fs.mkdirp(dirname(path));
    ctx.fs.writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`, 0o644);
  },
};
