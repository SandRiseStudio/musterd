/**
 * The research corpus, captured whole, small enough to keep forever.
 *
 * WHY THIS EXISTS. Findings 001–008 and every number in them are derived from data that lives in
 * exactly one place: `~/.musterd` on nick's laptop, plus `~/cookoff-run`. Nothing is committed —
 * `git ls-files` returns no `.db`, `.jsonl`, or `.ndjson` anywhere in this repo — and the newest
 * DB backup in `~/.musterd/backups/` is dated 2026-06-29, which predates the entire flagship
 * cookoff, every wake-pricing row, and ADRs 250 through 279. A disk failure takes the evidence base
 * for a research programme whose stated first artifact is a published dataset (ADR 056, ADR 184).
 *
 * WHAT MAKES IT CHEAP, and the measurement that decided the design. The corpus reads as ~4.3 GB and
 * therefore as somebody else's problem. It is not:
 *
 *   ~/cookoff-run                  4.2 GB   of which 28 git clones at ~50 MB each — REPRODUCIBLE
 *                                           from the `cookoff-scenario` fixture repo
 *   ~/cookoff-run/*.db              3.8 MB   19 per-cell daemon DBs — IRREPLACEABLE
 *   ~/.musterd/musterd.db          15.9 MB   the coordination corpus — IRREPLACEABLE
 *   adr-166-slot-sweep.jsonl       48.3 MB   -> 610 KB gzipped (79x; measured 2026-08-17)
 *   otel-sink.log + .log.1         12.6 MB   the capture behind findings 002 and 005
 *   daemon.log + .log.1            13.1 MB   the ADR 082 slice-2 structured HTTP log
 *
 * So the part that cannot be regenerated is ~95 MB raw and a few MB compressed, and the part that
 * looks expensive is chaff. A snapshot that skips the clones and gzips the rest is small enough to
 * keep every one, forever, which is why this script does not implement retention or pruning.
 *
 * WHAT IT DOES NOT DO. It writes a portable, checksummed directory and stops. It uploads nothing:
 * where the off-machine copy lands is nick's call (ADR 280 §4), and a script that silently ships a
 * corpus containing agent prose to a remote is exactly the move ADR 184 exists to prevent. This is
 * the PRIVATE raw corpus — the public, redacted, structural-only dataset is a different artifact
 * built by a different lane.
 *
 * SAFETY ON THIS MACHINE. The laptop lives in swap (`docs/wiki/nicks-laptop.md`: 8 GB, measured at
 * 551 MB free swap while this was being written). Copying ~95 MB and gzipping it is not heavy, but
 * the rule there is standing and applies to anything scheduled, so the run aborts below a free-swap
 * floor rather than being the process that finally tips it.
 *
 *   node --disable-warning=ExperimentalWarning scripts/corpus/snapshot.ts [--out <dir>] [--json]
 *                                                                        [--dry-run] [--force]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

/** Below this, refuse to run. `docs/wiki/nicks-laptop.md` — the standing rule for any scheduled or
 *  many-file run on this machine. `--force` overrides for an operator watching it happen. */
const MIN_FREE_SWAP_MB = 500;

type SourceKind = 'sqlite' | 'file' | 'glob-dir';

interface Source {
  /** Stable key in the manifest — restore reads this, not the filename. */
  id: string;
  kind: SourceKind;
  /** Absolute path, or for `glob-dir` the directory whose immediate `*.db` children are captured. */
  path: string;
  /** Why this is irreplaceable. Copied into the manifest so a future reader of a bare archive
   *  directory knows what they are holding without this file. */
  why: string;
  /** Missing is normal, not an error (a machine without cookoff results is still snapshottable). */
  optional?: boolean;
}

export function defaultSources(home = homedir()): Source[] {
  const m = join(home, '.musterd');
  return [
    {
      id: 'musterd.db',
      kind: 'sqlite',
      path: join(m, 'musterd.db'),
      why: 'The coordination corpus: messages/acts, audit (incl. model attestation), lanes, seat_memory, residency, wake_leases, wake_turns, tool_call_stats, footprint.',
    },
    {
      id: 'slot-sweep.jsonl',
      kind: 'file',
      path: join(m, 'research', 'adr-166-slot-sweep.jsonl'),
      why: 'ADR 166 fleet liveness series, appended every 5 min by launchd since 2026-07-27. Append-only; the demoted rows are the finding.',
    },
    {
      id: 'sweep.log',
      kind: 'file',
      path: join(m, 'research', 'sweep.log'),
      why: 'ADR 166 sweep findings log — empty is the healthy result, so its emptiness is itself a claim.',
      optional: true,
    },
    {
      id: 'clear-experiment.md',
      kind: 'file',
      path: join(m, 'research', 'clear-experiment.md'),
      why: 'Pre-registered /clear session-id experiment (BEFORE snapshot + verdict rule). Has no home in docs/research/ yet.',
      optional: true,
    },
    {
      id: 'otel-sink.log',
      kind: 'file',
      path: join(m, 'otel-sink.log'),
      why: 'OTLP metric/span capture (ADR 082 slice 1) — the source behind findings 002 and 005.',
      optional: true,
    },
    {
      id: 'otel-sink.log.1',
      kind: 'file',
      path: join(m, 'otel-sink.log.1'),
      why: 'Rotated OTLP capture. Rotation is destructive: .log.2 does not exist, so an unsnapshotted rotation is a permanent loss.',
      optional: true,
    },
    {
      id: 'daemon.log',
      kind: 'file',
      path: join(m, 'daemon.log'),
      why: 'Structured http_request log (ADR 082 slice 2).',
      optional: true,
    },
    {
      id: 'daemon.log.1',
      kind: 'file',
      path: join(m, 'daemon.log.1'),
      why: 'Rotated structured HTTP log.',
      optional: true,
    },
    {
      id: 'cookoff-daemons',
      kind: 'glob-dir',
      path: join(home, 'cookoff-run'),
      why: 'Per-cell cookoff daemon DBs — the raw results behind findings 006 and 007. The ~4.2 GB of sibling git clones is NOT captured: those regenerate from the cookoff-scenario fixture repo.',
      optional: true,
    },
  ];
}

/** LaunchAgents are the measurement *schedule* — which instruments were running, at what cadence,
 *  when a sample was taken. `docs/dogfood-telemetry.md` calls them machine-local and uncommitted,
 *  which is exactly why a corpus without them cannot be interpreted later. */
export function launchAgentSources(home = homedir()): Source[] {
  const dir = join(home, 'Library', 'LaunchAgents');
  return [
    'studio.sandrise.musterd.plist',
    'studio.sandrise.musterd-sweep.plist',
    'studio.sandrise.musterd-otel-sink.plist',
    'studio.sandrise.musterd-host.plist',
    'studio.sandrise.musterd-autorefresh.plist',
    'studio.sandrise.musterd-guardian.plist',
    'studio.sandrise.musterd-live.plist',
  ].map((f) => ({
    id: `launchagent/${f}`,
    kind: 'file' as const,
    path: join(dir, f),
    why: 'The measurement schedule itself — which instrument ran, how often.',
    optional: true,
  }));
}

/** `vm.swapusage: total = 5120.00M  used = 4568.44M  free = 551.56M  (encrypted)` */
export function parseFreeSwapMb(sysctlOutput: string): number | null {
  const m = /free\s*=\s*([\d.]+)M/.exec(sysctlOutput);
  return m?.[1] === undefined ? null : Number(m[1]);
}

export function freeSwapMb(): number | null {
  try {
    return parseFreeSwapMb(execFileSync('sysctl', ['vm.swapusage'], { encoding: 'utf8' }));
  } catch {
    // Not macOS, or sysctl is missing. Absence of the guard is not a reason to refuse — the guard
    // exists for one known machine, and silence elsewhere means the constraint does not apply.
    return null;
  }
}

export interface PlannedItem {
  id: string;
  kind: SourceKind;
  source: string;
  bytes: number;
  why: string;
}

/** Pure: decide what a run would capture, given a way to stat. Separated from doing it so the plan
 *  is testable without a filesystem full of a real corpus. */
export function planSnapshot(
  sources: Source[],
  stat: (p: string) => { bytes: number } | null,
  listDbs: (dir: string) => string[],
): { items: PlannedItem[]; missing: string[] } {
  const items: PlannedItem[] = [];
  const missing: string[] = [];

  for (const s of sources) {
    if (s.kind === 'glob-dir') {
      const children = listDbs(s.path);
      if (children.length === 0) {
        if (!s.optional) missing.push(s.path);
        continue;
      }
      for (const child of children) {
        const st = stat(child);
        if (st === null) continue;
        items.push({
          id: `${s.id}/${basename(child)}`,
          kind: 'sqlite',
          source: child,
          bytes: st.bytes,
          why: s.why,
        });
      }
      continue;
    }

    const st = stat(s.path);
    if (st === null) {
      if (!s.optional) missing.push(s.path);
      continue;
    }
    items.push({ id: s.id, kind: s.kind, source: s.path, bytes: st.bytes, why: s.why });
  }

  return { items, missing };
}

function statBytes(p: string): { bytes: number } | null {
  try {
    const st = statSync(p);
    return st.isFile() ? { bytes: st.size } : null;
  } catch {
    return null;
  }
}

function listRootDbs(dir: string): string[] {
  try {
    return execFileSync('find', [dir, '-maxdepth', '1', '-name', '*.db'], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.length > 0)
      .sort();
  } catch {
    return [];
  }
}

async function gzipTo(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(dest));
}

async function sha256(p: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(p), hash);
  return hash.digest('hex');
}

/**
 * A live SQLite database with a hot WAL cannot be captured by copying the file — the copy lands
 * mid-transaction and the WAL it needs is a separate, still-moving file. `VACUUM INTO` asks SQLite
 * for a consistent point-in-time image of the whole database in one statement, from a reader's
 * snapshot, without stopping the daemon or checkpointing anything under it.
 */
function vacuumInto(src: string, dest: string): void {
  execFileSync('sqlite3', [src, `VACUUM INTO '${dest.replace(/'/g, "''")}'`], { stdio: 'pipe' });
}

export interface SnapshotEntry extends PlannedItem {
  artifact: string;
  artifactBytes: number;
  sha256: string;
}

export async function runSnapshot(
  outRoot: string,
  sources: Source[],
): Promise<{
  dir: string;
  entries: SnapshotEntry[];
  rawBytes: number;
  storedBytes: number;
}> {
  const { items, missing } = planSnapshot(sources, statBytes, listRootDbs);
  if (missing.length > 0) throw new Error(`required source missing: ${missing.join(', ')}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(outRoot, stamp);
  mkdirSync(dir, { recursive: true });

  const entries: SnapshotEntry[] = [];
  for (const item of items) {
    const flat = item.id.replace(/\//g, '_');
    if (item.kind === 'sqlite') {
      // Snapshot first, then compress the snapshot — a VACUUMed DB is already compact, and gzipping
      // it costs nothing next to the copy.
      const staged = join(dir, `${flat}.snapshot`);
      vacuumInto(item.source, staged);
      const artifact = `${flat}.db.gz`;
      await gzipTo(staged, join(dir, artifact));
      execFileSync('rm', ['-f', staged]);
      entries.push({
        ...item,
        artifact,
        artifactBytes: statSync(join(dir, artifact)).size,
        sha256: await sha256(join(dir, artifact)),
      });
      continue;
    }
    const artifact = `${flat}.gz`;
    await gzipTo(item.source, join(dir, artifact));
    entries.push({
      ...item,
      artifact,
      artifactBytes: statSync(join(dir, artifact)).size,
      sha256: await sha256(join(dir, artifact)),
    });
  }

  const rawBytes = entries.reduce((n, e) => n + e.bytes, 0);
  const storedBytes = entries.reduce((n, e) => n + e.artifactBytes, 0);

  writeFileSync(
    join(dir, 'MANIFEST.json'),
    `${JSON.stringify(
      {
        taken_at: new Date().toISOString(),
        host: process.env['HOST'] ?? 'nicks-laptop',
        tool: 'scripts/corpus/snapshot.ts',
        adr: 280,
        note: 'PRIVATE raw research corpus. Contains agent prose and is NOT the ADR 184 public dataset. Restore: gunzip the artifact; sqlite entries restore as ordinary DB files.',
        rawBytes,
        storedBytes,
        entries,
      },
      null,
      2,
    )}\n`,
  );

  return { dir, entries, rawBytes, storedBytes };
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  const outIdx = argv.indexOf('--out');
  const outRoot =
    outIdx >= 0 && argv[outIdx + 1] !== undefined
      ? (argv[outIdx + 1] as string)
      : join(homedir(), '.musterd', 'corpus-snapshots');

  const swap = freeSwapMb();
  if (swap !== null && swap < MIN_FREE_SWAP_MB && !force) {
    console.error(
      `refusing: free swap ${swap.toFixed(0)} MB is below the ${MIN_FREE_SWAP_MB} MB floor ` +
        `(docs/wiki/nicks-laptop.md). Close Chrome, or pass --force if you are watching it.`,
    );
    process.exit(2);
  }

  const sources = [...defaultSources(), ...launchAgentSources()];

  if (dryRun) {
    const { items, missing } = planSnapshot(sources, statBytes, listRootDbs);
    const raw = items.reduce((n, i) => n + i.bytes, 0);
    if (json) {
      console.log(JSON.stringify({ items, missing, rawBytes: raw }, null, 2));
    } else {
      for (const i of items)
        console.log(`  ${i.id.padEnd(38)} ${mb(i.bytes).padStart(9)}  ${i.source}`);
      console.log(
        `\n${items.length} items, ${mb(raw)} raw${missing.length > 0 ? `, MISSING: ${missing.join(', ')}` : ''}`,
      );
    }
    return;
  }

  const result = await runSnapshot(outRoot, sources);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const e of result.entries) {
    console.log(
      `  ${e.id.padEnd(38)} ${mb(e.bytes).padStart(9)} -> ${mb(e.artifactBytes).padStart(9)}`,
    );
  }
  console.log(
    `\n${result.entries.length} artifacts, ${mb(result.rawBytes)} -> ${mb(result.storedBytes)} ` +
      `(${(result.rawBytes / Math.max(result.storedBytes, 1)).toFixed(1)}x)\n${result.dir}`,
  );
  console.log('\nThis snapshot is still on the same disk as the corpus. Copy it off-machine.');
}

if (process.argv[1]?.endsWith('snapshot.ts') === true) {
  await main();
}
