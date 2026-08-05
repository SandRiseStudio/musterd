// Seat footprint classifier (pure) — the server-side port of the reference
// rules in scripts/perf/seat-footprint.mjs; the two lists below must stay
// pattern-for-pattern identical with the probe so ops snapshots and daemon
// samples agree about what a "sidecar" is.
//
// A sidecar is an MCP server process spawned for a harness session. We only
// ever classify (and later, reap) processes matching this allowlist — never
// generic node/npm, never the daemon, never a harness.

export interface ProcSample {
  pid: number;
  ppid: number;
  rssKb: number;
  command: string;
}

export interface SidecarStack {
  /** 'live:<parentPid>' | 'orphaned' | 'unattributed' */
  key: string;
  classification: 'live' | 'orphaned' | 'unattributed';
  /** Nearest non-sidecar ancestor for live stacks; null otherwise. */
  parentPid: number | null;
  procs: number;
  rssKb: number;
  pids: number[];
}

const SIDECAR_PATTERNS: RegExp[] = [
  /packages\/mcp\/dist\/index\.js/, // musterd's own MCP server
  /\bnpm exec\b.*mcp/i,
  /\bmcp-remote\b/,
  /\bmcp-server-[\w-]+/,
  /\b[\w-]+-mcp\b/, // chrome-devtools-mcp, playwright-mcp, elevenlabs-mcp
  /\bmcp-pdf-server\b/,
  /flyctl mcp server/,
];

const HARNESS_PATTERNS: RegExp[] = [/\bclaude\b/i, /Cursor/, /cursor-agent/, /\bcodex\b/i];

export function isSidecar(command: string): boolean {
  return SIDECAR_PATTERNS.some((r) => r.test(command));
}

function isHarness(command: string): boolean {
  return HARNESS_PATTERNS.some((r) => r.test(command));
}

const MAX_HOPS = 20; // ancestor-walk bound; deeper trees are debris, not sessions

// orphaned: reparented to launchd (its launcher died). live: a harness ancestor
// within reach. Everything else is unattributed — shown, never guessed.
function classifyProc(
  p: ProcSample,
  byPid: Map<number, ProcSample>,
): SidecarStack['classification'] {
  if (p.ppid === 1) return 'orphaned';
  let cur = byPid.get(p.ppid);
  for (let hops = 0; cur && hops < MAX_HOPS; hops++) {
    if (isHarness(cur.command)) return 'live';
    cur = byPid.get(cur.ppid);
  }
  return 'unattributed';
}

// Live stacks group by nearest non-sidecar ancestor, so nested sidecars
// (npm exec → node …-mcp) join their launcher's stack instead of splitting.
// Orphaned and unattributed sidecars aggregate into one stack each: after
// reparenting there is no launcher left to group by (measured 2026-08-05 —
// see docs/perf/seat-footprint.md finding 2).
function liveParentPid(p: ProcSample, byPid: Map<number, ProcSample>): number {
  let cur = p;
  for (let hops = 0; hops < MAX_HOPS; hops++) {
    const parent = byPid.get(cur.ppid);
    if (!parent || !isSidecar(parent.command)) return cur.ppid;
    cur = parent;
  }
  return cur.ppid;
}

export function buildStacks(procs: ProcSample[]): SidecarStack[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const stacks = new Map<string, SidecarStack>();
  for (const p of procs) {
    if (!isSidecar(p.command)) continue;
    const classification = classifyProc(p, byPid);
    const parentPid = classification === 'live' ? liveParentPid(p, byPid) : null;
    const key = classification === 'live' ? `live:${parentPid}` : classification;
    const s =
      stacks.get(key) ??
      ({ key, classification, parentPid, procs: 0, rssKb: 0, pids: [] } satisfies SidecarStack);
    s.procs += 1;
    s.rssKb += p.rssKb;
    s.pids.push(p.pid);
    stacks.set(key, s);
  }
  return [...stacks.values()].sort((a, b) => b.rssKb - a.rssKb);
}
