/**
 * Reading the wire without a validator.
 *
 * The browser is the one consumer of this protocol that pays for its schemas by the byte: zod plus
 * the module-level `z.object(...)` graph is ~20 KB gzipped in the /live bundle, and the page's whole
 * relationship with the daemon is READ — same origin, member-authenticated, and validated on the
 * daemon's own ingest. So the read path gets these guards instead, and every value module the web
 * touches (`*.wire.ts`) is validator-free, which is what keeps zod out of the bundle at all.
 *
 * Two different jobs live here, and the difference is deliberate:
 *
 * 1. **{@link readMemberSummary} validates for real**, field by field, because something ACTS on the
 *    result: a row this build cannot read is counted into `unreadable` and the roster says so
 *    (ADR 148 forward-tolerance). A guard that waved rows through would make that count a lie.
 *    `guards.drift.test.ts` runs it and `MemberSummarySchema` over the same corpus and asserts they
 *    accept, reject, and normalize identically — so this cannot drift from the schema unnoticed.
 *
 * 2. **The response readers check the envelope of the response and nothing deeper.** `readLaneBoard`
 *    asserts "this is an object with a `lanes` array and a `warnings` array", fills the defaults an
 *    older daemon may omit, and hands the rows over. They do not re-derive the daemon's own field
 *    validation, because in the browser that check has no consumer: nothing branches on it, the page
 *    renders typed fields it either has or doesn't, and a strict parse of a response from a NEWER
 *    daemon is precisely the ADR 148 failure fetchRoster was rewritten to stop — an unreadable page
 *    instead of a calm hint. The write path is unaffected: the daemon still parses every envelope
 *    and every lane body with zod on ingest, which is the boundary that decides what becomes durable.
 */
import {
  ACTIVITIES_ON_WIRE,
  MEMBER_KINDS,
  PRESENCE_STATUSES,
  PROVENANCES,
  SURFACES,
  normalizeActivity,
  type Activity,
  type Lifecycle,
  type MemberKind,
  type PresenceStatus,
  type Provenance,
  type Surface,
} from './acts.wire.js';
import { LIFECYCLES } from './acts.wire.js';
import { ASK_SPECIES, ASK_TIERS, type AskSpecies, type AskTier } from './ask.wire.js';
import type { AuditResponse } from './audit.js';
import type { Capabilities } from './capabilities.js';
import { ACCOUNT_STATUSES, type AccountStatus } from './capabilities.wire.js';
import type { Report } from './insights.js';
import type { LaneBoard, LaneResult } from './lanes.js';
import type { Member, MemberSummary, Presence, Quiescence } from './member.js';
import { WAKEABILITIES, type Wakeability } from './model.js';
import { OFFLINE_REASONS, type OfflineReason } from './offline.wire.js';
import { POSTURES_ON_WIRE, normalizePosture, type Posture } from './posture.wire.js';
import type { Seed } from './seeds.js';
import { SEED_STATES } from './seeds.wire.js';
import {
  isClockTime,
  isIanaTimezone,
  isWorkingDayList,
  type WorkingHours,
} from './working-hours.wire.js';

/** Thrown when a response is not the shape its endpoint promises. Mirrors a zod parse failure. */
export class WireShapeError extends Error {
  constructor(what: string) {
    super(`invalid ${what} response`);
    this.name = 'WireShapeError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneOf<T extends readonly string[]>(tuple: T, v: unknown): T[number] | undefined {
  return typeof v === 'string' && (tuple as readonly string[]).includes(v)
    ? (v as T[number])
    : undefined;
}

/** `undefined` on absent, the value on a string, `null` on null — mirrors zod's `.nullish()`. */
function nullishString(v: unknown, min = 0): string | null | undefined | typeof FAIL {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string' || v.length < min) return FAIL;
  return v;
}

function nullishInt(
  v: unknown,
  opts: { min?: number; max?: number } = {},
): number | null | undefined | typeof FAIL {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) return FAIL;
  if (opts.min !== undefined && v < opts.min) return FAIL;
  if (opts.max !== undefined && v > opts.max) return FAIL;
  return v;
}

/** The sentinel a field helper returns when the value is present but unreadable. */
const FAIL = Symbol('unreadable');

function failed(v: unknown): v is typeof FAIL {
  return v === FAIL;
}

/** Drop keys whose value is `undefined`, so an absent optional stays absent (as zod leaves it). */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o)) {
    if ((o as Record<string, unknown>)[k] === undefined) delete (o as Record<string, unknown>)[k];
  }
  return o;
}

/** The ask's species (`meta.species`), or `undefined` when it is absent or not one we know. */
export function askSpeciesOf(v: unknown): AskSpecies | undefined {
  return oneOf(ASK_SPECIES, v);
}

/** The ask's tier (`meta.tier`), or `undefined` when it is absent or not one we know. */
export function askTierOf(v: unknown): AskTier | undefined {
  return oneOf(ASK_TIERS, v);
}

/**
 * A recurring schedule, or `null` when absent. Throws {@link WireShapeError} on a value that is
 * present but not a schedule — the same line `WorkingHoursSchema.nullish().parse` draws.
 */
export function readWorkingHours(v: unknown): WorkingHours | null {
  if (v === undefined || v === null) return null;
  if (!isRecord(v)) throw new WireShapeError('working_hours');
  const { timezone, days, start, end } = v;
  if (typeof timezone !== 'string' || timezone.length < 1 || !isIanaTimezone(timezone)) {
    throw new WireShapeError('working_hours');
  }
  if (!isWorkingDayList(days)) throw new WireShapeError('working_hours');
  if (!isClockTime(start) || !isClockTime(end) || !(start < end)) {
    throw new WireShapeError('working_hours');
  }
  return { timezone, days: [...days], start, end };
}

/** Same rules as {@link readWorkingHours}, but unreadable is a value, not a throw (row-level use). */
function memberWorkingHours(v: unknown): WorkingHours | null | undefined | typeof FAIL {
  if (v === undefined) return undefined;
  if (v === null) return null;
  try {
    return readWorkingHours(v);
  } catch {
    return FAIL;
  }
}

function readCapabilities(v: unknown): Capabilities | undefined | typeof FAIL {
  if (v === undefined) return undefined;
  if (!isRecord(v)) return FAIL;
  const can_message = oneOf(['team', 'none'] as const, v['can_message']);
  const visibility_level = oneOf(['admin', 'team'] as const, v['visibility_level']);
  const strings = (x: unknown): string[] | undefined =>
    Array.isArray(x) && x.every((s) => typeof s === 'string') ? (x as string[]) : undefined;
  const tool_allowlist = strings(v['tool_allowlist']);
  const declared_resource_scopes = strings(v['declared_resource_scopes']);
  if (
    typeof v['is_admin'] !== 'boolean' ||
    typeof v['can_flag_urgent'] !== 'boolean' ||
    typeof v['can_observe'] !== 'boolean' ||
    can_message === undefined ||
    visibility_level === undefined ||
    tool_allowlist === undefined ||
    declared_resource_scopes === undefined
  ) {
    return FAIL;
  }
  return {
    is_admin: v['is_admin'],
    can_flag_urgent: v['can_flag_urgent'],
    can_observe: v['can_observe'],
    can_message,
    visibility_level,
    tool_allowlist: [...tool_allowlist],
    declared_resource_scopes: [...declared_resource_scopes],
  };
}

function readAvailability(v: unknown): Member['availability'] | typeof FAIL {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isRecord(v)) return FAIL;
  const status = oneOf(['available', 'away', 'dnd', 'off_hours'] as const, v['status']);
  if (status === undefined) return FAIL;
  const until = nullishInt(v['until'], { min: 1 });
  if (failed(until)) return FAIL;
  return compact({ status, until });
}

function readPresence(v: unknown): Presence | typeof FAIL {
  if (!isRecord(v)) return FAIL;
  const surface = oneOf(SURFACES, v['surface']);
  const status = oneOf(PRESENCE_STATUSES, v['status']);
  const last_seen_at = v['last_seen_at'];
  if (surface === undefined || status === undefined || !Number.isInteger(last_seen_at)) return FAIL;
  const provenance =
    v['provenance'] === undefined || v['provenance'] === null
      ? (v['provenance'] as null | undefined)
      : (oneOf(PROVENANCES, v['provenance']) ?? FAIL);
  const workspace = nullishString(v['workspace']);
  const driver = nullishString(v['driver']);
  const model = nullishString(v['model']);
  const build = nullishString(v['build']);
  const epoch = nullishInt(v['epoch'], { min: 0 });
  const wake_lease = nullishString(v['wake_lease']);
  const node = nullishString(v['node']);
  const node_label = nullishString(v['node_label']);
  if (
    failed(provenance) ||
    failed(workspace) ||
    failed(driver) ||
    failed(model) ||
    failed(build) ||
    failed(epoch) ||
    failed(wake_lease) ||
    failed(node) ||
    failed(node_label)
  ) {
    return FAIL;
  }
  return compact({
    surface: surface as Surface,
    status: status as PresenceStatus,
    last_seen_at: last_seen_at as number,
    provenance: provenance as Provenance | null | undefined,
    workspace,
    driver,
    model,
    build,
    epoch,
    wake_lease,
    node,
    node_label,
  });
}

function readQuiescence(v: unknown): Quiescence | undefined | typeof FAIL {
  if (v === undefined) return undefined;
  if (!isRecord(v)) return FAIL;
  const state = oneOf(['busy', 'quiet', 'unknown'] as const, v['state']);
  const source = oneOf(['audit', 'harness'] as const, v['source']);
  const quiet = v['quiet_for_ms'];
  if (state === undefined || source === undefined) return FAIL;
  if (quiet !== null && !Number.isInteger(quiet)) return FAIL;
  return { state, quiet_for_ms: quiet as number | null, source };
}

/**
 * One roster row, or `null` when this build cannot read it — the caller counts those into
 * `unreadable` and the roster renders the ADR 148 "behind" hint. Every closed set is checked
 * against the tuple it was built from, so a value that landed in the daemon after this bundle
 * (ADR 232's `kind: 'service'` was the real one) is a rejected ROW, never a thrown page.
 */
export function readMemberSummary(row: unknown): MemberSummary | null {
  if (!isRecord(row)) return null;
  const kind = oneOf(MEMBER_KINDS, row['kind']);
  const presence = oneOf(PRESENCE_STATUSES, row['presence']);
  if (
    typeof row['id'] !== 'string' ||
    typeof row['team'] !== 'string' ||
    typeof row['name'] !== 'string' ||
    !Number.isInteger(row['created_at']) ||
    kind === undefined ||
    presence === undefined
  ) {
    return null;
  }

  const role = row['role'] === undefined ? '' : row['role'];
  if (typeof role !== 'string') return null;

  const rolesRaw = row['roles'] === undefined ? [] : row['roles'];
  if (!Array.isArray(rolesRaw) || !rolesRaw.every((r) => typeof r === 'string')) return null;

  const lifecycle =
    row['lifecycle'] === undefined ? 'forever' : oneOf(LIFECYCLES, row['lifecycle']);
  if (lifecycle === undefined) return null;

  const presencesRaw = row['presences'] === undefined ? [] : row['presences'];
  if (!Array.isArray(presencesRaw)) return null;
  const presences: Presence[] = [];
  for (const p of presencesRaw) {
    const parsed = readPresence(p);
    if (failed(parsed)) return null;
    presences.push(parsed);
  }

  const lifecycle_until = nullishInt(row['lifecycle_until']);
  const availability = readAvailability(row['availability']);
  const working_hours = memberWorkingHours(row['working_hours']);
  const slack_user_id = nullishString(row['slack_user_id'], 1);
  const hue = nullishInt(row['hue'], { min: 0, max: 359 });
  const capabilities = readCapabilities(row['capabilities']);
  const state = nullishString(row['state']);
  const last_status_at = nullishInt(row['last_status_at']);
  const resumable_at = nullishInt(row['resumable_at']);
  const quiescence = readQuiescence(row['quiescence']);
  if (
    failed(lifecycle_until) ||
    failed(availability) ||
    failed(working_hours) ||
    failed(slack_user_id) ||
    failed(hue) ||
    failed(capabilities) ||
    failed(state) ||
    failed(last_status_at) ||
    failed(resumable_at) ||
    failed(quiescence)
  ) {
    return null;
  }

  const optionalEnum = <T extends readonly string[]>(
    tuple: T,
    v: unknown,
  ): T[number] | undefined | typeof FAIL =>
    v === undefined ? undefined : (oneOf(tuple, v) ?? FAIL);

  const account_status = optionalEnum(ACCOUNT_STATUSES, row['account_status']);
  const activityRaw = optionalEnum(ACTIVITIES_ON_WIRE, row['activity']);
  const postureRaw = optionalEnum(POSTURES_ON_WIRE, row['posture']);
  const wakeability = optionalEnum(WAKEABILITIES, row['wakeability']);
  const offline_reason =
    row['offline_reason'] === undefined || row['offline_reason'] === null
      ? (row['offline_reason'] as null | undefined)
      : (oneOf(OFFLINE_REASONS, row['offline_reason']) ?? FAIL);
  if (
    failed(account_status) ||
    failed(activityRaw) ||
    failed(postureRaw) ||
    failed(wakeability) ||
    failed(offline_reason)
  ) {
    return null;
  }

  const optionalBool = (v: unknown): boolean | undefined | typeof FAIL =>
    v === undefined ? undefined : typeof v === 'boolean' ? v : FAIL;
  const reclaimable = optionalBool(row['reclaimable']);
  const wakeable = optionalBool(row['wakeable']);
  if (failed(reclaimable) || failed(wakeable)) return null;

  return compact({
    id: row['id'],
    team: row['team'],
    name: row['name'],
    kind: kind as MemberKind,
    role,
    roles: [...(rolesRaw as string[])],
    lifecycle: lifecycle as Lifecycle,
    lifecycle_until,
    availability,
    working_hours,
    slack_user_id,
    hue,
    account_status: account_status as AccountStatus | undefined,
    capabilities,
    created_at: row['created_at'] as number,
    presence: presence as PresenceStatus,
    presences,
    activity: (activityRaw === undefined ? undefined : normalizeActivity(activityRaw)) as
      | Activity
      | undefined,
    state,
    last_status_at,
    posture: (postureRaw === undefined ? undefined : normalizePosture(postureRaw)) as
      | Posture
      | undefined,
    offline_reason: offline_reason as OfflineReason | null | undefined,
    reclaimable,
    wakeable,
    wakeability: wakeability as Wakeability | undefined,
    resumable_at,
    quiescence,
  }) as MemberSummary;
}

/** `{ lanes, warnings }` from `GET /teams/:slug/lanes`, with an older daemon's omissions filled. */
export function readLaneBoard(json: unknown): LaneBoard {
  if (!isRecord(json) || !Array.isArray(json['lanes']) || !Array.isArray(json['warnings'])) {
    throw new WireShapeError('lane board');
  }
  return {
    lanes: json['lanes'].map(withLaneDefaults),
    warnings: json['warnings'],
  } as LaneBoard;
}

/** `{ lane, warnings, review?, notices? }` — every mutating lane verb's echo. */
export function readLaneResult(json: unknown): LaneResult {
  if (!isRecord(json) || !isRecord(json['lane']) || !Array.isArray(json['warnings'])) {
    throw new WireShapeError('lane result');
  }
  return compact({
    lane: withLaneDefaults(json['lane']),
    warnings: json['warnings'],
    review: json['review'],
    notices: json['notices'],
  }) as LaneResult;
}

/**
 * The four lane fields a daemon older than this bundle may omit (ADR 148 skew tolerance) — the
 * defaults `LaneSchema` carries, applied here so a board row is complete however old its writer is.
 */
function withLaneDefaults(lane: unknown): unknown {
  if (!isRecord(lane)) throw new WireShapeError('lane');
  return {
    ...lane,
    risk: Array.isArray(lane['risk']) ? lane['risk'] : [],
    stakes: lane['stakes'] ?? 'normal',
    stakes_provenance: lane['stakes_provenance'] ?? 'declared',
    merged: lane['merged'] === undefined ? null : lane['merged'],
  };
}

/** `{ audit }` from `GET /teams/:slug/audit`. */
export function readAuditResponse(json: unknown): AuditResponse {
  if (!isRecord(json) || !Array.isArray(json['audit'])) throw new WireShapeError('audit');
  return { audit: json['audit'] } as AuditResponse;
}

/**
 * `{ seeds }` from `GET /teams/:slug/seeds`, refusing a body whose rows are not Seeds.
 *
 * The tray is the one read surface that has always declined to trust the daemon's body wholesale
 * (`client.test.ts`: "rejects a malformed Seed instead of trusting the daemon body"), so this reader
 * checks every required field rather than only the envelope. It stops at the row: `thread`,
 * `final_brief` and `promotion` are checked for their container shape and not descended into, which
 * is the same line the other response readers draw.
 *
 * `source` is checked as a non-empty string, NOT against a closed set. The set is widening (ADR 373
 * inc 2 adds `repo` beside `slack`), and a browser that rejected a source its daemon had just
 * learned would be the ADR 148 failure in miniature.
 */
export function readSeedList(json: unknown): Seed[] {
  if (!isRecord(json) || !Array.isArray(json['seeds'])) throw new WireShapeError('seed list');
  for (const seed of json['seeds']) {
    if (!isSeed(seed)) throw new WireShapeError('seed');
  }
  return json['seeds'] as Seed[];
}

function isSeed(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const str = (k: string): boolean => typeof v[k] === 'string' && (v[k] as string).length > 0;
  const nullableStr = (k: string): boolean => v[k] === null || str(k);
  const int = (k: string): boolean => Number.isInteger(v[k]) && (v[k] as number) >= 0;
  const nullableInt = (k: string): boolean => v[k] === null || int(k);
  return (
    str('id') &&
    str('team') &&
    str('relay_id') &&
    str('source') &&
    typeof v['body'] === 'string' &&
    int('captured_at') &&
    str('slack_user_id') &&
    str('submitted_by') &&
    oneOf(SEED_STATES, v['state']) !== undefined &&
    nullableStr('explorer') &&
    Array.isArray(v['thread']) &&
    (v['final_brief'] === null || isRecord(v['final_brief'])) &&
    (v['conclusion'] === null || typeof v['conclusion'] === 'string') &&
    nullableStr('linked_lane_id') &&
    (v['promotion'] === null || isRecord(v['promotion'])) &&
    nullableInt('completed_at') &&
    int('created_at') &&
    int('updated_at')
  );
}

/** The team report from `GET /teams/:slug/report`. */
export function readReport(json: unknown): Report {
  if (
    !isRecord(json) ||
    typeof json['team'] !== 'string' ||
    !Array.isArray(json['goals']) ||
    !Array.isArray(json['blocked'])
  ) {
    throw new WireShapeError('report');
  }
  return json as unknown as Report;
}
