#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import type { Transport } from '@modelcontextprotocol/server';
import {
  serveStdio,
  type StdioServerHandle,
  StdioServerTransport,
} from '@modelcontextprotocol/server/stdio';
import { renderPrimer } from '@musterd/protocol';
import { bind } from './bind.js';
import { MCP_ICONS } from './brand.js';
import { adoptIdentity, claimAndJoin, type ClaimTarget } from './claim.js';
import { MusterdClient } from './client.js';
import { instrumentToolCoercion } from './coerce.js';
import { isClaimedConfig, loadMcpConfig, type McpConfig } from './config.js';
import {
  type HarnessContext,
  observeHarnessInitialization,
  observeHarnessRequests,
} from './harness.js';
import { readAndConsumeResolution, writePendingMarker } from './pending.js';
import { instrumentToolRepair } from './repair.js';
import { scopeToolSurface } from './scope.js';
import { instrumentTools, recordAdapterInitialization, startMcpTelemetry } from './telemetry.js';
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
import { registerWakeContext } from './tools/wakeContext.js';
import {
  instrumentToolTransport,
  startToolTelemetryFlush,
  ToolCallRecorder,
} from './toolTelemetry.js';
import { ADAPTER_VERSION } from './version.js';

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

/* `measureToolSurface` is deliberately NOT re-exported here. It lives in `surfaceMeasure.ts`, which
 * imports `@modelcontextprotocol/client` — a devDependency, because measuring the surface means
 * standing up an in-memory client against our own server. A top-level re-export puts that module in
 * the runtime graph of `dist/index.js`, and ESM evaluates it eagerly: 0.4.0 shipped that way and
 * could not be loaded by any consumer at all (`ERR_MODULE_NOT_FOUND: @modelcontextprotocol/client`),
 * while staying invisible here because a workspace install has the dev deps. Its two consumers —
 * `scopeSurface.test.ts` and `scripts/context/check-budgets.ts` — both import the module directly,
 * which is the honest shape for a measurement harness. See `dist-imports.test.ts` for the guard. */

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
function armAutojoinOnFirstToolCall(
  server: McpServer,
  run: () => Promise<void>,
  client?: { releasedByLiveness: boolean; noteActivity?: () => void },
): void {
  // Memoize the SUCCESS, not the attempt. Holding the promise unconditionally meant one unlucky
  // moment at session start — a daemon bounce mid-attempt, a socket hang-up — dormanted the session
  // permanently: `wantPresence` never went true, so every later team_* call answered "you haven't
  // joined the team yet" (truthfully, and forever, because nothing tried again), and only a manual
  // `team_join` recovered it. That is fault B of the seat-drop lane, measured live on 2026-07-29:
  // two sends refused at different body sizes, then an explicit join reporting a FRESH join.
  //
  // Clearing the memo on rejection makes the next tool call retry. Probe safety is untouched — a
  // retry still only ever happens on a real tool call, never at initialize — and a failure still
  // must not fail the call it rode in on: the tool runs dormant and the guard message explains.
  let fired: Promise<void> | undefined;
  const attempt = (): Promise<void> =>
    (fired ??= run().catch((err: unknown) => {
      fired = undefined; // re-arm: the next tool call tries again
      throw err;
    }));
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
            // Re-arm when the ADR 164 liveness ladder released the seat (fault B2). The ladder
            // demotes on INFERENCE — a quiet transcript, an `ended_at` written for a session that
            // may not even be ours — and its own contract says a dormant adapter returns on the next
            // tool call. This is that return: a tool call is direct evidence the session is alive,
            // which outranks the inference that said otherwise. Scoped to the ladder deliberately;
            // an explicit `team_leave` stays left.
            // First-hand proof of life, recorded BEFORE anything else can judge us dead.
            client?.noteActivity?.();
            if (client?.releasedByLiveness) fired = undefined;
            // Never fail the call the attempt rode in on (the pre-existing posture, kept explicit
            // now that a rejection is observable rather than swallowed upstream).
            await attempt().catch(() => {});
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
  opts: {
    onFirstToolCall?: () => Promise<void>;
    recorder?: ToolCallRecorder;
    onHarness?: (harness: HarnessContext) => void;
  } = {},
): McpServer {
  const server = new McpServer(
    // version is package truth (ADR 175): serverInfo rides `server/discover` and every result's
    // `_meta` under MCP spec 2026-07-28 — a literal here re-drifts.
    { name: 'musterd', version: ADAPTER_VERSION, icons: [...MCP_ICONS] },
    {
      instructions: primerInstructions(config),
      // ADR 175 step 3: the surface is static per process, so a long TTL is honest — but it is
      // seat/role-scoped, so it must NEVER be cached across identities: `private`, not `public`.
      // Registration order is deterministic (the fixed register* sequence below), which is what
      // makes the cached listing stable rather than sorted.
      cacheHints: { 'tools/list': { ttlMs: 3_600_000, cacheScope: 'private' } },
    },
  );
  // Patch registerTool before any tool registers, so every handler runs inside a
  // `musterd.tool.call` span (ADR 089) — the active span the ADR 011 meta.otel plumbing needs.
  instrumentTools(server, client, config.team);
  // First-party tool-call telemetry (ADR 144 inc 1) hooks one level above the handlers, at the
  // SDK's tools/call request handler — the only seam that sees invalid-input bounces. Installed
  // before the first registerTool (which is what makes the SDK install that handler).
  if (opts.recorder) instrumentToolTransport(server, opts.recorder);
  // Repair hints on invalid-input bounces (ADR 144 inc 3) hook the same seam — the SDK bounces
  // before handlers run, so this is the only place a hint can be attached. Installed after the
  // telemetry patch, which makes telemetry the outer wrapper: it classifies the repaired result
  // (still a bounce — the classifier is start-anchored, the repair appends at the end).
  instrumentToolRepair(server);
  // Deterministic input coercion (ADR 144 inc 4) hooks the same seam once more, and is installed
  // LAST so it wraps INNERMOST — it must rewrite the arguments before the SDK validates them, while
  // telemetry stays outermost to classify the final result (a repaired call lands as `coerced`).
  instrumentToolCoercion(server);
  // Modern-era ADR 120 capture (ADR 175 step 5): clientInfo rides `_meta` per request under the
  // stateless protocol, read once at the tools/call seam. Installed here with the sibling patches
  // because it must precede the first registerTool — the legacy `oninitialized` path stays wired
  // in main(), and the caller's memo makes whichever fires first win.
  if (opts.onHarness) {
    observeHarnessRequests(
      server.server as unknown as Parameters<typeof observeHarnessRequests>[0],
      opts.onHarness,
    );
  }
  // Patched second so the deferred autojoin runs INSIDE the first tool's span — the join latency it
  // causes is attributed to the call that triggered it.
  if (opts.onFirstToolCall) armAutojoinOnFirstToolCall(server, opts.onFirstToolCall, client);
  // Scope by role (ADR 144 inc 5), installed LAST among the registerTool patches so it wraps
  // OUTERMOST: a tool this seat may not use is dropped before any sibling patch captures its schema,
  // so the skipped tool leaves no trace anywhere rather than half-existing. Fail-open by
  // construction — absent capabilities render everything (see `scope.ts`).
  scopeToolSurface(
    server as unknown as Parameters<typeof scopeToolSurface>[0],
    config.capabilities,
  );
  registerJoin(server, client, config);
  registerLeave(server, client, config);
  registerSend(server, client, config);
  registerInboxCheck(server, client);
  registerStatus(server, client);
  registerMembers(server, client);
  registerMemory(server, client);
  registerWakeContext(server, client);
  registerLanes(server, client);
  registerGoals(server, client);
  registerInsights(server, client);
  return server;
}

/**
 * The session autojoin (claim-on-first-use, ADR 032) — deferred to the first tool call by
 * `armAutojoinOnFirstToolCall` so a health probe never fires it. Fires ⇔ a default claim exists: a
 * session with a concrete identity just `join()`s when `config.autojoin` says so (resolved
 * `MUSTERD_AUTOJOIN` env > `binding.autojoin`, ADR 165 inc 2); a pending
 * session with a `seat`/`role` folder policy auto-claims that seat and occupies it. A `chat` policy
 * never auto-claims — the session stays a pending presence until a human names it.
 *
 * Best-effort, but it must **rethrow**: the caller memoizes success and re-arms on failure, so a
 * swallowed error read as "joined" and dormanted the session for good (the seat-drop lane's fault
 * B). Not crashing the adapter is the arming layer's job — it catches — and the failure is recorded
 * on the client so the dormant guard can say what went wrong instead of just "call team_join first".
 */
export async function autojoin(client: MusterdClient, config: McpConfig): Promise<void> {
  try {
    if (isClaimedConfig(config)) {
      // `config.member` is set ONLY by the `occupied` frame (client.ts), never by `loadMcpConfig` —
      // so this branch is unreachable at boot and reachable only on the arming layer's RE-ARM, after
      // the ADR 164 ladder released a seat this process had already occupied. Gating that recovery on
      // `config.autojoin` was the defect: autojoin is a BOOT policy (default false), and asking it
      // whether to come back from an inference-driven demotion made the FIRST SUCCESSFUL JOIN the
      // thing that disarmed the recovery — for every seat whose binding has no `autojoin` key, which
      // is every seat by default. Silently, too: returning without throwing gave the caller nothing
      // to catch, so the dormant guard went on repeating the ladder's "the next one re-joins" while
      // no tool call ever did. Measured live 2026-08-05 on two seats, izzo and dolly.
      //
      // A deliberate `team_leave` is excluded by construction — `leave()` clears the flag and only
      // `attestSession` re-sets it, so leaving still means left.
      if (config.autojoin || client.releasedByLiveness) await client.join();
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
    const message = (err as Error).message;
    process.stderr.write(`musterd autojoin failed: ${message}\n`);
    client.noteJoinFailure(`${message} (autojoin; the next tool call retries)`);
    throw err;
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

/**
 * The production stdio entry (ADR 175 part b): `serveStdio` owns the era decision — the opening
 * exchange selects it, ONE instance from the factory is pinned for the connection lifetime, and
 * `legacy: 'serve'` pins a 2025-era instance served exactly as the old hand-wired
 * `connect(StdioServerTransport)` served it. So every current harness (all of them open with
 * `initialize`) sees a byte-identical wire, while a client that opens with `server/discover` gets
 * the 2026-07-28 era — instructions and serverInfo on discover, the ADR 175 step-3 cache hints
 * (armed since #565, unreachable on the legacy wire by SDK design) finally on `tools/list` — with
 * no musterd release on the day a harness flips its `versionNegotiation` default. Adopted now
 * rather than gated on that flip because the flip is unobservable from this side of the wire: an
 * `'auto'` client probes via a sibling process whose stderr is discarded and then falls back to a
 * connect indistinguishable from today's traffic (the part-(a) dead-man-switch lesson, applied one
 * level up).
 *
 * The factory may run more than once per process — serveStdio's opening rules can draw a probe
 * instance and a fallback pin from it — which is safe because `buildMcpServer` shares only the
 * MusterdClient, the recorder, and the caller's memoized capture across instances. The legacy-era
 * ADR 120 capture (`oninitialized`) is installed per instance here for the same reason.
 */
export function startStdioEntry(
  client: MusterdClient,
  config: McpConfig,
  opts: {
    onFirstToolCall?: () => Promise<void>;
    recorder?: ToolCallRecorder;
    onHarness?: (harness: HarnessContext | undefined) => void;
    /** Tests inject an in-memory wire; production defaults to the process's stdio. */
    transport?: Transport;
  } = {},
): StdioServerHandle {
  const { transport, onHarness, ...buildOpts } = opts;
  return serveStdio(
    () => {
      const server = buildMcpServer(client, config, {
        ...buildOpts,
        ...(onHarness ? { onHarness } : {}),
      });
      // Legacy clients still open with `initialize`, so the ADR 120 capture's legacy half rides
      // every instance the factory mints; the modern half is installed inside buildMcpServer.
      if (onHarness) observeHarnessInitialization(server.server, onHarness);
      return server;
    },
    {
      legacy: 'serve',
      // Out-of-band entry errors are reporting-only; stderr is the one channel MCP leaves us.
      onerror: (error) => process.stderr.write(`musterd stdio entry: ${error.message}\n`),
      ...(transport ? { transport } : {}),
    },
  );
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
  // The tool-call recorder (ADR 144 inc 1) is probe-safe by the same construction: it only ever
  // sends after a real tool call gave the session a seat to attribute to.
  const recorder = new ToolCallRecorder();
  // ADR 120 capture, both protocol eras (ADR 175 step 5): a legacy client still sends initialize
  // (`oninitialized` fires); a 2026-07-28 client never does — its clientInfo rides `_meta` on every
  // request and is read once at the tools/call seam (installed inside buildMcpServer, before the
  // tools register). First capture wins; bounded adapter-local diagnostics either way, never a
  // model or Envelope field.
  let harnessSeen = false;
  const captureHarnessOnce = (harness: HarnessContext | undefined): void => {
    if (!harness || harnessSeen) return;
    harnessSeen = true;
    recordAdapterInitialization(config, harness);
  };
  // The transport is constructed here (not defaulted inside serveStdio) so the shutdown seam
  // below can keep watching `transport.onclose` — serveStdio owns start/close, we wrap after.
  const transport = new StdioServerTransport();
  startStdioEntry(client, config, {
    onFirstToolCall: () => autojoin(client, config),
    recorder,
    onHarness: captureHarnessOnce,
    transport,
  });
  const stopToolTelemetry = startToolTelemetryFlush(client, recorder);

  // The one graceful teardown, shared by every exit path: stop the resolution watcher, drop presence,
  // and flush the telemetry tail with a hard cap so a dead collector never hangs the exit.
  const teardown = async (): Promise<void> => {
    stopWatcher?.();
    // Final tool-telemetry flush BEFORE the client closes (it sends through it); hard-capped
    // inside reportToolTelemetry so a dead daemon never hangs the exit.
    await stopToolTelemetry();
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
