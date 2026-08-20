import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readModelFromTranscript } from '../../session/transcript-model.js';
import {
  registeredFromEnv,
  type Harness,
  type ProvisionPlan,
  type UnprovisionPlan,
} from '../harness.js';
import type { McpServerEntry } from '../mcpEntry.js';
import {
  CODEX_HOOK_MARKER,
  codexHookCommands,
  codexHooksPath,
  inspectCodexHookDrift,
  installCodexHooks,
  removeCodexHooks,
} from './codexHooks.js';
import {
  hasServer,
  readServer,
  readServerEnv,
  removeServers,
  upsertServer,
  type CodexServer,
} from './codexToml.js';
import { launchEntryEnv, markerGenerationOfEnv, resolveMcpLaunch } from '../mcpEntry.js';
import type { FsSeam } from '../reconcile/context.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  type HarnessAdapter,
} from '../reconcile/fragments.js';

/**
 * Codex (OpenAI Codex CLI). Codex reads MCP servers from `[mcp_servers.<name>]` tables in a TOML
 * config that can be **global** (`~/.codex/config.toml`) or **project-local** (`.codex/config.toml`,
 * trusted projects). musterd writes the **project-local** file — the same non-invasive posture as
 * Cursor's `.cursor/mcp.json` (ADR 027): one folder, in-tree, gitignorable, cleanly removable, and
 * never touching the user's global Codex setup or polluting their other projects (ADR 031).
 *
 * It edits TOML directly via a minimal `[mcp_servers.*]`-scoped helper rather than the `codex mcp
 * add` CLI: that CLI's write target (global vs. project) isn't a documented, stable flag, and writing
 * the project-local file ourselves is the deterministic, correct-scope choice — and needs no TOML
 * dependency (hard rule #6). See ADR 031.
 */
function projectConfigPath(dir: string = process.cwd()): string {
  return join(dir, '.codex', 'config.toml');
}

/**
 * Codex's machine-global config. musterd never WRITES it (see above), but Codex merges it with the
 * project file, so a musterd server defined here is live in every folder on the machine — and
 * reading it back is the only way `init --check` can stop reporting "no musterd server" while one is
 * plainly there. Read-only by construction: nothing in this adapter passes this path to `writeToml`.
 */
function globalConfigPath(): string {
  return join(homedir(), '.codex', 'config.toml');
}

function readToml(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function writeToml(path: string, toml: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toml.endsWith('\n') ? toml : toml + '\n', 'utf8');
}

function toCodexServer(entry: McpServerEntry): CodexServer {
  return { command: entry.command, args: entry.args, env: entry.env };
}

export const codex: Harness = {
  id: 'codex',
  label: 'Codex',
  surface: 'codex',
  // `.codex/config.toml` is per-folder — and in-tree, so a secret here is committable (ADR 031).
  entryScope: 'folder',
  // No `guidance` (ADR 085): Codex has no project-level skill/rule or slash-command mechanism, so it
  // relies on the harness-neutral `.musterd/skill/SKILL.md` (always written) that the primer points at.

  // Codex rollout logs are JSONL carrying the same `message.model` shape, so the shared reader
  // handles both. A `musterd host`-spawned Codex seat is authoritative from its spawn arguments and
  // never needs this path; a hand-launched one gets whatever its rollout log reports, or `undefined`.
  observeModel: (payload) =>
    payload.transcript_path ? readModelFromTranscript(payload.transcript_path) : undefined,

  async detect() {
    const installed = existsSync(join(homedir(), '.codex'));
    const projectToml = readToml(projectConfigPath());
    // The project file is what musterd writes, so it is what an entry here MEANS — the global file
    // is the fallback, and only when the folder has none of its own. Getting this order wrong would
    // attribute another seat's baked credential to this folder.
    const inProject = hasServer(projectToml, 'musterd');
    const globalToml = inProject ? '' : readToml(globalConfigPath());
    const inGlobal = !inProject && hasServer(globalToml, 'musterd');
    const configured = inProject || inGlobal;
    // Scoped to folders Codex is actually wired into. Hook drift is a claim about provisioning
    // musterd DID, and `installCodexHooks` runs only from `configure`, so an unconfigured folder has
    // no drift to have — it has an absence that is correct. Ungated, this reported a hard ✗ naming
    // `.codex/hooks.json` in every Claude-Code-only folder, contradicting the "no musterd server"
    // line printed directly above it, and with no safe repair to offer (ADR 168).
    const hookDrift = configured ? inspectCodexHookDrift(process.cwd()) : [];
    return {
      installed,
      configured,
      detail: inGlobal
        ? 'registered in ~/.codex/config.toml (machine-global — musterd writes the project file)'
        : installed
          ? '~/.codex present'
          : '~/.codex not found',
      // Read the entry's env back so the doctor can flag a baked legacy value here too. Before this,
      // only Claude Code's entry was ever inspected, so a per-seat secret or a stale MUSTERD_SURFACE
      // in `.codex/config.toml` was invisible by construction.
      ...(inProject ? registeredFromEnv(readServerEnv(projectToml, 'musterd')) : {}),
      // A global entry's values are just as live — they outrank binding.json in the adapter's ladder
      // exactly the same way — but no repair run in this folder rewrites that file, so it is reported
      // WITH its location rather than with a prescription (ADR 168).
      ...(inGlobal
        ? {
            ...registeredFromEnv(readServerEnv(globalToml, 'musterd')),
            registeredElsewhere: globalConfigPath(),
          }
        : {}),
      ...(hookDrift.length > 0 ? { hookDrift } : {}),
    };
  },

  /**
   * The ADR 168 safe repair for this harness's hooks — the sibling Codex never declared, which is
   * why `musterd init --refresh-hooks` skipped it and the doctor was left pointing at `musterd
   * wire` (which only registers the MCP server and never installs a hook). Without this the only
   * path that reached `installCodexHooks` was the full `musterd init`, barred from a live seat's
   * workspace by ADR 161 — a detected drift with no runnable repair.
   *
   * `applies` follows the contract's line between refresh and first install: the project config is
   * the file `configure` writes, so its presence is what "musterd provisioned Codex here" means.
   */
  refreshHooks: {
    applies: (dir) => existsSync(projectConfigPath(dir)) || existsSync(codexHooksPath(dir)),
    run: (dir) => {
      const files = installCodexHooks(dir);
      // A malformed file is left untouched by design (it may be hand-authored), and returns no
      // files — so without this the driver would print "✓ Codex hooks refreshed" over a repair that
      // never happened. Reuse the inspector's own wording rather than inventing a second phrasing.
      const warnings =
        files.length === 0 ? inspectCodexHookDrift(dir).filter((d) => d.includes('malformed')) : [];
      return { files, warnings };
    },
  },

  async configure(entry: McpServerEntry) {
    const path = projectConfigPath();
    writeToml(path, upsertServer(readToml(path), 'musterd', toCodexServer(entry)));
    installCodexHooks(process.cwd());
    return {
      target: path,
      activation:
        'open this folder in Codex (it must be a trusted project) so Codex starts the musterd MCP server',
      scope: `wired into this folder only (${path}) — another project needs its own \`musterd init\`, and a second agent needs its own folder`,
      secretPath: path,
    };
  },

  // Provision a role's MCP servers into the project-local `.codex/config.toml`, additively
  // (ADR 027 — never clobber the user's other `[mcp_servers.*]` tables or their other settings).
  // `${ENV}` secrets are written as references, never resolved/baked here; whether Codex expands them
  // is Codex's concern — musterd writes the template's reference string, never a real secret.
  // Codex has no per-tool allowlist model, so permissions degrade to declared intent (none added).
  async provision(plan: ProvisionPlan) {
    const path = projectConfigPath();
    let toml = readToml(path);
    const servers: string[] = [];
    for (const s of plan.servers) {
      toml = upsertServer(toml, s.name, { command: s.command, args: s.args, env: s.env });
      servers.push(s.name);
    }
    if (servers.length > 0) writeToml(path, toml);
    return {
      servers,
      permissions: { allow: [], ask: [], deny: [] },
      target: path,
      activation: 'reload Codex (or reopen this folder) to pick up the new MCP servers',
    };
  },

  // Reverse a provision (ADR 027): remove exactly the named `[mcp_servers.*]` tables.
  async unprovision(plan: UnprovisionPlan) {
    const path = projectConfigPath();
    const toml = readToml(path);
    if (toml.length === 0) return;
    const next = removeServers(toml, plan.servers);
    if (next !== toml) writeToml(path, next);
    if (!hasServer(next, 'musterd')) removeCodexHooks(process.cwd());
  },
};

// ── The fragment adapter (ADR 281/282/286, Task 5) ───────────────────────────────────────────────
// Codex as MANAGED FRAGMENTS: the `[mcp_servers.musterd]` table in `.codex/config.toml` (all other
// TOML sections pass through byte-for-byte — the minimal scoped writer, ADR 031) and the musterd
// hook handlers in `.codex/hooks.json`. Every intended table shape is validated through the strict
// adapter-owned representation BEFORE the write path opens (ADR 286 §3). Codex has no project
// skill/rule mechanism, so guidance stays the canonical musterd-core fragment.

const CODEX_SURFACE = 'codex';

interface CodexHooksJson {
  hooks?: Record<string, { hooks: { type?: string; command?: string }[] }[]>;
  [key: string]: unknown;
}

function readHooksJson(fs: FsSeam, path: string): CodexHooksJson | null | undefined {
  const raw = fs.readFile(path);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as CodexHooksJson;
  } catch {
    return null;
  }
}

function musterdCodexHandlers(file: CodexHooksJson): { event: string; command: string }[] {
  const out: { event: string; command: string }[] = [];
  for (const [event, groups] of Object.entries(file.hooks ?? {})) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        if (typeof handler.command === 'string' && handler.command.includes(CODEX_HOOK_MARKER)) {
          out.push({ event, command: handler.command });
        }
      }
    }
  }
  return out.sort((a, b) => (a.event < b.event ? -1 : 1));
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  surface: 'codex',
  adapterVersion: 2,

  async availability(ctx) {
    const home = ctx.env['HOME'] ?? homedir();
    const present = existsSync(join(home, '.codex'));
    return present
      ? { available: true, detail: '~/.codex present' }
      : { available: false, detail: '~/.codex not found' };
  },

  async target(ctx) {
    return {
      containers: [
        {
          containerKey: `folder ${ctx.worktreeRoot} .codex/config.toml`,
          scope: 'folder',
          handle: 'toml',
        },
        {
          containerKey: `folder ${ctx.worktreeRoot} .codex/hooks.json`,
          scope: 'folder',
          handle: 'hooks',
        },
      ],
    };
  },

  async desiredFragments(ctx) {
    const launch = resolveMcpLaunch();
    const mcpPayload: CodexServer = {
      command: launch.command,
      args: launch.args,
      env: launchEntryEnv(CODEX_SURFACE),
    };
    const hooks = [...codexHookCommands()].sort((a, b) => (a.event < b.event ? -1 : 1));
    return [
      {
        harness: 'codex',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'codex', 'mcp.musterd'),
        containerKey: `folder ${ctx.worktreeRoot} .codex/config.toml`,
        fragmentKey: 'mcp.musterd',
        scope: 'folder',
        fingerprint: canonicalFingerprint(mcpPayload),
        payload: mcpPayload,
      },
      {
        harness: 'codex',
        resourceKey: folderResourceKey(ctx.worktreeRoot, 'codex', 'hooks'),
        containerKey: `folder ${ctx.worktreeRoot} .codex/hooks.json`,
        fragmentKey: 'hooks',
        scope: 'folder',
        fingerprint: canonicalFingerprint(hooks),
        payload: hooks,
      },
    ];
  },

  async observe(ctx, intent) {
    switch (intent.fragmentKey) {
      case 'mcp.musterd': {
        const toml = ctx.fs.readFile(join(ctx.worktreeRoot, '.codex', 'config.toml'));
        if (toml === null) return { state: 'absent' };
        const entry = readServer(toml, 'musterd');
        if (!entry) return { state: 'absent' };
        const fingerprint = canonicalFingerprint(entry);
        return markerGenerationOfEnv(entry.env) === 'legacy'
          ? { state: 'legacy-launch-marker', fingerprint }
          : { state: 'present', fingerprint };
      }
      case 'hooks': {
        const file = readHooksJson(ctx.fs, join(ctx.worktreeRoot, '.codex', 'hooks.json'));
        if (file === undefined) return { state: 'absent' };
        if (file === null) {
          return {
            state: 'invalid-container',
            issues: [{ path: '<.codex/hooks.json>', message: 'not valid JSON' }],
          };
        }
        // Fingerprint the canonical PHYSICAL form — payload-independent, so a release intent
        // rebuilt from ledger evidence observes the fingerprint the write recorded.
        const observed = musterdCodexHandlers(file);
        if (observed.length === 0) return { state: 'absent' };
        return { state: 'present', fingerprint: canonicalFingerprint(observed) };
      }
      default:
        return { state: 'absent' };
    }
  },

  async apply(ctx, mutation) {
    const { intent } = mutation;
    switch (intent.fragmentKey) {
      case 'mcp.musterd': {
        const path = join(ctx.worktreeRoot, '.codex', 'config.toml');
        const toml = ctx.fs.readFile(path) ?? '';
        let next: string;
        if (mutation.kind === 'remove') {
          next = removeServers(toml, ['musterd']);
        } else if (mutation.kind === 'repair-launch-marker') {
          const observed = readServer(toml, 'musterd');
          if (!observed) return;
          const { ['MUSTERD_SURFACE']: _retired, ...rest } = observed.env;
          next = upsertServer(toml, 'musterd', {
            command: observed.command,
            args: observed.args,
            env: { ...rest, ...launchEntryEnv(CODEX_SURFACE) },
          });
        } else {
          // The strict representation gate: an invalid intended shape throws inside upsertServer,
          // before this write path opens — the prior TOML bytes stay untouched.
          next = upsertServer(toml, 'musterd', intent.payload as CodexServer);
        }
        ctx.fs.mkdirp(dirname(path));
        ctx.fs.writeFile(path, next.endsWith('\n') ? next : `${next}\n`, 0o644);
        return;
      }
      case 'hooks': {
        const path = join(ctx.worktreeRoot, '.codex', 'hooks.json');
        const read = readHooksJson(ctx.fs, path);
        if (read === null) throw new Error('.codex/hooks.json invalid at apply time');
        const file = read ?? {};
        const hooks: NonNullable<CodexHooksJson['hooks']> = {};
        // Keep every non-musterd handler/group; drop every marker-owned one.
        for (const [event, groups] of Object.entries(file.hooks ?? {})) {
          const retained = groups
            .map((group) => ({
              ...group,
              hooks: group.hooks.filter(
                (h) => !(typeof h.command === 'string' && h.command.includes(CODEX_HOOK_MARKER)),
              ),
            }))
            .filter((group) => group.hooks.length > 0);
          if (retained.length > 0) hooks[event] = retained;
        }
        if (mutation.kind !== 'remove') {
          const payload =
            (intent.payload as { event: string; command: string }[] | undefined) ??
            codexHookCommands();
          for (const { event, command } of payload) {
            hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command }] }];
          }
        }
        const next: CodexHooksJson = { ...file };
        if (Object.keys(hooks).length > 0) next.hooks = hooks;
        else delete next.hooks;
        ctx.fs.mkdirp(dirname(path));
        ctx.fs.writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 0o644);
        return;
      }
      default:
        throw new Error(`unknown codex fragment ${intent.fragmentKey}`);
    }
  },
};
