import {
  ClaimFrame,
  FEATURE_EPOCH,
  OccupiedFrame,
  PendingFrame,
  PROTOCOL_VERSION,
  RefusedFrame,
} from '@musterd/protocol';
import type { ClaimTarget, RefusedCode, Surface } from '@musterd/protocol';

/**
 * The pure client-side half of the v0.3 `claim` handshake (ADR 075/078, SPEC A.3) — the frame builder
 * + the response state machine, with **no transport + no live-server dependency**. The P3.3 cutover
 * wires this into `claim`/`join` (replacing `hello`); until then it is additive + unit-tested against
 * the landed `@musterd/protocol` schemas, so it tracks the contract without depending on Cleo's ADR
 * 077 endpoint shapes (the WS send / stateless `POST /teams/:slug/claim` wiring lands with those).
 *
 * The state machine (SPEC A.3): `connecting → authenticated(key) → claim → (occupied | refused |
 * pending) → [subscribed] → live`. `occupied`/`refused` are terminal; `pending` holds for the
 * server-pushed terminal frame (spec-gap 3 — no client polling).
 */

/** A parsed `MUSTERD_CLAIM` env string (ADR 075): `seat:<name>` | `role:<name>` | `observe`. */
export function parseClaimTarget(raw: string | undefined): ClaimTarget {
  if (!raw)
    throw new Error('MUSTERD_CLAIM is empty — expected `seat:<name>`, `role:<name>`, or `observe`');
  const s = raw.trim();
  if (s === 'observe') return { observe: true };
  const sep = s.indexOf(':');
  if (sep <= 0) {
    throw new Error(
      `MUSTERD_CLAIM "${raw}" is malformed — expected \`seat:<name>\`, \`role:<name>\`, or \`observe\``,
    );
  }
  const kind = s.slice(0, sep);
  const value = s.slice(sep + 1).trim();
  if (!value) throw new Error(`MUSTERD_CLAIM "${raw}" names no target after "${kind}:"`);
  if (kind === 'seat') return { seat: value };
  if (kind === 'role') return { role: value };
  throw new Error(`MUSTERD_CLAIM "${raw}" — unknown kind "${kind}"; use seat:, role:, or observe`);
}

/** Build + validate the `claim` WS frame (SPEC A.3) from the credential env + target. Throws on a
 *  shape error (the schema is the executable contract, ADR 078). `key` + `grant` are secrets — the
 *  caller reads them from env/binding and never logs them. */
export function buildClaimFrame(input: {
  team: string;
  key: string;
  target: ClaimTarget;
  surface: Surface;
  grant?: string;
  workspace?: string;
  model?: string;
  build?: string;
}): ClaimFrame {
  return ClaimFrame.parse({
    type: 'claim',
    v: PROTOCOL_VERSION,
    team: input.team,
    key: input.key,
    target: input.target,
    ...(input.grant !== undefined ? { grant: input.grant } : {}),
    // The claiming workspace (ADR 068) — scopes single-active and labels the presence's "where", so a
    // CLI-claimed seat reads with a real workspace instead of null (also lets a bare re-claim tell
    // "already live *here*" from "live elsewhere", ADR 087).
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
    // Model attestation (ADR 101) — harness-attested per-occupancy; absent reads as `unknown`.
    ...(input.model !== undefined ? { model: input.model } : {}),
    // Build attestation (ADR 135) — the client dist's own stamp; absent for unstamped builds.
    ...(input.build !== undefined ? { build: input.build } : {}),
    // Feature epoch (ADR 148) — this CLI dist's compiled-in capability counter; always attested (a
    // constant, not a stamp), so a CLI-claimed seat carries the roster's skew signal like any other.
    epoch: FEATURE_EPOCH,
    surface: input.surface,
  });
}

/** The terminal claim outcome — `occupied` (success) or `refused` (denied). `pending` is the
 *  non-terminal wait state (the server pushes the terminal frame next, spec-gap 3). */
export type ClaimOutcome =
  | {
      state: 'occupied';
      seat: OccupiedFrame['seat'];
      presenceId: string;
      serverTime: number;
      charter?: string;
      /** A resume token (ADR 087) delivered on first approval — persisted into `binding.grant`. */
      grant?: string;
      /** The seat's memory envelope (ADR 093) — headline + age + size, never the body; null when the
       *  seat has saved nothing. Rendered by `musterd claim` as the one-line continuity pointer. */
      memory: OccupiedFrame['memory'];
    }
  | { state: 'refused'; code: RefusedCode; message: string; claimable: string[]; hint: string }
  | { state: 'pending'; requestId: string; message: string };

/** Parse a server response frame (SPEC A.3) into the claim state machine's outcome. Validates
 *  through the landed schemas (ADR 078) so a malformed frame never reaches the command layer. Throws
 *  on an unknown frame type — the WS error frame (`type: 'error'`) is handled by the transport, not
 *  here; this function sees only `occupied`/`refused`/`pending`. */
export function parseClaimResponse(raw: unknown): ClaimOutcome {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('claim response is not an object');
  }
  const type = (raw as { type?: unknown }).type;
  if (type === 'occupied') {
    const f = OccupiedFrame.parse(raw);
    return {
      state: 'occupied',
      seat: f.seat,
      presenceId: f.presence_id,
      serverTime: f.server_time,
      ...(f.charter !== undefined ? { charter: f.charter } : {}),
      ...(f.grant !== undefined ? { grant: f.grant } : {}),
      memory: f.memory,
    };
  }
  if (type === 'refused') {
    const f = RefusedFrame.parse(raw);
    return {
      state: 'refused',
      code: f.code,
      message: f.message,
      claimable: f.claimable,
      hint: f.hint,
    };
  }
  if (type === 'pending') {
    const f = PendingFrame.parse(raw);
    return { state: 'pending', requestId: f.request_id, message: f.message };
  }
  throw new Error(`claim response type "${String(type)}" is not occupied/refused/pending`);
}
