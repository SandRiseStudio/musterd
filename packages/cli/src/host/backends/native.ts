import {
  resolveAttestedModel,
  WAKE_TURN_TRANSCRIPT_MAX_BYTES,
  type AttestationSource,
  type Binding,
  type WakeTurnBody,
} from '@musterd/protocol';
import { resolveWorkspaceKey } from '@musterd/protocol/project';
import { HttpClient } from '../../client.js';
import { findBinding } from '../../config.js';
import { localSessionLiveness, type LocalSessionLiveness } from '../../session/liveness.js';
import type {
  ActuatorBackend,
  BackendContext,
  WakeActuation,
  WakeCompletion,
  WakeSpec,
} from '../backend.js';
import type { AgentLoopEngine, EngineTurn } from '../engine.js';
import { anthropicEngine } from '../engines/anthropic.js';
import { nativeMcpConfig, openNativeBridge, type NativeBridge } from './nativeBridge.js';

/**
 * Backend #3: the native row (ADR 251 — ADR 131 §7's closing reference implementation). `wake()`
 * spawns no child process: it starts an agent loop inside the host process, driven through the
 * {@link AgentLoopEngine} seam, with the seat's own MCP surface bridged in-memory as its tool set.
 *
 * The invariants the CLI rows carry hold with no process at all:
 * - the prompt is the daemon-composed line, verbatim — no message bodies enter the loop;
 * - occupancy is earned, never granted (ADR 251 §5): the wake prompt tells the agent to check its
 *   inbox, the first real tool call autojoins (ADR 108), and `verifyOccupied` polls the roster
 *   with the ADR 241 lease binding — loop internals are NEVER a verification source (ADR 131 §1);
 * - the watchdog timeout is mandatory: it aborts the loop, and the host awaits `settled`, so the
 *   loop can never be orphaned;
 * - `outcome` resolves at verification, inside the lease TTL; `settled` resolves when the runner
 *   finishes or the watchdog kills it, carrying `duration_ms` and a `cost_usd` COMPUTED from the
 *   engine's per-turn usage (§6) — the first backend whose spend is measured by the harness rather
 *   than self-reported by a child.
 *
 * Two substrate rails ride every run (§7): each turn posts a `wake-turn` row (usage + transcript)
 * through the daemon — best-effort, a dead rail never aborts the loop. Phase 1 is fresh-only
 * (`session: 'fresh'`); resume replays these capture rows in phase 2.
 */

/** Beat before the post-run final roster read — presence lands async after the last tool call. */
const FINAL_READ_DELAY_MS = 2_000;

/** ADR 101 env > binding, resolved by the backend so the engine can stay providerly dumb about
 *  ladders. Never defaults: an undeclared model defers the wake rather than guessing. */
export function resolveNativeModel(
  env: Record<string, string | undefined>,
  binding: Binding | null,
): { model: string | undefined; source: AttestationSource } {
  const fromEnv = resolveAttestedModel(env);
  if (fromEnv !== undefined) return { model: fromEnv, source: 'environment' };
  if (binding?.model !== undefined) return { model: binding.model, source: 'binding' };
  return { model: undefined, source: 'unknown' };
}

/** Cap a turn's transcript at the protocol bound; an oversized one becomes an honest marker
 *  rather than a rejected post (the capture row still prices the turn). */
export function boundTranscript(transcript: unknown): unknown {
  const bytes = JSON.stringify(transcript)?.length ?? 0;
  return bytes <= WAKE_TURN_TRANSCRIPT_MAX_BYTES ? transcript : { truncated: true, bytes };
}

/** The telemetry slice the backend posts through — injectable so tests never open a socket. */
export interface TurnTelemetry {
  wakeTurn(team: string, body: WakeTurnBody): Promise<{ ok: boolean; turn: number }>;
}

/** Injectables so the scripted suite drives every path without a model, daemon, or socket. */
export interface NativeDeps {
  engine?: AgentLoopEngine;
  openBridge?: typeof openNativeBridge;
  readBinding?: (workspace: string) => Binding | null;
  readSession?: (workspace: string) => LocalSessionLiveness;
  telemetry?: (server: string, agentKey: string) => TurnTelemetry;
  env?: Record<string, string | undefined>;
  finalReadDelayMs?: number;
}

const defaultTelemetry = (server: string, agentKey: string): TurnTelemetry =>
  new HttpClient({ server, key: agentKey }).presenceNeutral();

const deferred = (reason: string): WakeActuation => ({
  outcome: { occupied: false, deferred: true, reason: reason.slice(0, 200) },
  settled: Promise.resolve(undefined),
});

export function nativeBackend(deps: NativeDeps = {}): ActuatorBackend {
  return {
    harness: 'musterd',

    async wake(spec: WakeSpec, ctx: BackendContext): Promise<WakeActuation> {
      const seat = spec.order.seat;
      const env = deps.env ?? process.env;

      // Machine-property gates first (ADR 221 posture: none of these burns attempt budget).
      const binding = (deps.readBinding ?? ((ws: string) => findBinding(ws, {})))(spec.workspace);
      if (!binding?.agent_key) {
        return deferred(`workspace ${spec.workspace} has no binding/agent key for the native loop`);
      }
      const { model, source: modelSource } = resolveNativeModel(env, binding);
      if (model === undefined) {
        return deferred(
          'no model declared for the native loop (ADR 101: set MUSTERD_MODEL or binding.model) — never defaulted',
        );
      }
      // The local-session guard, re-checked defensively like every backend: an in-process loop
      // occupying the seat would displace a live session working in this worktree (ADR 068).
      const liveness = (deps.readSession ?? localSessionLiveness)(spec.workspace);
      if (liveness.state === 'live' || liveness.slotState === 'live') {
        return deferred('local-session-live');
      }

      // The seat's own tool surface, in-process (ADR 251 §4). A bridge that cannot stand up is a
      // real failure — the enrollment said this workspace hosts a native seat and it does not.
      let bridge: NativeBridge;
      const config = nativeMcpConfig({
        binding,
        server: spec.server,
        team: spec.team,
        seat,
        workspace: spec.workspace,
        workspaceKey: resolveWorkspaceKey(process.env, spec.workspace),
        leaseId: spec.order.lease_id,
        model,
        modelSource,
      });
      try {
        bridge = await (deps.openBridge ?? openNativeBridge)(config);
      } catch (err) {
        return {
          outcome: {
            occupied: false,
            reason: `failed to open the MCP bridge: ${(err as Error).message}`.slice(0, 200),
          },
          settled: Promise.resolve(undefined),
        };
      }

      const telemetry = (deps.telemetry ?? defaultTelemetry)(spec.server, binding.agent_key);
      const startedAt = Date.now();
      const controller = new AbortController();
      let timedOut = false;
      // The mandatory watchdog (ADR 131 §6): aborts the in-process loop instead of killing a tree.
      const watchdog = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, spec.bounds.timeout_ms);
      watchdog.unref();

      let telemetryFailed = false;
      const postTurn = (turn: EngineTurn): void => {
        // Fire-and-forget: the capture rail is best-effort by design; one narrator line on the
        // first failure, never per turn.
        void telemetry
          .wakeTurn(spec.team, {
            lease_id: spec.order.lease_id,
            turn: turn.index,
            usage: turn.usage,
            ...(turn.cost_usd !== undefined ? { cost_usd: turn.cost_usd } : {}),
            ...(turn.stop_reason !== null ? { stop_reason: turn.stop_reason } : {}),
            transcript: boundTranscript(turn.transcript),
          })
          .catch((err: Error) => {
            if (!telemetryFailed) ctx.log(`! wake-turn post failed for ${seat}: ${err.message}`);
            telemetryFailed = true;
          });
      };

      const engine = deps.engine ?? anthropicEngine();
      const runPromise = engine.run({
        model,
        prompt: spec.order.composed_line,
        tools: bridge.tools,
        maxTurns: spec.bounds.max_turns,
        signal: controller.signal,
        onTurn: postTurn,
      });

      // `settled` resolves when the runner finishes or the watchdog aborts it — the host awaits
      // this, so the loop (and the bridge's presence) can never be orphaned.
      const settled: Promise<WakeCompletion | undefined> = runPromise.then(async (result) => {
        clearTimeout(watchdog);
        await bridge.close();
        const cost = result.cost_usd !== undefined ? ` cost=$${result.cost_usd.toFixed(4)}` : '';
        ctx.log(
          `native loop for ${seat} settled: end=${result.end} turns=${String(result.turns)}` +
            `${cost} wall=${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
        );
        return {
          ...(result.cost_usd !== undefined ? { cost_usd: result.cost_usd } : {}),
          duration_ms: Date.now() - startedAt,
        };
      });

      // Verify from the roster, never from the loop. The second race arm handles a run that ended
      // before the windowed poller concluded (auth failure, instant error): give presence a beat,
      // then take one final read.
      const finalReadDelay = deps.finalReadDelayMs ?? FINAL_READ_DELAY_MS;
      const verified = await Promise.race([
        ctx.verifyOccupied(seat, undefined, startedAt),
        runPromise
          .then(() => new Promise((r) => setTimeout(r, finalReadDelay)))
          .then(() => ctx.verifyOccupied(seat, undefined, startedAt)),
      ]);

      if (verified.occupied && verified.lease_matched) {
        const wakeLatencyMs = Date.now() - startedAt;
        ctx.log(
          `⚡ woke ${seat}: invoke→roster ${(wakeLatencyMs / 1000).toFixed(1)}s, ` +
            `session=fresh provenance=${verified.provenance ?? 'unknown'} (native)`,
        );
        if (verified.provenance !== 'wake') {
          ctx.log(
            `note: occupancy attests provenance "${verified.provenance ?? 'none'}", not "wake" — ` +
              `unexpected for an in-process bridge (config drift?)`,
          );
        }
        // Outcome at verification; the loop runs on to actually answer, priced at settle.
        return { outcome: { occupied: true, session: 'fresh' }, settled };
      }

      if (verified.occupied && !verified.lease_matched) {
        // ADR 238/241: the seat is held by a session this wake did not create — defer, never
        // charge, and stop paying for a loop whose seat someone else owns.
        controller.abort();
        await runPromise;
        return {
          outcome: {
            occupied: false,
            deferred: true,
            session: 'fresh',
            reason: `the seat is held by another session (not lease ${spec.order.lease_id})`.slice(
              0,
              200,
            ),
          },
          settled,
        };
      }

      // No occupancy: the loop either already failed, or is still running without ever having
      // joined — either way it must not keep burning.
      controller.abort();
      const result = await runPromise;
      const completion = await settled;
      if (result.end === 'auth') {
        // Missing/invalid credentials are a property of this machine, not of the work — the same
        // budget-neutral posture as a missing CLI binary (ADR 221).
        return {
          outcome: {
            occupied: false,
            deferred: true,
            reason:
              `native engine credentials unavailable: ${result.reason ?? 'auth failed'}`.slice(
                0,
                200,
              ),
          },
          settled,
        };
      }
      const reason = timedOut
        ? `watchdog timeout (${String(spec.bounds.timeout_ms)}ms) before roster occupancy`
        : result.end === 'aborted'
          ? 'no roster occupancy within the verify window — native loop aborted'
          : `native loop ended (${result.end}${result.reason ? `: ${result.reason}` : ''}) without occupying the seat`;
      return {
        outcome: {
          occupied: false,
          session: 'fresh',
          reason: reason.slice(0, 200),
          // Fast-fail merge (increment 5 pattern): the run has settled — carry its summary on the
          // primary report so no supplement is needed.
          ...(completion?.cost_usd !== undefined ? { cost_usd: completion.cost_usd } : {}),
          ...(completion?.duration_ms !== undefined ? { duration_ms: completion.duration_ms } : {}),
        },
        settled,
      };
    },
  };
}
