import type { Capabilities } from '@musterd/protocol';
import { TOOL_NAMES } from './toolNames.js';

/**
 * Scope the rendered tool surface by the seat's capabilities (ADR 144 increment 5) — structural
 * least privilege at render: an observer never loads acting tools it can never use.
 *
 * WHAT THIS IS NOT. The render is **not** the security boundary. The daemon enforces capabilities
 * in-band on every send (`route.ts`: a `can_message: 'none'` seat is refused and audited
 * `send.denied`), and it would do so whether or not the tool was rendered. What scoping buys is
 * **context economy and clarity**: a read-only seat stops paying connect-time bytes for thirteen
 * tools whose every use would bounce, and stops being tempted to reach for them. Because it is an
 * economy lever rather than a gate, the correct failure mode is **fail-open** — an unknown
 * capability record renders everything (see {@link scopedToolNames}). A missing tool is a dead end
 * for the agent; an extra one costs bytes the server will refuse anyway.
 *
 * STABILITY. The surface is fixed for the life of a session: scoping happens once, at render, and
 * the tool list is never mutated mid-session (ADR 144's frozen "stability over dynamism" — a
 * changing list is cache-hostile, and ADR 175 now advertises `ttlMs: 1h` + `cacheScope: 'private'`
 * on `tools/list`, which this makes honest: the surface really is per-identity). A role change
 * between sessions simply re-renders on the next connect.
 *
 * DECLARATIVE, NOT PROCEDURAL. The policy is the {@link WRITE_TOOLS} set plus the tiny predicate in
 * {@link scopedToolNames} — data the render consumes, never permission logic scattered through the
 * registration calls (the policy/enforcement decoupling ADR 144 §5 asks for, without taking a
 * policy-engine dependency).
 */

/**
 * The acting half of the surface: every tool whose purpose is to change team state. Deriving the
 * read-only half by subtraction (rather than keeping a second list) is deliberate — a new tool is
 * read-only by default, which is the safe direction to be wrong in: it renders for everyone, and
 * the daemon still refuses it for a seat that may not use it.
 *
 * `team_join` / `team_leave` are deliberately ABSENT. Occupancy is not messaging: a muted seat must
 * still be able to take and release its own seat, or it could never come online to observe at all.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set<string>([
  'team_send',
  'team_memory_save',
  'team_goal_declare',
  'lane_open',
  'lane_claim',
  'lane_release',
  'lane_handoff',
  'lane_update',
  'lane_submit',
  'lane_ready',
  'lane_resolve',
]);

/**
 * The tool names to register for a seat with these capabilities, in registration order.
 *
 * `undefined` capabilities means "not known at render time" and yields the full surface — the
 * fail-open contract above. The only narrowing today is `can_message: 'none'` (the muted seat, the
 * enforced Universe-1 field that makes a role genuinely read-only); further axes join here as data
 * when a role needs them, which is why the signature takes the whole capability record rather than
 * a boolean.
 */
export function scopedToolNames(capabilities: Capabilities | undefined): string[] {
  if (!capabilities || capabilities.can_message !== 'none') return [...TOOL_NAMES];
  // Filter, never sort: registration order is what keeps the cached `tools/list` byte-stable.
  return TOOL_NAMES.filter((name) => !WRITE_TOOLS.has(name));
}

/** A registered tool, as the SDK returns it — we neither read nor reshape it, only pass it back. */
type Registered = unknown;

/**
 * Apply {@link scopedToolNames} to a server by dropping out-of-scope `registerTool` calls.
 *
 * Patching the registration seam (rather than making each `register*` call conditional) keeps the
 * policy in one place and works regardless of which module owns a tool — `registerLanes` alone
 * registers seven. Install LAST among the registerTool patches so this wraps outermost: a dropped
 * tool never reaches the coercion/repair schema captures, so it leaves no partial state behind.
 *
 * A skipped registration returns `undefined` where the SDK would return a `RegisteredTool`. Nothing
 * in this package reads that return value; if a caller ever does, it must tolerate a scoped-out
 * tool — which is the honest shape, because the tool genuinely does not exist for this seat.
 */
export function scopeToolSurface(
  server: { registerTool: (...args: unknown[]) => Registered },
  capabilities: Capabilities | undefined,
): void {
  const allowed = new Set(scopedToolNames(capabilities));
  // Nothing to filter for a full surface — leave the seam untouched rather than add a pass-through
  // wrapper to every generalist session (the overwhelmingly common case).
  if (allowed.size === TOOL_NAMES.length) return;
  const original = server.registerTool.bind(server) as (...args: unknown[]) => Registered;
  server.registerTool = (...args: unknown[]): Registered => {
    const name = args[0];
    if (typeof name === 'string' && !allowed.has(name)) return undefined;
    return original(...args);
  };
}
