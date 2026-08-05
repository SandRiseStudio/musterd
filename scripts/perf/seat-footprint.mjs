#!/usr/bin/env node
// Seat footprint probe — Phase 0 of the seat-footprint design
// (docs/superpowers/specs/2026-08-05-seat-footprint-design.md).
//
// One snapshot per run: swap, free memory, MCP sidecar stacks classified
// live / orphaned / unattributed. Standalone by design (no imports from
// packages/) — the classification rules here are the reference the server-side
// port in packages/server/src/footprint/classify.ts must match.
//
//   node scripts/perf/seat-footprint.mjs          human-readable
//   node scripts/perf/seat-footprint.mjs --json   machine-readable
//
// Findings log: docs/perf/seat-footprint.md (append a snapshot per milestone).
import { execFileSync } from 'node:child_process';

const SIDECAR_PATTERNS = [
  /packages\/mcp\/dist\/index\.js/, // musterd's own MCP server
  /\bnpm exec\b.*mcp/i,
  /\bmcp-remote\b/,
  /\bmcp-server-[\w-]+/,
  /\b[\w-]+-mcp\b/, // chrome-devtools-mcp, playwright-mcp, elevenlabs-mcp
  /\bmcp-pdf-server\b/,
  /flyctl mcp server/,
];
const HARNESS_PATTERNS = [/\bclaude\b/i, /Cursor/, /cursor-agent/, /\bcodex\b/i];

function ps() {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,args='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return m && { pid: +m[1], ppid: +m[2], rssKb: +m[3], command: m[4] };
    })
    .filter(Boolean);
}

function swap() {
  const out = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
  const m = out.match(/total = ([\d.]+)M\s+used = ([\d.]+)M/);
  return m ? { totalMb: +m[1], usedMb: +m[2] } : null;
}

function freeMemMb() {
  const out = execFileSync('vm_stat', [], { encoding: 'utf8' });
  const page = +(out.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const free = +(out.match(/Pages free:\s+(\d+)\./)?.[1] ?? 0);
  return Math.round((free * page) / 1024 / 1024);
}

const procs = ps();
const byPid = new Map(procs.map((p) => [p.pid, p]));
const isSidecar = (p) => SIDECAR_PATTERNS.some((r) => r.test(p.command));
const isHarness = (p) => HARNESS_PATTERNS.some((r) => r.test(p.command));

// orphaned: reparented to launchd (its session died). live: a harness ancestor
// within reach. Everything else is unattributed — shown, never guessed.
function classify(p) {
  if (p.ppid === 1) return 'orphaned';
  let cur = byPid.get(p.ppid);
  for (let hops = 0; cur && hops < 20; hops++) {
    if (isHarness(cur)) return 'live';
    cur = byPid.get(cur.ppid);
  }
  return 'unattributed';
}

// Live stacks group by nearest non-sidecar ancestor, so nested sidecars
// (npm exec → node …-mcp) join their launcher's stack instead of splitting.
function stackKey(p, c) {
  if (c !== 'live') return c;
  let cur = p;
  for (let hops = 0; hops < 20; hops++) {
    const parent = byPid.get(cur.ppid);
    if (!parent || !isSidecar(parent)) return `live:${cur.ppid}`;
    cur = parent;
  }
  return `live:${cur.ppid}`;
}

const sidecars = procs.filter(isSidecar);
const stacks = new Map();
for (const p of sidecars) {
  const c = classify(p);
  const key = stackKey(p, c);
  const s = stacks.get(key) ?? { key, classification: c, procs: 0, rssKb: 0, pids: [] };
  s.procs += 1;
  s.rssKb += p.rssKb;
  s.pids.push(p.pid);
  stacks.set(key, s);
}

const orphaned = sidecars.filter((p) => classify(p) === 'orphaned');
const snap = {
  ts: new Date().toISOString(),
  swap: swap(),
  freeMemMb: freeMemMb(),
  totalProcs: procs.length,
  sidecarProcs: sidecars.length,
  orphanedProcs: orphaned.length,
  orphanedRssMb: Math.round(orphaned.reduce((s, p) => s + p.rssKb, 0) / 1024),
  stacks: [...stacks.values()].sort((a, b) => b.rssKb - a.rssKb),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(snap, null, 2));
} else {
  console.log(`# ${snap.ts}`);
  console.log(
    `swap ${snap.swap?.usedMb ?? '?'}/${snap.swap?.totalMb ?? '?'} MB · free mem ${snap.freeMemMb} MB · ${snap.totalProcs} procs total`,
  );
  console.log(
    `sidecars: ${snap.sidecarProcs} procs in ${snap.stacks.length} stacks · orphaned ${snap.orphanedProcs} procs (~${snap.orphanedRssMb} MB RSS)`,
  );
  for (const s of snap.stacks) {
    const owner =
      s.classification === 'live'
        ? (byPid.get(+s.key.slice(5))?.command ?? 'gone').slice(0, 60)
        : s.classification;
    console.log(
      `  ${s.key.padEnd(14)} ${String(s.procs).padStart(3)} procs ${String(Math.round(s.rssKb / 1024)).padStart(5)} MB  ${owner}`,
    );
  }
}
