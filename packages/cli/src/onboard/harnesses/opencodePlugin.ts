import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeclined } from '../declined.js';

/**
 * The OpenCode doorbell (ADR 392): a **managed plugin file** at `.opencode/plugins/musterd.js`.
 *
 * OpenCode has no hook table (ADR 321 §8) but it does have a plugin event channel (ADR 362 corrected
 * the premise; that ADR declined to ship a *capture* plugin and its three findings stand). The
 * interrupt line is a different job from capture: it needs no `session.created`/resume event
 * (finding 1 is moot — the probe rides tool boundaries and idle, both of which fire on a resumed
 * session), and the executable-surface objection (finding 2) is met the way every other harness's
 * hook is: one marker-owned file, no dependencies (no `package.json`, so no `bun install`), a
 * generation stamp the doctor compares against what THIS build writes (ADR 168), and
 * `musterd init --refresh-hooks` as the only writer. Version coupling (finding 3) is bounded to two
 * documented hooks — `tool.execute.after` and `event` — and none of the `experimental.*` seams.
 *
 * What it does, measured against ghost's eval (`docs/wiki/opencode-live-doorbell-eval.md`):
 * - `tool.execute.after` — at every tool boundary run `musterd inbox --interrupt-check`; a raised
 *   line is appended to the tool's `output`, which is the text the model reads next. Silent and
 *   free on the common path (the CLI prints nothing unless an interrupt-class act waits). The MCP-
 *   tool-path caveat (eval §2: mutation may not reach the model for MCP calls on 1.14.x) is the
 *   named falsifier; the idle rail below is the floor if it holds on 1.18.x.
 * - `event: session.idle` — the Stop-hook analog (ADR 370's idle-at-turn-end rung): a raised line is
 *   delivered as a reply-triggering `prompt_async`, capped per session so an ignored bell cannot
 *   burn budget forever (Grok caps at 8; this caps lower because reply-mode spends a real turn).
 *
 * The plugin never composes text: the line is the daemon's (ADR 088), fenced so the model can tell
 * it from tool output, and the CLI keeps every gate it already has (`MUSTERD_NO_NUDGE`, explicit
 * bound seat, best-effort silence on any failure).
 */

export const OPENCODE_PLUGIN_MARKER = 'musterd-opencode-interrupt';
/** Bump when the rendered plugin changes: the doctor names a file stamped otherwise as STALE. */
export const OPENCODE_PLUGIN_GENERATION = 1;
export const OPENCODE_PLUGIN_SURFACE = 'opencode:plugin';
/** Reply-mode idle bells per session before the plugin goes quiet (see module doc). */
export const OPENCODE_IDLE_BELL_CAP = 4;

export function opencodePluginPath(dir: string = process.cwd()): string {
  return join(dir, '.opencode', 'plugins', 'musterd.js');
}

export function opencodePluginHeader(generation: number = OPENCODE_PLUGIN_GENERATION): string {
  return `// ${OPENCODE_PLUGIN_MARKER} v${String(generation)} — managed by \`musterd init\` (ADR 392). Do not edit; \`musterd init --refresh-hooks\` rewrites it.`;
}

/**
 * The plugin source. Plain ESM JavaScript on node built-ins only, so it runs under OpenCode's
 * bundled Bun without an install step AND under node for the unit that executes it.
 */
export function renderOpencodePlugin(): string {
  return `${opencodePluginHeader()}
import { execFile } from "node:child_process";

const PROBE_ARGS = ["inbox", "--interrupt-check"];
const PROBE_TIMEOUT_MS = 5000;
const IDLE_BELL_CAP = ${String(OPENCODE_IDLE_BELL_CAP)};
const OPEN = "<musterd-interrupt>";
const CLOSE = "</musterd-interrupt>";

// One daemon-composed line, or "" — never a throw, never a rejection (a probe on every tool call
// must never disrupt the loop, ADR 088). cwd is the seat folder so the bound seat resolves.
function probe(directory) {
  return new Promise((resolve) => {
    if (process.env.MUSTERD_NO_NUDGE === "1") return resolve("");
    let settled = false;
    const finish = (line) => {
      if (settled) return;
      settled = true;
      resolve(line);
    };
    try {
      execFile(
        "musterd",
        PROBE_ARGS,
        { cwd: directory, encoding: "utf8", timeout: PROBE_TIMEOUT_MS, env: process.env },
        (err, stdout) => finish(err ? "" : String(stdout ?? "").trim()),
      );
    } catch {
      finish("");
    }
  });
}

export const MusterdInterrupt = async ({ client, directory }) => {
  const bells = new Map();
  return {
    "tool.execute.after": async (_input, output) => {
      const line = await probe(directory);
      if (!line) return;
      const fenced = OPEN + "\\n" + line + "\\n" + CLOSE;
      output.output = output.output ? output.output + "\\n\\n" + fenced : fenced;
    },
    event: async ({ event }) => {
      if (!event || event.type !== "session.idle") return;
      const id = event.properties && event.properties.sessionID;
      if (!id) return;
      const rung = bells.get(id) || 0;
      if (rung >= IDLE_BELL_CAP) return;
      const line = await probe(directory);
      if (!line) return;
      bells.set(id, rung + 1);
      try {
        await client.session.promptAsync({
          path: { id },
          body: { parts: [{ type: "text", text: line, synthetic: true }] },
        });
      } catch {
        // best-effort: the bell is a courtesy to the model, not an obligation on the harness
      }
    },
  };
};
`;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Generation stamped in the header of an installed plugin, `undefined` for a foreign/absent file. */
export function installedPluginGeneration(raw: string): number | undefined {
  const m = raw.match(new RegExp(`^// ${OPENCODE_PLUGIN_MARKER} v(\\d+)`));
  return m ? Number(m[1]) : undefined;
}

/**
 * Write (or rewrite) the plugin. Returns warnings, never throws for the refresh driver's sake:
 * - a file at the path that is NOT ours is left alone and named (ADR 027: never clobber a user's
 *   plugin);
 * - a file stamped by a NEWER build is left alone and named (ADR 168 downgrade guard).
 */
export function installMusterdOpencodePlugin(dir: string = process.cwd()): string[] {
  if (isDeclined(dir, OPENCODE_PLUGIN_SURFACE)) return [];
  const path = opencodePluginPath(dir);
  const existing = readText(path);
  if (existing !== null) {
    const theirs = installedPluginGeneration(existing);
    if (theirs === undefined) {
      return [
        `${path} exists and is not musterd's — left untouched (ADR 027). Move it aside and run \`musterd init --refresh-hooks\` to install the doorbell plugin.`,
      ];
    }
    if (theirs > OPENCODE_PLUGIN_GENERATION) {
      return [
        `${path} was written by a newer musterd build (plugin v${String(theirs)}, this build v${String(OPENCODE_PLUGIN_GENERATION)}) — not downgrading it (ADR 168). Update this checkout instead.`,
      ];
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderOpencodePlugin(), 'utf8');
  return [];
}

/** Remove exactly our file; a foreign plugin at the path stays. */
export function removeMusterdOpencodePlugin(dir: string = process.cwd()): void {
  const path = opencodePluginPath(dir);
  const existing = readText(path);
  if (existing === null) return;
  if (installedPluginGeneration(existing) === undefined) return;
  rmSync(path, { force: true });
}

/**
 * Doctor evidence (ADR 168 for OpenCode): a missing plugin means no probe runs at all — the exact
 * state this lane was opened on ("nothing probes"). A present-but-stale one is named as stale, since
 * a plugin's value is entirely in its text.
 */
export function inspectOpencodePluginDrift(dir: string = process.cwd()): string[] {
  if (isDeclined(dir, OPENCODE_PLUGIN_SURFACE)) return [];
  const path = opencodePluginPath(dir);
  const existing = readText(path);
  if (existing === null) {
    return [
      'the OpenCode doorbell plugin is missing from .opencode/plugins/musterd.js — nothing probes the interrupt line at any tool boundary, so a busy or idle agent will not see urgent steering (ADR 088/392). Run `musterd init --refresh-hooks` here to install it.',
    ];
  }
  const theirs = installedPluginGeneration(existing);
  if (theirs === undefined) {
    return [
      ".opencode/plugins/musterd.js exists but is not musterd's plugin — the doorbell is not installed under that name (ADR 027). Move the file aside and run `musterd init --refresh-hooks`.",
    ];
  }
  if (existing !== renderOpencodePlugin()) {
    return [
      `the OpenCode doorbell plugin in .opencode/plugins/musterd.js was written by a different musterd build (v${String(theirs)}, this build v${String(OPENCODE_PLUGIN_GENERATION)}) and no longer matches this one — it is present but STALE, which no presence check can see (ADR 168). Run \`musterd init --refresh-hooks\` here to rewrite it.`,
    ];
  }
  return [];
}

export function opencodePluginPresent(dir: string = process.cwd()): boolean {
  return existsSync(opencodePluginPath(dir));
}
