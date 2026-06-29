import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { LifecycleSchema, MemberKindSchema } from './acts.js';
import {
  AdminAccountStatusSchema,
  type PartialCapabilities,
  PartialCapabilitiesSchema,
} from './capabilities.js';

/**
 * The durable seat-roster file format (ADR 058 + seat-file-format.md). A team's durable tier
 * materializes under `<workspace>/.musterd/` as a committed `team.toml` plus one
 * `seats/<name>.toml` per member — the surface a human or agent reads, diffs, and edits fluently.
 * The token never lands here; secrets stay daemon-side (`token_hash`) and in the gitignored
 * `binding.json` (see {@link BindingSchema}).
 *
 * This module is the *foundation layer*: the zod schemas (shared by the CLI writer and the daemon
 * parser so they can't drift) plus a **total, deterministic serializer**. Determinism is what makes
 * the two ADR 058 §3 guards well-posed — guard 1 (semantic round-trip) and guard 2 (`fmt`
 * byte-equality). See seat-file-format.md for the guard split.
 */

/** Team slug rule — mirrors `store/teams.ts SLUG_RE` (the durable file can't outrun the db's check). */
const SLUG_RE = /^[a-z0-9-]{1,32}$/;

/** Member-name rule — mirrors `store/members.ts` (no whitespace). The filename stem must satisfy it. */
const NAME_RE = /^\S+$/;

/** `team.toml` — one per workspace `.musterd/` (a workspace binds exactly one team). */
export const TeamFileSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'team slug must match [a-z0-9-]{1,32}'),
  display: z.string().optional(),
  lifecycle: LifecycleSchema.default('forever'),
});
export type TeamFile = z.infer<typeof TeamFileSchema>;

/**
 * `seats/<name>.toml` — one per member. The **filename stem is the name** and is not repeated in the
 * body; an optional `name` key, if present, must equal the stem (enforced by {@link parseSeatFile}).
 * `until` is human-legible ISO-8601 in the file; the daemon converts it to the `lifecycle_until`
 * epoch the schema stores.
 */
export const SeatFileSchema = z
  .object({
    kind: MemberKindSchema,
    role: z.string().default(''),
    lifecycle: LifecycleSchema.optional(),
    until: z.string().datetime({ offset: true }).optional(),
    name: z.string().optional(),
    /** Admin-set account status override (ADR 070). Only the durable, admin-controlled states live
     *  here; `provisioned`/`active` are derived from occupancy by the daemon, never written. */
    account_status: AdminAccountStatusSchema.optional(),
    /** Per-seat capability **narrowing** (ADR 070) — a partial that may only narrow the seat's role
     *  defaults, never widen (enforced by the daemon's projection via `clampNarrow`). */
    capabilities: PartialCapabilitiesSchema.optional(),
  })
  .refine((s) => s.lifecycle !== 'until' || Boolean(s.until), {
    message: 'lifecycle "until" requires an `until` timestamp',
  });
export type SeatFile = z.infer<typeof SeatFileSchema>;

/**
 * `roles/<name>.toml` — one per role (ADR 070). The filename stem is the role name (like seats); the
 * body carries the role's **default capabilities** (a partial — unset fields fall back to generalist)
 * and an optional charter. Role defaults are the ceiling a seat's per-seat capabilities narrow under.
 */
export const RoleFileSchema = z.object({
  capabilities: PartialCapabilitiesSchema.default({}),
  charter: z.string().optional(),
});
export type RoleFile = z.infer<typeof RoleFileSchema>;

// ---------------------------------------------------------------------------
// Parsing — TOML text → validated structure. Throws on malformed/invalid input; the daemon's
// reconcile catches per-file to stay fail-closed (seat-file-format.md), and the CLI validates
// before writing.
// ---------------------------------------------------------------------------

export function parseTeamFile(text: string): TeamFile {
  return TeamFileSchema.parse(parseToml(text));
}

/**
 * Parse a seat file, binding it to the name carried by its filename. A `name` key in the body must
 * match `name` (the stem) or this throws — one source of truth for the seat's identity.
 */
export function parseSeatFile(text: string, name: string): SeatFile & { name: string } {
  if (!NAME_RE.test(name)) {
    throw new Error(`seat name "${name}" is invalid (must not contain whitespace)`);
  }
  const seat = SeatFileSchema.parse(parseToml(text));
  if (seat.name !== undefined && seat.name !== name) {
    throw new Error(
      `seat file body name "${seat.name}" disagrees with its filename "${name}" — the filename is authoritative`,
    );
  }
  return { ...seat, name };
}

/** Extract the seat name (filename stem) from a `seats/<name>.toml` path. */
export function seatNameFromPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  return base.replace(/\.toml$/i, '');
}

/** Parse a `roles/<name>.toml`. The name is the filename stem (not in the body), like seat files. */
export function parseRoleFile(text: string): RoleFile {
  return RoleFileSchema.parse(parseToml(text));
}

// ---------------------------------------------------------------------------
// Serializing — structure → canonical TOML text. Total + deterministic: fixed key order, minimal
// emission, one style. This is the byte-exact form `musterd fmt` writes and `format:check` enforces
// (guard 2); it is also the serialize step in the semantic round-trip (guard 1).
// ---------------------------------------------------------------------------

/** Escape a string into a TOML basic (double-quoted) string. */
function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

function line(key: string, value: string): string {
  return `${key} = ${tomlString(value)}\n`;
}

function boolLine(key: string, value: boolean): string {
  return `${key} = ${value ? 'true' : 'false'}\n`;
}

function arrayLine(key: string, values: string[]): string {
  return `${key} = [${values.map(tomlString).join(', ')}]\n`;
}

/**
 * Canonical `[capabilities]` table body (shared by seat + role files). Fixed key order; only
 * **present** keys emitted (a partial), so an empty override produces no output and the caller omits
 * the header entirely. Booleans → `true|false`, scopes → quoted strings, declared lists → TOML arrays
 * (an explicit `[]` is preserved — it narrows to nothing). Deterministic, for the ADR 058 guards.
 */
function serializeCapabilities(caps: PartialCapabilities): string {
  let out = '';
  if (caps.is_admin !== undefined) out += boolLine('is_admin', caps.is_admin);
  if (caps.can_flag_urgent !== undefined) out += boolLine('can_flag_urgent', caps.can_flag_urgent);
  if (caps.can_observe !== undefined) out += boolLine('can_observe', caps.can_observe);
  if (caps.can_message !== undefined) out += line('can_message', caps.can_message);
  if (caps.visibility_level !== undefined) out += line('visibility_level', caps.visibility_level);
  if (caps.tool_allowlist !== undefined) out += arrayLine('tool_allowlist', caps.tool_allowlist);
  if (caps.declared_resource_scopes !== undefined)
    out += arrayLine('declared_resource_scopes', caps.declared_resource_scopes);
  return out;
}

/**
 * Canonical `team.toml`. Key order: `slug, display, lifecycle`. `display` is omitted when empty;
 * `lifecycle` is omitted when `forever` (the default) — so the common team is a one-line file.
 */
export function serializeTeam(team: TeamFile): string {
  let out = line('slug', team.slug);
  if (team.display) out += line('display', team.display);
  if (team.lifecycle && team.lifecycle !== 'forever') out += line('lifecycle', team.lifecycle);
  return out;
}

/**
 * Canonical `seats/<name>.toml`. Key order: `kind, role, lifecycle, until`. `kind` and `role` are
 * always emitted (role even when empty — one stable shape); `lifecycle` + `until` are emitted only
 * when `lifecycle !== "forever"`, so a forever seat stays a two-line file. The `name` is carried by
 * the filename and never written into the body.
 */
export function serializeSeat(seat: SeatFile): string {
  let out = line('kind', seat.kind);
  out += line('role', seat.role ?? '');
  if (seat.lifecycle && seat.lifecycle !== 'forever') {
    out += line('lifecycle', seat.lifecycle);
    if (seat.until) out += line('until', seat.until);
  }
  // Admin-set account status (top-level key — must precede any table). Omitted when unset (the common
  // active/provisioned case is derived, never written).
  if (seat.account_status) out += line('account_status', seat.account_status);
  // Per-seat capability narrowing as a trailing `[capabilities]` table (TOML requires tables after
  // top-level keys). Omitted entirely when the override is absent or empty (a known normalization).
  if (seat.capabilities) {
    const body = serializeCapabilities(seat.capabilities);
    if (body) out += `[capabilities]\n${body}`;
  }
  return out;
}

/**
 * Canonical `roles/<name>.toml`. Key order: `charter` (top-level) then the `[capabilities]` table.
 * An empty role (no charter, no caps) serializes to the empty string — the minimal form; the role
 * still exists by virtue of its filename.
 */
export function serializeRole(role: RoleFile): string {
  let out = '';
  if (role.charter) out += line('charter', role.charter);
  const body = serializeCapabilities(role.capabilities ?? {});
  if (body) out += `[capabilities]\n${body}`;
  return out;
}
