#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { renderPrimer } from '@musterd/protocol';
import { bind } from './bind.js';
import { adoptIdentity, claimAndJoin, type ClaimTarget } from './claim.js';
import { MusterdClient } from './client.js';
import { isClaimedConfig, loadMcpConfig, type McpConfig } from './config.js';
import { readAndConsumeResolution, writePendingMarker } from './pending.js';
import { instrumentTools, startMcpTelemetry } from './telemetry.js';
import { registerGoals } from './tools/goals.js';
import { registerInboxCheck } from './tools/inboxCheck.js';
import { registerInsights } from './tools/insights.js';
import { registerJoin } from './tools/join.js';
import { registerLanes } from './tools/lanes.js';
import { registerLeave } from './tools/leave.js';
import { registerMembers } from './tools/members.js';
import { registerMemory } from './tools/memory.js';
import { registerSend } from './tools/send.js';
import { registerStatus } from './tools/status.js';

export { MusterdClient } from './client.js';
export { loadMcpConfig, type McpConfig } from './config.js';
export { bind } from './bind.js';
export { resolveWorkspace, resolveProvenance } from './workspace.js';
export { withTraceContext } from './otel.js';

/**
 * Drop presence and exit on every way the host can go away. The WS socket keeps Node's event loop
 * alive, so without this the adapter outlives its session and leaves the member stuck "online" until
 * a reaper sweep that can't help (the socket is still attached). The canonical stdio-server shutdown
 * signal is the host closing our stdin; signals and transport close are belt-and-suspenders for hosts
 * that SIGTERM or just drop the pipe. Idempotent — many signals can race for the same teardown.
 * Returns a cleanup that removes the listeners (used by tests; the real process just exits).
 */
export function installShutdownHandlers(opts: {
  close: () => void | Promise<void>;
  transport: { onclose?: (() => void) | undefined };
  exit?: (code: number) => void;
  signals?: NodeJS.Process;
  stdin?: {
    on(event: 'end' | 'close', cb: () => void): unknown;
    off?: (event: string, cb: () => void) => unknown;
  };
}): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const proc = opts.signals ?? process;
  const stdin = opts.stdin ?? process.stdin;
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // An async close (e.g. a bounded telemetry flush, ADR 089) delays exit until it settles; a
    // sync close keeps the historical exit-immediately behavior.
    const result = opts.close();
    if (result instanceof Promise) void result.finally(() => exit(0));
    else exit(0);
  };
  const sigs = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const sig of sigs) proc.on(sig, shutdown);
  stdin.on('end', shutdown);
  stdin.on('close', shutdown);
  const priorOnClose = opts.transport.onclose;
  opts.transport.onclose = () => {
    priorOnClose?.();
    shutdown();
  };
  return () => {
    for (const sig of sigs) proc.removeListener(sig, shutdown);
    stdin.off?.('end', shutdown);
    stdin.off?.('close', shutdown);
  };
}

/**
 * The standing primer this server returns as MCP `instructions` on initialize (ADR 012 follow-up):
 * the same `renderPrimer` the CLI writes into AGENTS.md, so an agent is onboarded **without any file**
 * — works on every MCP-speaking harness. A provisioned session names its seat; an unclaimed one is
 * told to `team_join` first. Pure, so it's unit-testable without standing up the server.
 */
export function primerInstructions(config: McpConfig): string {
  // Before claiming, name the seat the folder is bound to claim (the policy target); after, the
  // resolved seat. v0.3 (ADR 075): the seat is server-resolved at claim, so a role pool stays unnamed.
  const seat = config.member ?? (config.claim?.mode === 'seat' ? config.claim.name : undefined);
  return renderPrimer({ team: config.team, ...(seat ? { member: seat } : {}) });
}

/** The canonical registered-tool names (ADR 085) — kept in a dependency-free module so the guidance
 * drift check can import it without the MCP SDK; re-exported here for normal consumers. */
export { TOOL_NAMES } from './toolNames.js';

/** Tools that must NOT trigger the deferred launch autojoin: an explicit `team_join` supersedes the
 * implicit one (firing both would claim twice), and a `team_leave` must never cause a join. */
const AUTOJOIN_EXEMPT_TOOLS = new Set(['team_join', 'team_leave']);

/**
 * Arm `run` to fire once, before the FIRST real tool call (probe safety — the root cause of the
 * seat-supersession ping-pong). A harness health probe (`claude mcp get musterd`, doctor, the ADR 060
 * SessionStart verify) launches this adapter, completes the MCP `initialize` handshake, and exits —
 * so anything that runs at boot runs on every probe. The launch autojoin used to claim the seat at
 * boot, which meant each probe fired a real one-shot claim that displaced the live same-workspace
 * session (ADR 068 displacement) milliseconds before dying. Tool calls are the boundary probes never
 * cross: a real session's first act is a tool call (the SessionStart hook asks for `team_inbox_check`
 * immediately), a probe's is never. Memoized: concurrent and later calls share the one join.
 */
function armAutojoinOnFirstToolCall(server: McpServer, run: () => Promise<void>): void {
  let fired: Promise<void> | undefined;
  const original = server.registerTool.bind(server) as (
    name: string,
    config: unknown,
    cb: (...args: unknown[]) => unknown,
  ) => unknown;
  (server as { registerTool: unknown }).registerTool = (
    name: string,
    config: unknown,
    cb: (...args: unknown[]) => unknown,
  ) =>
    original(
      name,
      config,
      AUTOJOIN_EXEMPT_TOOLS.has(name)
        ? cb
        : async (...args: unknown[]) => {
            await (fired ??= run());
            return cb(...args);
          },
    );
}

/** Build (but do not connect) the MCP server with the musterd tools registered. `onFirstToolCall`
 * (when given) runs once before the first non-join tool call — `main()` passes the launch autojoin
 * here so a health probe that never calls a tool never claims a seat. */
export function buildMcpServer(
  client: MusterdClient,
  config: ReturnType<typeof loadMcpConfig>,
  opts: { onFirstToolCall?: () => Promise<void> } = {},
): McpServer {
  const server = new McpServer(
    { name: 'musterd', version: '0.2.0' },
    { instructions: primerInstructions(config) },
  );
  // Patch registerTool before any tool registers, so every handler runs inside a
  // `musterd.tool.call` span (ADR 089) — the active span the ADR 011 meta.otel plumbing needs.
  instrumentTools(server, client, config.team);
  // Patched second so the deferred autojoin runs INSIDE the first tool's span — the join latency it
  // causes is attributed to the call that triggered it.
  if (opts.onFirstToolCall) armAutojoinOnFirstToolCall(server, opts.onFirstToolCall);
  registerJoin(server, client, config);
  registerLeave(server, client, config);
  registerSend(server, client, config);
  registerInboxCheck(server, client);
  registerStatus(server, client);
  registerMembers(server, client);
  registerMemory(server, client);
  registerLanes(server, client);
  registerGoals(server, client);
  registerInsights(server, client);
  return server;
}

/**
 * The session autojoin (claim-on-first-use, ADR 032) — deferred to the first tool call by
 * `armAutojoinOnFirstToolCall` so a health probe never fires it. Fires ⇔ a default claim exists: a
 * session with a concrete identity just `join()`s (today's `MUSTERD_AUTOJOIN=1` path); a pending
 * session with a `seat`/`role` folder policy auto-claims that seat and occupies it. A `chat` policy
 * never auto-claims — the session stays a pending presence until a human names it. Best-effort: a
 * failure is reported to stderr and leaves the session pending/dormant rather than crashing the
 * adapter.
 */
export async function autojoin(client: MusterdClient, config: McpConfig): Promise<void> {
  try {
    if (isClaimedConfig(config)) {
      if (process.env['MUSTERD_AUTOJOIN'] === '1') await client.join();
      return;
    }
    const target: ClaimTarget | null =
      config.claim.mode === 'seat'
        ? { seat: config.claim.name }
        : config.claim.mode === 'role'
          ? { role: config.claim.role }
          : null;
    if (target) await claimAndJoin(client, config, target);
  } catch (err) {
    process.stderr.write(`musterd autojoin failed: ${(err as Error).message}\n`);
  }
}

/**
 * Watch for a resolution an external `musterd claim --for <code>` drops for this pending session (ADR
 * 034) and adopt it — bringing an already-running unclaimed adapter online without a relaunch. Polls
 * (portable + testable, no `fs.watch`); the interval is unref'd so it never holds the process open.
 * Stops itself once the session is claimed (here or via an in-session `team_join`). Returns a stop fn.
 */
export function startResolutionWatcher(
  client: MusterdClient,
  config: McpConfig,
  opts: { intervalMs?: number } = {},
): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped || client.claimed || client.joined) return;
    const resolved = readAndConsumeResolution(config);
    if (!resolved) return;
    try {
      await adoptIdentity(client, config, resolved.seat);
    } catch (err) {
      process.stderr.write(`musterd claim adoption failed: ${(err as Error).message}\n`);
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 1000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function main(): Promise<void> {
  const config = loadMcpConfig();
  // Off by default: a no-op unless the operator set an OTLP endpoint (ADR 089 / ADR 015 posture).
  const telemetry = await startMcpTelemetry(config);
  const client = new MusterdClient(config);
  await bind(client); // dormant: reachability only, no presence claimed
  // A session that starts unclaimed is a pending presence — drop a marker so `musterd claim` can
  // find it (ADR 033) and watch for an external claim that brings it online live (ADR 034).
  let stopWatcher: (() => void) | undefined;
  if (!isClaimedConfig(config)) {
    writePendingMarker(config);
    stopWatcher = startResolutionWatcher(client, config);
  }
  // The launch autojoin is DEFERRED to the first tool call (probe safety, see
  // armAutojoinOnFirstToolCall): a health probe that only completes `initialize` must not claim —
  // the boot-time claim is what let every `claude mcp get musterd` displace the live seat.
  const server = buildMcpServer(client, config, {
    onFirstToolCall: () => autojoin(client, config),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The one graceful teardown, shared by every exit path: stop the resolution watcher, drop presence,
  // and flush the telemetry tail with a hard cap so a dead collector never hangs the exit.
  const teardown = (): Promise<void> => {
    stopWatcher?.();
    client.close();
    return telemetry.shutdown({ timeoutMs: 1000 });
  };
  // ADR 092: when the server tells us a same-workspace successor replaced us (a reload orphaned this
  // process), exit cleanly instead of lingering dormant-but-alive — the host is gone. `installShutdown`
  // handles the host-driven exits (stdin close / signals); this handles the server-driven one.
  client.onReplaced = () => {
    void teardown().finally(() => process.exit(0));
  };

  installShutdownHandlers({ close: teardown, transport });
}

// Run only when invoked directly (not when imported by tests).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`musterd MCP failed to start: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
