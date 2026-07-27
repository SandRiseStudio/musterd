#!/usr/bin/env node
/**
 * Broadcast capture-perf baseline harness (no deps — spawns the real `musterd broadcast`).
 *
 * Plan: docs/superpowers/plans/2026-07-25-broadcast-capture-perf.md
 * Baseline doc + numbers: docs/perf/broadcast-baseline.md
 *
 * Runs one capture with `MUSTERD_BROADCAST_PERF` pointed at a JSONL scratch file, then summarizes it
 * with the same tested code the recorder uses (packages/cli/dist — run `pnpm build` first). Prints a
 * row ready to paste into the baseline table.
 *
 * **This refuses to *start* on a busy machine** (load1 vs `QUIET_LOAD_MAX`), because before a capture
 * runs, load describes other people's work. Whether a *finished* run was contaminated is judged from
 * external CPU instead — the capture's own ~1.5 cores push load past any sane bar on their own, so a
 * load-based verdict failed every run including the quiet ones. Pass `--force` to start anyway.
 *
 * Usage:
 *   node scripts/perf/broadcast-baseline.mjs --label "1080p30 (today)" [--fps 30] [--secs 60]
 *     [--encoder videotoolbox|libx264] [--resolution 720p|1080p] [--team revive]
 *     [--server http://127.0.0.1:4849]
 *     [--jsonl <path>] [--json out.json] [--force]
 *
 * The capture writes video to a temp .mp4 that is deleted on exit — this harness measures the
 * pipeline, it does not keep the footage.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const LABEL = flag('label', 'unlabeled');
const FPS = Number(flag('fps', '30'));
const SECS = Number(flag('secs', '60'));
const TEAM = flag('team', 'revive');
const SERVER = flag('server', 'http://127.0.0.1:4849');
// Left unset the CLI picks per platform (videotoolbox on darwin, libx264 elsewhere). Setting it is
// how one machine measures both: hardware encode is nearly free, software encode is not, and the gap
// is what sizing a Linux box turns on.
const ENCODER = flag('encoder');
// The 720p arm (hosting spec): a quarter of the pixels on the same serial render thread.
const RESOLUTION = flag('resolution');
const JSON_OUT = flag('json');
const FORCE = has('force');

const root = resolve(import.meta.dirname, '../..');
const dist = join(root, 'packages/cli/dist/commands/broadcast-perf.js');
let summarize, QUIET_LOAD_MAX;
try {
  ({ summarize, QUIET_LOAD_MAX } = await import(dist));
} catch {
  console.error(`✗ ${dist} not found — run \`pnpm build\` first.`);
  process.exit(2);
}

// ── Gate on a quiet machine, before spending a minute of capture on numbers nobody can trust ──
const load = loadavg()[0];
if (load > QUIET_LOAD_MAX && !FORCE) {
  console.error(
    `✗ load average is ${load.toFixed(2)}, above the ${QUIET_LOAD_MAX} quiet-machine bar.\n` +
      `  Stop the other agents and sessions first — a contaminated baseline is worse than no\n` +
      `  baseline, because it looks like data. Pass --force to record anyway.`,
  );
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), 'broadcast-baseline-'));
const jsonl = flag('jsonl', join(scratch, 'samples.jsonl'));
const mp4 = join(scratch, 'capture.mp4');
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

console.error(`▸ ${LABEL} — ${FPS}fps, ${SECS}s, team ${TEAM} (load ${load.toFixed(2)})`);

const cli = join(root, 'packages/cli/dist/bin.js');
const proc = spawn(
  process.execPath,
  [
    cli,
    'broadcast',
    '--team',
    TEAM,
    '--server',
    SERVER,
    '--fps',
    String(FPS),
    '--duration',
    String(SECS),
    '--out',
    mp4,
    ...(ENCODER ? ['--encoder', ENCODER] : []),
    ...(RESOLUTION ? ['--resolution', RESOLUTION] : []),
  ],
  {
    env: { ...process.env, MUSTERD_BROADCAST_PERF: jsonl },
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);
const code = await new Promise((r) => proc.on('exit', r));
if (code !== 0) {
  console.error(`✗ capture exited ${code} — see the output above.`);
  process.exit(code ?? 1);
}

// ── Summarize with the recorder's own tested code, so the harness cannot drift from the numbers ──
let samples;
try {
  samples = readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
} catch {
  console.error(`✗ no samples at ${jsonl} — did the capture reach the live stage?`);
  process.exit(1);
}
const s = summarize(samples);
const n = (v, d = 1) => (v === undefined ? '—' : v.toFixed(d));
const kbPerSec = s.queueGrowthBytesPerSec / 1024;

console.log(`
  ${LABEL}${ENCODER ? ` · ${ENCODER}` : ''}
  ─────────────────────────────────────────────────────────
  delivered fps       ${n(s.meanDeliveredFps)}   (${n(s.meanKbPerFrame)} KB/frame)
  canvas draw fps     ${n(s.meanDrawFps)}
  encoded fps         ${n(s.encodedFps)}
  draws / encoded     ${n(s.drawsPerEncodedFrame, 2)}   ← ~2 means every second painted frame is discarded
  queue growth        ${n(kbPerSec)} KB/s   ← THE MARGIN METRIC (flat ≈ headroom; speed= is not this)
  peak queue          ${n(s.peakQueueMb, 2)} MB
  cpu % (of a core)   chrome ${n(s.meanCpu.chrome)} · ffmpeg ${n(s.meanCpu.ffmpeg)} · cli ${n(s.meanCpu.cli)}
                      pipeline ${n(s.meanCpu.pipeline)} total (contains the three above)
  other processes     ${n(s.meanCpu.other)}%   ← what contamination is judged on
  load1               mean ${n(s.meanLoad1, 2)} · peak ${n(s.peakLoad1, 2)}   (context; the capture dominates it)
  samples             ${s.samples} over ${n(s.durationSec)}s
  ${s.contaminated ? '⚠ CONTAMINATED — other processes were busy; do not put this in the table' : '✓ quiet throughout'}

  table row:
  | ${LABEL} | ${ENCODER ?? 'default'} | ${n(s.meanDeliveredFps)} | ${n(s.meanDrawFps)} | ${n(s.encodedFps)} | ${n(s.drawsPerEncodedFrame, 2)} | ${n(kbPerSec)} KB/s | ${n(s.meanCpu.chrome)} | ${n(s.meanCpu.ffmpeg)} | ${n(s.meanCpu.pipeline)} | ${n(s.meanCpu.other)} |
`);

if (JSON_OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(JSON_OUT, JSON.stringify({ label: LABEL, fps: FPS, secs: SECS, ...s }, null, 2));
  console.error(`▸ wrote ${JSON_OUT}`);
}
process.exit(s.contaminated ? 1 : 0);
