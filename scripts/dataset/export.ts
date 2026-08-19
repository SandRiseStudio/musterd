/**
 * The ADR 184 public dataset: structural fields only, from a corpus snapshot.
 *
 * WHY THIS EXISTS. ADR 184 opened the dataset gate with four checkable conditions. This script is
 * the export path (DoD 1–4): JSONL of acts / members / lanes with per-release HMAC seat names,
 * every prose body omitted, a pinned experiment manifest, and a human `--authorized-by` on the
 * specific release. It is not a HuggingFace upload and it is not `pnpm corpus:snapshot`.
 *
 * WHAT IT DOES NOT DO. It never reads `messages.body`, `seat_memory`, or `lanes.title`/`detail`.
 * Unknown meta keys are dropped (fail closed — omission, not a scrubber). Lane `branch` is omitted
 * (seat/`topic` refs re-identify the HMAC; merged pr/sha already ride allowlisted meta). `project`
 * tokens that match a seat name are HMAC'd. It uploads nothing. It refuses the live
 * `~/.musterd/musterd.db` unless `--from-live` (ADR 280: do not export from the only copy). A private
 * pseudonym map is written only under `--map`, and never inside `--out`.
 *
 *   pnpm dataset:export -- --db <snapshot.db> --out <dir> --authorized-by <human> \
 *                          [--manifest scripts/dataset/manifest.v1.json] [--map <private.json>]
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MANIFEST_PATH = 'scripts/dataset/manifest.v1.json';

const STRUCTURAL_META_KEYS = new Set([
  'model',
  'in_reply_to',
  'goal_id',
  'species',
  'tier',
  'ask_outcome',
  'ask_ref',
  'eligible',
  'blocked_by',
  'progress',
  'until',
  'defer_ref',
  'lane_id',
  'pr',
  'sha',
]);

export function pseudonym(memberId: string, salt: Buffer): string {
  return `seat_${createHmac('sha256', salt).update(memberId).digest('hex').slice(0, 12)}`;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isLiveDaemonDb(p: string): boolean {
  return resolve(p).replace(/\\/g, '/').endsWith('/.musterd/musterd.db');
}

export function bucketProject(
  project: string,
  names: Map<string, string>,
  ids: Map<string, string>,
): string {
  const byLower = new Map<string, string>();
  for (const [name, id] of names) byLower.set(name.toLowerCase(), id);
  return project.replace(/[A-Za-z0-9]+/g, (token) => {
    const id = byLower.get(token.toLowerCase());
    if (id === undefined) return token;
    return ids.get(id) ?? token;
  });
}

export function projectMeta(
  raw: unknown,
  names: Map<string, string>,
  ids: Map<string, string>,
): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!STRUCTURAL_META_KEYS.has(k)) continue;
    if (k === 'eligible' && Array.isArray(v)) {
      const seats: string[] = [];
      for (const n of v) {
        if (typeof n !== 'string') continue;
        const id = names.get(n);
        const pseudo = id !== undefined ? ids.get(id) : undefined;
        if (pseudo !== undefined) seats.push(pseudo);
      }
      if (seats.length > 0) out[k] = seats;
      continue;
    }
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function seatOfSalted(
  name: string | null | undefined,
  names: Map<string, string>,
  ids: Map<string, string>,
  salt: Buffer,
): string | null {
  if (name === null || name === undefined || name.length === 0) return null;
  const id = names.get(name);
  if (id !== undefined) return ids.get(id) ?? pseudonym(id, salt);
  return pseudonym(name, salt);
}

export interface ExportOptions {
  dbPath: string;
  outDir: string;
  manifestPath: string;
  authorizedBy: string;
  salt: Buffer;
  mapPath?: string;
}

export interface ExportResult {
  outDir: string;
  counts: { acts: number; members: number; lanes: number };
}

interface MemberRow {
  id: string;
  name: string;
  kind: string;
  role: string;
  team_slug: string;
}

interface MessageRow {
  id: string;
  team_slug: string;
  from_member: string;
  to_kind: string;
  to_member: string | null;
  act: string;
  thread_id: string | null;
  meta: string | null;
  ts: number;
}

interface LaneRow {
  id: string;
  team_slug: string;
  project: string;
  owner_seat: string | null;
  created_by: string;
  state: string;
  depends_on: string;
  goal_id: string | null;
  created_at: number;
  claimed_at: number | null;
  resolved_at: number | null;
  updated_at: number;
}

function writeJsonl(path: string, rows: unknown[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(path, rows.length > 0 ? `${body}\n` : '');
}

export function exportDataset(opts: ExportOptions): ExportResult {
  if (opts.authorizedBy.trim().length === 0) {
    throw new Error(
      'authorized_by is required (ADR 184 DoD 4: a human authorises the specific release)',
    );
  }
  if (opts.mapPath !== undefined && isInside(opts.mapPath, opts.outDir)) {
    throw new Error('mapPath must not be inside outDir — the pseudonym map is private');
  }

  const db = new DatabaseSync(opts.dbPath, { readOnly: true });
  const members = db
    .prepare(
      `SELECT m.id, m.name, m.kind, m.role, t.slug AS team_slug
         FROM members m JOIN teams t ON t.id = m.team_id`,
    )
    .all() as unknown as MemberRow[];
  const names = new Map(members.map((m) => [m.name, m.id]));
  const ids = new Map(members.map((m) => [m.id, pseudonym(m.id, opts.salt)]));

  const actsRaw = db
    .prepare(
      `SELECT msg.id, t.slug AS team_slug, msg.from_member, msg.to_kind, msg.to_member,
              msg.act, msg.thread_id, msg.meta, msg.ts
         FROM messages msg JOIN teams t ON t.id = msg.team_id`,
    )
    .all() as unknown as MessageRow[];
  const lanesRaw = db
    .prepare(
      `SELECT l.id, t.slug AS team_slug, l.project, l.owner_seat, l.created_by, l.state,
              l.depends_on, l.goal_id, l.created_at, l.claimed_at, l.resolved_at, l.updated_at
         FROM lanes l JOIN teams t ON t.id = l.team_id`,
    )
    .all() as unknown as LaneRow[];
  db.close();

  const memberRecords = members.map((m) => ({
    id: ids.get(m.id),
    kind: m.kind,
    role: m.role,
    team: m.team_slug,
  }));

  const actRecords = actsRaw.map((row) => {
    let parsed: unknown = null;
    if (row.meta !== null && row.meta.length > 0) {
      try {
        parsed = JSON.parse(row.meta) as unknown;
      } catch {
        parsed = null;
      }
    }
    const to =
      row.to_kind === 'member'
        ? {
            kind: 'member' as const,
            seat: row.to_member !== null ? (ids.get(row.to_member) ?? null) : null,
          }
        : { kind: row.to_kind };
    return {
      id: row.id,
      team: row.team_slug,
      from: ids.get(row.from_member) ?? pseudonym(row.from_member, opts.salt),
      to,
      act: row.act,
      thread: row.thread_id,
      meta: projectMeta(parsed, names, ids),
      ts: row.ts,
    };
  });

  const laneRecords = lanesRaw.map((row) => {
    let dependsOn: unknown = [];
    try {
      dependsOn = JSON.parse(row.depends_on) as unknown;
    } catch {
      dependsOn = [];
    }
    return {
      id: row.id,
      team: row.team_slug,
      project: bucketProject(row.project, names, ids),
      state: row.state,
      owner: seatOfSalted(row.owner_seat, names, ids, opts.salt),
      created_by: seatOfSalted(row.created_by, names, ids, opts.salt),
      goal_id: row.goal_id,
      depends_on: dependsOn,
      created_at: row.created_at,
      claimed_at: row.claimed_at,
      resolved_at: row.resolved_at,
      updated_at: row.updated_at,
    };
  });

  mkdirSync(opts.outDir, { recursive: true });
  writeJsonl(resolve(opts.outDir, 'acts.jsonl'), actRecords);
  writeJsonl(resolve(opts.outDir, 'members.jsonl'), memberRecords);
  writeJsonl(resolve(opts.outDir, 'lanes.jsonl'), laneRecords);

  const manifestSha = createHash('sha256').update(readFileSync(opts.manifestPath)).digest('hex');
  writeFileSync(
    resolve(opts.outDir, 'RELEASE.json'),
    `${JSON.stringify(
      {
        adr: 184,
        version: 'v1',
        kind: 'structural-only',
        authorized_by: opts.authorizedBy,
        authorized_at: new Date().toISOString(),
        salt_sha256: createHash('sha256').update(opts.salt).digest('hex'),
        experiment_manifest: { path: opts.manifestPath, sha256: manifestSha },
        counts: {
          acts: actRecords.length,
          members: memberRecords.length,
          lanes: laneRecords.length,
        },
        tool: 'scripts/dataset/export.ts',
        note: 'PUBLIC structural-only export (ADR 184). Prose bodies omitted. Not the private corpus snapshot.',
      },
      null,
      2,
    )}\n`,
  );

  if (opts.mapPath !== undefined) {
    const map: Record<string, string> = {};
    for (const m of members) {
      const pseudo = ids.get(m.id);
      if (pseudo !== undefined) map[m.name] = pseudo;
    }
    writeFileSync(opts.mapPath, `${JSON.stringify(map, null, 2)}\n`);
  }

  return {
    outDir: opts.outDir,
    counts: { acts: actRecords.length, members: memberRecords.length, lanes: laneRecords.length },
  };
}

export interface ParsedArgs {
  dbPath: string;
  outDir: string;
  manifestPath: string;
  authorizedBy: string;
  salt: Buffer;
  mapPath?: string;
  fromLive: boolean;
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  return argv[i + 1];
}

export function parseExportArgs(argv: string[]): ParsedArgs {
  const authorizedBy = flagValue(argv, '--authorized-by');
  if (authorizedBy === undefined || authorizedBy.length === 0) {
    throw new Error('--authorized-by is required (ADR 184 DoD 4)');
  }
  const dbPath = flagValue(argv, '--db');
  if (dbPath === undefined || dbPath.length === 0) {
    throw new Error(
      '--db is required (pass a corpus snapshot; do not default to the live daemon db)',
    );
  }
  const outDir = flagValue(argv, '--out');
  if (outDir === undefined || outDir.length === 0) {
    throw new Error('--out is required');
  }
  const manifestPath = flagValue(argv, '--manifest') ?? DEFAULT_MANIFEST_PATH;
  const fromLive = argv.includes('--from-live');
  if (isLiveDaemonDb(dbPath) && !fromLive) {
    throw new Error(
      'refusing the live ~/.musterd/musterd.db (ADR 280: do not export from the only copy). ' +
        'Pass a corpus snapshot, or --from-live if you mean it.',
    );
  }
  const mapPath = flagValue(argv, '--map');
  const parsed: ParsedArgs = {
    dbPath,
    outDir,
    manifestPath,
    authorizedBy,
    salt: randomBytes(32),
    fromLive,
  };
  if (mapPath !== undefined) parsed.mapPath = mapPath;
  return parsed;
}

function main(): void {
  const parsed = parseExportArgs(process.argv.slice(2));
  const result = exportDataset(parsed);
  console.log(
    `exported ${result.counts.acts} acts, ${result.counts.members} members, ${result.counts.lanes} lanes\n${result.outDir}`,
  );
  console.log(
    '\nThis is the PUBLIC structural-only export (ADR 184). It is still on this disk. ' +
      'pnpm corpus:snapshot is a different, PRIVATE artifact and must not be uploaded.',
  );
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === here) {
  main();
}
