import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { LifecycleSchema, MemberKindSchema } from './acts.js';
import {
  AdminAccountStatusSchema,
  type PartialCapabilities,
  PartialCapabilitiesSchema,
} from './capabilities.js';
import { WorkingHoursSchema } from './working-hours.js';

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
  working_hours: WorkingHoursSchema.optional(),
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
    /** Multi-role (ADR 227): every role this seat holds, validated against `roles/*.toml` by the
     *  daemon's reconcile (unknown names warn, never drop the seat). Absent on the common single-role
     *  file — `role` alone reads as a one-entry list ({@link seatRoles}). When present it is
     *  authoritative and `role` normalizes to its first entry (the display label). */
    roles: z.array(z.string()).optional(),
    lifecycle: LifecycleSchema.optional(),
    until: z.string().datetime({ offset: true }).optional(),
    name: z.string().optional(),
    /** Admin-set account status override (ADR 070). Only the durable, admin-controlled states live
     *  here; `provisioned`/`active` are derived from occupancy by the daemon, never written. */
    account_status: AdminAccountStatusSchema.optional(),
    /** Per-seat capability **narrowing** (ADR 070) — a partial that may only narrow the seat's role
     *  defaults, never widen (enforced by the daemon's projection via `clampNarrow`). */
    capabilities: PartialCapabilitiesSchema.optional(),
    working_hours: WorkingHoursSchema.optional(),
    /** ADR 311: Slack identity join for human-submitted Seeds; never valid on an agent seat. */
    slack_user_id: z.string().min(1).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.slack_user_id !== undefined && s.kind !== 'human') {
      ctx.addIssue({ code: 'custom', message: '`slack_user_id` is valid only on a human seat' });
    }
    if (s.lifecycle === 'until' && !s.until) {
      ctx.addIssue({ code: 'custom', message: 'lifecycle "until" requires an `until` timestamp' });
    }
  });
export type SeatFile = z.infer<typeof SeatFileSchema>;

/**
 * `roles/<name>.toml` — one per role (ADR 070). The filename stem is the role name (like seats); the
 * body carries the role's **default capabilities** (a partial — unset fields fall back to generalist)
 * and an optional charter. Role defaults are the ceiling a seat's per-seat capabilities narrow under.
 */
export const RoleFileSchema = z.object({
  /** One-line summary the roster surfaces (ADR 227) — the discoverable face of the role; the full
   *  `charter` stays prose for humans and primers. Optional on parse for pre-227 files. */
  summary: z.string().optional(),
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
  // Multi-role normalization (ADR 227): when `roles` is present it is authoritative and `role`
  // becomes its first entry — hand-edit tolerance, so a stale `role` line never disagrees silently.
  if (seat.roles !== undefined) {
    return { ...seat, role: seat.roles[0] ?? '', name };
  }
  return { ...seat, name };
}

/**
 * The one list of roles a seat holds (ADR 227), normalized across the two file shapes: a `roles`
 * array when present, else the legacy single `role` string as a one-entry list (empty ⇒ none —
 * the roleless generalist).
 */
export function seatRoles(seat: Pick<SeatFile, 'role' | 'roles'>): string[] {
  if (seat.roles !== undefined) return seat.roles;
  return seat.role ? [seat.role] : [];
}

/** Extract the seat name (filename stem) from a `seats/<name>.toml` path. */
export function seatNameFromPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  return base.replace(/\.toml$/i, '');
}

/**
 * The canonical, casing-invariant form of a seat name — the **stable identity key for aggregation**
 * (issue #107). A seat's durable identity is its name (ADR 058: the `seats/<name>.toml` filename stem
 * is the one source of truth; there is no rename and no cross-daemon uuid — the member row id re-mints
 * on reset), so any per-agent analytic that keys on the raw display name fragments the moment it
 * aggregates across teams, resets, or naming-convention drift (`Miley` on one team vs `miley` on
 * another — the same actor, double-counted). Normalizing to NFC + trimmed + lower-case collapses that
 * fragmentation. Used as the identity dimension on telemetry (`musterd.from.id` / `musterd.member.id`)
 * while the raw name stays a secondary human label. Not the display form — never render this to a user.
 */
export function normalizeSeatName(name: string): string {
  return name.normalize('NFC').trim().toLowerCase();
}

/**
 * Top-level keys a roster file carries that its schema does not know — the keys zod's default
 * `.strip()` silently discards on parse, and that `musterd fmt` therefore **deletes** when it
 * rewrites the file from the parsed value.
 *
 * WHY THIS EXISTS AS A SEPARATE ANSWER. `fmt --check` compares bytes, so it reports "not canonical"
 * identically for a stray blank line and for a paragraph about to be erased. Those are not the same
 * finding and must not read the same: one is cosmetic, the other is data loss. Measured instance —
 * `seats/autorefresh.toml` on the live roster carries an authored 587-character `charter`, `charter`
 * is in RoleFileSchema but NOT SeatFileSchema, and `fmt` drops it without a word (2026-08-21,
 * falsified into existence by ryder from a claim of mine that said the hazard was latent).
 *
 * Reports only what is CURRENTLY unknown. A key that a future schema adopts stops being reported the
 * moment it is in the shape — the list is derived from the schema, never a hand-kept denylist that
 * could itself go stale.
 *
 * Malformed TOML returns `[]` rather than throwing: an unparseable file is the PARSER's error to
 * report, and this answering "no unknown keys" for it would be a lie only if anyone read it as
 * "this file is fine". Callers run it beside a parse, never instead of one.
 */
export function unknownRosterKeys(kind: 'team' | 'seat' | 'role', text: string): string[] {
  // SeatFileSchema is a ZodEffects (it carries a `.refine`), so its object shape lives one level in.
  // Reaching through `innerType()` rather than duplicating the key list keeps this derived from the
  // schema — a hand-kept copy is precisely the stale proxy this function exists to catch.
  const shape =
    kind === 'team'
      ? TeamFileSchema.shape
      : kind === 'seat'
        ? SeatFileSchema.innerType().shape
        : RoleFileSchema.shape;
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const known = new Set(Object.keys(shape));
  return Object.keys(raw as Record<string, unknown>)
    .filter((k) => !known.has(k))
    .sort();
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
 * A table header, under one blank line when anything precedes it. Canonical form is the form
 * hand-authors write: measured 2026-08-24, three independent authors put a blank line before the
 * header on the live roster and none preferred flush, and a `fmt --check` that fails on every
 * hand-edit teaches people to ignore it. A table that opens the file gets no leading blank.
 */
function tableHeader(name: string, precededBy: string): string {
  return `${precededBy ? '\n' : ''}[${name}]\n`;
}

function serializeWorkingHours(
  value: NonNullable<SeatFile['working_hours']>,
  precededBy: string,
): string {
  return (
    tableHeader('working_hours', precededBy) +
    `timezone = ${tomlString(value.timezone)}\n` +
    `days = [${value.days.map(tomlString).join(', ')}]\n` +
    `start = ${tomlString(value.start)}\n` +
    `end = ${tomlString(value.end)}\n`
  );
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
  if (team.working_hours) out += serializeWorkingHours(team.working_hours, out);
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
  // Multi-role (ADR 227): `role` stays the always-present display label (first role) so pre-227
  // parsers keep working; the `roles` array is emitted only when it says more than `role` does
  // (≥2 entries), so the common single-role file is byte-identical to its pre-227 form.
  const roles = seatRoles(seat);
  out += line('role', roles[0] ?? '');
  if (roles.length >= 2) out += arrayLine('roles', roles);
  if (seat.lifecycle && seat.lifecycle !== 'forever') {
    out += line('lifecycle', seat.lifecycle);
    if (seat.until) out += line('until', seat.until);
  }
  // Admin-set account status (top-level key — must precede any table). Omitted when unset (the common
  // active/provisioned case is derived, never written).
  if (seat.account_status) out += line('account_status', seat.account_status);
  if (seat.slack_user_id) out += line('slack_user_id', seat.slack_user_id);
  if (seat.working_hours) out += serializeWorkingHours(seat.working_hours, out);
  // Per-seat capability narrowing as a trailing `[capabilities]` table (TOML requires tables after
  // top-level keys). Omitted entirely when the override is absent or empty (a known normalization).
  if (seat.capabilities) {
    const body = serializeCapabilities(seat.capabilities);
    if (body) out += tableHeader('capabilities', out) + body;
  }
  return out;
}

/**
 * Canonical `roles/<name>.toml`. Key order: `summary`, `charter` (top-level) then the
 * `[capabilities]` table.
 * An empty role (no charter, no caps) serializes to the empty string — the minimal form; the role
 * still exists by virtue of its filename.
 */
export function serializeRole(role: RoleFile): string {
  let out = '';
  if (role.summary) out += line('summary', role.summary);
  if (role.charter) out += line('charter', role.charter);
  const body = serializeCapabilities(role.capabilities ?? {});
  if (body) out += tableHeader('capabilities', out) + body;
  return out;
}
