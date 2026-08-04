# Broadcast audio + the asks reel — Implementation Plan

> **For agentic workers:** implemented inline by the lane owner (miley), in seat. See
> `/Users/nick/.claude/CLAUDE.md` — musterd is the coordination layer; no writing subagents.

**Goal:** Put the office's synthesised audio on the Twitch stream, and show the asks rail on
`/broadcast` as a read-only cycling reel.

**Architecture:** The hosted capture container gains a PulseAudio null sink; `musterd broadcast
--audio` points Chrome at it and swaps ffmpeg's `anullsrc` input for the sink monitor. The page
enables both sound engines without persisting to `localStorage` and without the `document.hidden`
gate, with a broadcast-only throttle on act cues. Separately, a new read-only `AsksReel` component
reuses `asks.ts` and rides `/broadcast`'s `topSlot`.

**Tech Stack:** TypeScript, vitest, React 19 + TanStack Router, zod, WebAudio, ffmpeg, PulseAudio,
Debian bookworm container on Fly.

**Spec:** `docs/superpowers/specs/2026-08-04-broadcast-audio-and-asks-design.md`
**Lane:** `01KZ7A7H7NC0HT2K6AYPYNKRQ5` · **Branch:** `feat/broadcast-audio-and-asks` · **ADR:** 226

## Global Constraints

- **Hosted (Linux) only.** The local macOS `videotoolbox` arm stays silent. No BlackHole, no
  avfoundation.
- **`/live` behaviour does not change.** The cue throttle is broadcast-only. `AsksStrip` is not
  modified.
- **`--audio` defaults to off.** Without it, `ffmpegArgs` and `chromeArgs` output must be
  byte-identical to today.
- **Perf gate:** `pnpm perf:check` must pass. On breach, delete code — do **not** raise a budget
  (ADR 183, `packages/web/AGENTS.md`).
- **Gates:** `pnpm gates` = install → build → typecheck → coverage → format:check + doc gates. Build
  before typecheck. ADR 226 needs an `## Observability & Evaluation` section.
- **Never run `pnpm format`.** Use `pnpm exec prettier --write <your files>`.
- **Vitest runs from the repo root only.**
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/cli/src/commands/broadcast.ts` | `audio` option; `chromeArgs` autoplay flag; `ffmpegArgs` Pulse input |
| `packages/cli/src/commands/broadcast.test.ts` | unit coverage for both arg builders, both variants |
| `packages/cli/src/help/catalog.ts` | `--audio` in the broadcast usage line |
| `scripts/broadcast/hosted.Dockerfile` | `pulseaudio` + `pulseaudio-utils` |
| `scripts/broadcast/entrypoint.sh` | start the sink, verify it, pass `--audio` |
| `packages/web/src/live/sound.ts` | non-persisting enable, visibility bypass, `shouldChime` |
| `packages/web/src/live/sound.test.ts` | `shouldChime` coverage |
| `packages/web/src/live/useLiveStream.ts` | route the chime through the throttle |
| `packages/web/src/live/reel.ts` | **new** — `reelIndex`, pure cycling math |
| `packages/web/src/live/reel.test.ts` | **new** |
| `packages/web/src/live/AsksReel.tsx` | **new** — read-only cycling rail |
| `packages/web/src/live/Broadcast.css` | reel type scale, sized for 720p |
| `packages/web/src/routes/broadcast.tsx` | audio enable + `topSlot={<AsksReel …/>}` |
| `packages/web/src/live/OfficeScene.tsx` | correct the now-false `topSlot` doc comment |
| `packages/protocol/src/feature-epoch.ts` | bump 5 → 6 |
| `docs/decisions/226-broadcast-audio-and-asks.md` | **new** ADR |

---

## Task 1: `--audio` reaches ffmpeg and Chrome

**Files:**
- Modify: `packages/cli/src/commands/broadcast.ts` (`OptionsSchema` ~line 38, `parseOptions` ~line 67, `ffmpegArgs` ~line 199, `chromeArgs` ~line 666)
- Modify: `packages/cli/src/help/catalog.ts:148`
- Test: `packages/cli/src/commands/broadcast.test.ts`

**Interfaces:**
- Produces: `BroadcastOptions['audio']: boolean`; `chromeArgs(port, profileDir, platform, stage, audio?: boolean)`; `PULSE_SINK = 'musterd'` exported from `broadcast.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('audio', () => {
  it('leaves the default path byte-identical — the regression that matters most', () => {
    const opts = parseOptions({ team: 't', out: 'x.mp4', encoder: 'libx264' });
    expect(opts.audio).toBe(false);
    const args = ffmpegArgs(opts, { kind: 'file', target: 'x.mp4' });
    expect(args).toContain('anullsrc=r=44100:cl=stereo');
    expect(args.join(' ')).not.toContain('pulse');
    expect(args.join(' ')).not.toContain('aresample');
  });

  it('--audio swaps the silent input for the pulse monitor and follows the video clock', () => {
    const opts = parseOptions({ team: 't', twitch: true, encoder: 'libx264', audio: true });
    expect(opts.audio).toBe(true);
    const args = ffmpegArgs(opts, { kind: 'rtmp', target: 'rtmp://x' });
    expect(args.join(' ')).not.toContain('anullsrc');
    expect(args).toContain('pulse');
    expect(args).toContain(`${PULSE_SINK}.monitor`);
    // Video timestamps come from frame COUNT, pulse audio from wall clock — audio must follow.
    expect(args).toContain('aresample=async=1');
  });

  it('keeps an audio track either way — RTMP ingests reject video-only', () => {
    for (const audio of [false, true]) {
      const opts = parseOptions({ team: 't', twitch: true, encoder: 'libx264', ...(audio ? { audio: true } : {}) });
      expect(ffmpegArgs(opts, { kind: 'rtmp', target: 'rtmp://x' })).toContain('aac');
    }
  });

  it('only adds the autoplay override when audio is on — a stream never gets a click', () => {
    const stage = { width: 1280, height: 720 };
    expect(chromeArgs(9222, '/tmp/p', 'linux', stage, true)).toContain(
      '--autoplay-policy=no-user-gesture-required',
    );
    expect(chromeArgs(9222, '/tmp/p', 'linux', stage, false).join(' ')).not.toContain('autoplay');
    expect(chromeArgs(9222, '/tmp/p', 'linux', stage)).toEqual(chromeArgs(9222, '/tmp/p', 'linux', stage, false));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/cli/src/commands/broadcast.test.ts -t audio`
Expected: FAIL — `PULSE_SINK` is not exported, `opts.audio` undefined.

- [ ] **Step 3: Implement**

In `OptionsSchema`, after `resolution`:

```ts
  /** Capture the page's audio from the container's PulseAudio sink instead of muxing silence.
   * Hosted-Linux only (ADR 226): the macOS arm has no Pulse, and adding one was explicitly out of
   * scope. Off by default, so every existing invocation keeps producing byte-identical ffmpeg args. */
  audio: z.boolean().default(false),
```

In `parseOptions`, inside the `OptionsSchema.parse({…})` literal, beside `twitch`:

```ts
    audio: flags['audio'] === true,
```

Above `ffmpegArgs`:

```ts
/** The null sink the hosted entrypoint creates. Chrome plays into it; ffmpeg reads its monitor. */
export const PULSE_SINK = 'musterd';
```

In `ffmpegArgs`, replace the three-line `anullsrc` input block with:

```ts
    // audio: the page's own output when --audio (a Pulse null sink the entrypoint created), else
    // silence — ingests require an audio track either way.
    ...(opts.audio
      ? ['-f', 'pulse', '-i', `${PULSE_SINK}.monitor`]
      : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']),
```

and after `'-b:a', '128k',` add:

```ts
    // Two clocks with no shared reference: image2pipe synthesizes video timestamps from frame COUNT
    // while pulse timestamps are wall-clock, so over a four-hour stream they separate. This makes
    // audio the follower and lets ffmpeg absorb the difference. Only meaningful with a real source.
    ...(opts.audio ? ['-af', 'aresample=async=1'] : []),
```

In `chromeArgs`, add the parameter and the flag:

```ts
export function chromeArgs(
  debugPort: number,
  profileDir: string,
  platform: NodeJS.Platform = process.platform,
  stage: { width: number; height: number } = { width: 1920, height: 1080 },
  audio = false,
): string[] {
```

and inside the array, before `'about:blank'`:

```ts
    // A capture box has no user to click, and autoplay policy needs one before an AudioContext may
    // start. Without this the page's WebAudio graph is born suspended and the sink stays silent.
    ...(audio ? ['--autoplay-policy=no-user-gesture-required'] : []),
```

Then thread it at the call site (~line 961): `chromeArgs(debugPort, profile, process.platform, stage, opts.audio)`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/cli/src/commands/broadcast.test.ts`
Expected: PASS, including the pre-existing `anullsrc` and `-shortest` assertions.

- [ ] **Step 5: Add `--audio` to the help catalog**

In `packages/cli/src/help/catalog.ts:148`, append to the broadcast usage string, after `[--encoder videotoolbox|libx264]`:

```
 [--audio]
```

and add to the description paragraph:

```
'`--audio` captures the page’s own sound from a PulseAudio sink instead of muxing silence — hosted ' +
'Linux only; the sink must already exist, which the hosted entrypoint guarantees. '
```

- [ ] **Step 6: Verify the guidance gate and commit**

Run: `pnpm guidance:check && pnpm vitest run packages/cli/src/commands/broadcast.test.ts`

```bash
git add packages/cli/src/commands/broadcast.ts packages/cli/src/commands/broadcast.test.ts packages/cli/src/help/catalog.ts
git commit -m "broadcast: --audio captures the page instead of muxing silence

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: A sound card in the capture container

**Files:**
- Modify: `scripts/broadcast/hosted.Dockerfile`
- Modify: `scripts/broadcast/entrypoint.sh`

No unit test — this is container behaviour, verified by a real run in Task 8. The safety property is
that it **fails loud**, which Step 3 encodes.

- [ ] **Step 1: Add PulseAudio to the image**

In `hosted.Dockerfile`, in the apt list after `ffmpeg`:

```
      pulseaudio \
      pulseaudio-utils \
```

and extend the comment above the block:

```
# chromium + ffmpeg are the pipeline; pulseaudio is the sound card the container does not otherwise
# have (ADR 226 — without a sink, Chrome's WebAudio renders into nothing and the stream carries
# anullsrc); fonts stop the office rendering tofu; tailscale is the reachability layer.
```

- [ ] **Step 2: Start the sink in the entrypoint**

In `entrypoint.sh`, after the daemon-reachability preflight and **before** the chromium warm-up:

```bash
# ── the sound card ───────────────────────────────────────────────────────────────────────────────
#
# The container has no audio device, so Chrome's WebAudio graph would render into nothing and the
# stream would carry ffmpeg's silence generator (ADR 226). A null sink gives Chrome somewhere to
# play and gives ffmpeg a `.monitor` source to capture.
#
# System mode because this container runs as root and PulseAudio refuses a root session daemon;
# --disallow-exit because the daemon must outlive the idle gap between stream generations.
export PULSE_SERVER=unix:/var/run/pulse/native
mkdir -p /var/run/pulse
pulseaudio --system --disallow-exit --exit-idle-time=-1 --daemonize=yes \
  --log-target=file:/tmp/pulseaudio.log 2>/dev/null || true

for _ in $(seq 1 15); do
  pactl info >/dev/null 2>&1 && break
  sleep 1
done

pactl load-module module-null-sink sink_name=musterd \
  sink_properties=device.description=musterd >/dev/null 2>&1 || true
pactl set-default-sink musterd >/dev/null 2>&1 || true
```

- [ ] **Step 3: Refuse to go live without it**

Immediately after:

```bash
# Fail loud, for the same reason the tailnet and daemon checks above do — and more so. A missing
# sink does not look like a failure: the stream goes live, the office animates, and it carries
# silence. Nobody finds out until a human listens, which on a 4-hour unattended stream is hours.
pactl list short sources 2>/dev/null | grep -q 'musterd\.monitor' || {
  echo "✗ no PulseAudio sink — the stream would go live carrying silence"
  echo "  pactl info:"; pactl info 2>&1 | head -5
  echo "  daemon log:"; tail -20 /tmp/pulseaudio.log 2>/dev/null
  exit 1
}
echo "▸ audio sink up · musterd.monitor"
```

- [ ] **Step 4: Pass the flag to the capture**

In the `while :;` loop's `node … broadcast` invocation, after `--encoder libx264 \`:

```bash
    --audio \
```

- [ ] **Step 5: Lint the shell and commit**

Run: `shellcheck scripts/broadcast/entrypoint.sh` (if unavailable, `bash -n scripts/broadcast/entrypoint.sh`)
Expected: no new findings.

```bash
git add scripts/broadcast/hosted.Dockerfile scripts/broadcast/entrypoint.sh
git commit -m "broadcast: a PulseAudio sink in the capture box, and a preflight that refuses silence

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The page may make a sound without a click, and without rewriting your prefs

**Files:**
- Modify: `packages/web/src/live/sound.ts` (`FirehoseSound` ~line 93, `RoomTone` ~line 355)
- Test: `packages/web/src/live/sound.test.ts`

**Interfaces:**
- Produces: `firehoseSound.enableForBroadcast(): void`, `roomTone.enableForBroadcast(): void`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('enableForBroadcast', () => {
  it('does not touch the operator’s stored preference', () => {
    localStorage.setItem('musterd.live.sound', '0');
    localStorage.setItem('musterd.live.roomtone', '0');
    firehoseSound.enableForBroadcast();
    roomTone.enableForBroadcast();
    expect(firehoseSound.enabled).toBe(true);
    expect(roomTone.enabled).toBe(true);
    expect(localStorage.getItem('musterd.live.sound')).toBe('0');
    expect(localStorage.getItem('musterd.live.roomtone')).toBe('0');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/web/src/live/sound.test.ts -t enableForBroadcast`
Expected: FAIL — `enableForBroadcast is not a function`.

- [ ] **Step 3: Implement on `FirehoseSound`**

```ts
  /**
   * Turn sound on for a capture, without persisting. `/broadcast` only.
   *
   * Separate from `setEnabled` deliberately, rather than a `persist?: boolean` parameter: a stream
   * source must never rewrite the preference a human set on this machine, and the call site should
   * say so in its own name.
   */
  enableForBroadcast(): void {
    this.enabled = true;
    this.ensureContext();
  }
```

- [ ] **Step 4: Implement on `RoomTone`, including the visibility bypass**

Add a field beside `watching`:

```ts
  /** Broadcast mode — see `enableForBroadcast`. Set before `start()`, never cleared. */
  private broadcast = false;
```

and the method:

```ts
  /**
   * Turn the bed on for a capture, without persisting, and without the visibility gate.
   *
   * The gate exists so a bed left running in a background tab is not the most annoying possible
   * version of this feature. A capture box has no tab and no listener whose attention could wander
   * — it is the same reason broadcast already ignores `prefers-reduced-motion`. Non-theoretical:
   * headless and embedded Chrome surfaces have been observed reporting `document.hidden === true`
   * for their whole lifetime, which would suspend the bed for the entire stream.
   */
  enableForBroadcast(): void {
    this.broadcast = true;
    this.enabled = true;
    this.start();
  }
```

Then gate the three `document.hidden` reads (~lines 484, 489, 527) behind it — replace each
`document.hidden` with `this.hidden()`, and add:

```ts
  /** Visibility, as broadcast sees it: never hidden. */
  private hidden(): boolean {
    return !this.broadcast && document.hidden;
  }
```

Also guard the listener registration (~line 476) with `if (!this.watching && !this.broadcast)`.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run packages/web/src/live/sound.test.ts`
Expected: PASS, with every pre-existing sound test still green.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/live/sound.ts packages/web/src/live/sound.test.ts
git commit -m "sound: a non-persisting enable for broadcast, and no visibility gate on a capture box

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: A burst of acts is one cue, not twenty

**Files:**
- Modify: `packages/web/src/live/sound.ts`
- Modify: `packages/web/src/live/useLiveStream.ts:11` (import) and the chime call site
- Test: `packages/web/src/live/sound.test.ts`

**Interfaces:**
- Produces: `shouldChime(now: number, last: number, minGapMs?: number): boolean` (pure, exported);
  `firehoseSound.chime` gains internal throttling active only after `enableForBroadcast`.

- [ ] **Step 1: Write the failing test**

```ts
describe('shouldChime', () => {
  it('passes a cue clear of the gap and holds one inside it', () => {
    expect(shouldChime(1000, 0)).toBe(true);       // 1000ms since the last — clear
    expect(shouldChime(1000, 900)).toBe(false);    // 100ms since — inside
  });

  it('reopens exactly at the gap, not a millisecond before', () => {
    expect(shouldChime(1000, 300)).toBe(true);     // exactly 700ms
    expect(shouldChime(1000, 301)).toBe(false);    // 699ms
  });

  it('coalesces a burst to one cue rather than queueing', () => {
    // -Infinity is the never-fired sentinel the engine starts at, so the first act always sounds.
    let last = -Infinity;
    const fired = [0, 10, 20, 30, 40, 50].filter((t) => {
      if (!shouldChime(t, last)) return false;
      last = t;
      return true;
    });
    expect(fired).toEqual([0]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/web/src/live/sound.test.ts -t shouldChime`
Expected: FAIL — `shouldChime is not exported`.

- [ ] **Step 3: Implement**

Above `class FirehoseSound`:

```ts
/**
 * Minimum gap between broadcast act cues, ms. The stream fires the whole team's acts at one
 * listener who cannot mute them, and the cue set was tuned for a person at a desk with sparse
 * arrivals — unthrottled, a busy minute is a slot machine.
 *
 * A dropped cue plays nothing later: the visual channel (speech bubble, stream panel) already
 * carries every act, so the audio does not owe the viewer completeness.
 */
const BROADCAST_CUE_GAP_MS = 700;

/** Pure gate for the broadcast cue throttle — a burst coalesces to one cue rather than queueing. */
export function shouldChime(now: number, last: number, minGapMs = BROADCAST_CUE_GAP_MS): boolean {
  return now - last >= minGapMs;
}
```

In `FirehoseSound`, add a field and set it in `enableForBroadcast`:

```ts
  /** Throttle the cues (broadcast only — /live's tuning is unchanged and out of scope). */
  private throttled = false;
  private lastCueAt = -Infinity;
```

In `enableForBroadcast`, add `this.throttled = true;`.

At the top of `chime(act: string)`, after the `if (!this.enabled) return;`:

```ts
    if (this.throttled) {
      const now = Date.now();
      if (!shouldChime(now, this.lastCueAt)) return;
      this.lastCueAt = now;
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/web/src/live/sound.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/sound.ts packages/web/src/live/sound.test.ts
git commit -m "sound: throttle broadcast act cues so a burst is one cue, not twenty

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: The reel's cycling math

**Files:**
- Create: `packages/web/src/live/reel.ts`
- Create: `packages/web/src/live/reel.test.ts`

**Interfaces:**
- Produces: `reelIndex(count: number, elapsedMs: number, dwellMs?: number): number`, and
  `REEL_DWELL_MS: number`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { reelIndex, REEL_DWELL_MS } from './reel';

describe('reelIndex', () => {
  it('is 0 for an empty or single-item reel — nothing to cycle', () => {
    expect(reelIndex(0, 999_999)).toBe(0);
    expect(reelIndex(1, 999_999)).toBe(0);
  });

  it('advances one item per dwell and wraps', () => {
    expect(reelIndex(3, 0)).toBe(0);
    expect(reelIndex(3, REEL_DWELL_MS - 1)).toBe(0);
    expect(reelIndex(3, REEL_DWELL_MS)).toBe(1);
    expect(reelIndex(3, REEL_DWELL_MS * 2)).toBe(2);
    expect(reelIndex(3, REEL_DWELL_MS * 3)).toBe(0);
  });

  it('never indexes past the list — a shrinking reel must not read undefined', () => {
    for (const elapsed of [0, 5_000, 60_000, 3_600_000]) {
      for (const count of [1, 2, 7, 13]) {
        const i = reelIndex(count, elapsed);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(count);
      }
    }
  });

  it('treats nonsense elapsed time as the start rather than NaN', () => {
    expect(reelIndex(3, Number.NaN)).toBe(0);
    expect(reelIndex(3, -1)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/web/src/live/reel.test.ts`
Expected: FAIL — cannot resolve `./reel`.

- [ ] **Step 3: Implement**

```ts
/**
 * How long each ask holds the broadcast rail, ms.
 *
 * A stream viewer cannot click "see all", so the rail earns its single line by rotating instead:
 * over a minute, ten dwells show everything that is waiting. Long enough to read a name, a verb and
 * a gist out loud; short enough that thirteen asks cycle inside a viewer's attention span.
 */
export const REEL_DWELL_MS = 6_000;

/**
 * Which item the reel is showing. Pure, so the cycling is testable without a timer or a DOM — the
 * component only supplies `Date.now() - mountedAt` and re-renders.
 *
 * Clamped rather than trusted: the ask list shrinks under the reel whenever somebody answers one,
 * and an index computed against the old length must never read past the new one.
 */
export function reelIndex(count: number, elapsedMs: number, dwellMs = REEL_DWELL_MS): number {
  if (count <= 1) return 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  return Math.floor(elapsedMs / dwellMs) % count;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/web/src/live/reel.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/live/reel.ts packages/web/src/live/reel.test.ts
git commit -m "live: pure cycling math for the broadcast asks reel

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: `AsksReel` — the read-only rail

**Files:**
- Create: `packages/web/src/live/AsksReel.tsx`
- Modify: `packages/web/src/live/Broadcast.css`

**Interfaces:**
- Consumes: `deriveAsks`, `askIsLoud`, `byUrgency`, `AskView` from `./asks`; `reelIndex`,
  `REEL_DWELL_MS` from `./reel`; `initial`, `memberColor`, `kindOf` from `./format`;
  `askTierHolds` from `@musterd/protocol`.
- Produces: `<AsksReel envelopes={Envelope[]} roster={MemberSummary[]} />`.

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Envelope, MemberSummary } from '@musterd/protocol';
import { askTierHolds } from '@musterd/protocol';
import { askIsLoud, byUrgency, deriveAsks } from './asks';
import { initial, kindOf, memberColor } from './format';
import { REEL_DWELL_MS, reelIndex } from './reel';

const SPECIES_VERB = {
  consult: 'asks what you think',
  escalate: 'escalated to you',
  approve: 'needs your approval',
} as const;

/**
 * The asks rail as stream chrome (ADR 226) — what `AsksStrip` is to `/live`, minus every part that
 * takes input.
 *
 * **Why a separate component rather than a `broadcast` prop on `AsksStrip`.** Two reasons, and the
 * second is the one that settles it. `AsksStrip` is ~460 lines of *answerability* — `sendAct`,
 * sign-in offers, an Escape/click-outside sheet, `document.title` — and threading a mode through all
 * of it would couple a stream chyron to a form. And the two have genuinely different legibility
 * constraints: the 1080p stage is encoded at 720p, so `/live`'s 11.5px rail lands near 7.7px before
 * Twitch's encoder ever sees it. One stylesheet cannot serve both. What they *do* share is the
 * derivation, and that already lives in `asks.ts` as pure functions — which is the real seam.
 *
 * Nobody watching can click "see all", so the rail rotates instead: one ask at a time, by urgency.
 */
export function AsksReel({
  envelopes,
  roster,
}: {
  envelopes: Envelope[];
  roster: MemberSummary[];
}) {
  const asks = useMemo(() => deriveAsks(envelopes), [envelopes]);
  const loud = asks.filter((a) => askIsLoud(a.state)).sort((a, b) => byUrgency(a, b));
  const deferred = asks.filter((a) => a.state === 'deferred');
  const settled = asks.length - loud.length - deferred.length;
  const cards = [...loud, ...deferred];

  // One clock drives both the rotation and the countdowns. It ticks only while something is loud —
  // idle cost is paid by every viewer, forever (packages/web/AGENTS.md), and a stream runs for hours.
  const mountedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (loud.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [loud.length]);

  if (cards.length === 0) return null;

  const shown = cards[reelIndex(cards.length, now - mountedAt.current)]!;
  const idx = new Map(roster.map((m) => [m.name, m]));

  return (
    <section
      className={`bc-reel${loud.length > 0 ? ' bc-reel--loud' : ''}`}
      aria-label="asks and approvals"
    >
      <BellIcon />
      <span
        className="bc-reel__who"
        style={{ background: memberColor(shown.env.from, kindOf(shown.env.from, idx)) }}
        aria-hidden="true"
      >
        {initial(shown.env.from)}
      </span>
      {/* Keyed on the envelope id so React remounts on rotation and the entry animation replays —
          without it the text swaps in place and the change is easy to miss on a stream. */}
      <span className="bc-reel__lead" key={shown.env.id}>
        <b>{shown.env.from}</b>
        <span className="bc-reel__verb">{SPECIES_VERB[shown.species]}</span>
        {shown.env.body && <span className="bc-reel__gist">{shown.env.body}</span>}
      </span>
      <span className={`bc-reel__tier bc-reel__tier--${shown.tier}`}>{shown.tier}</span>
      <ReelClock ask={shown} now={now} />
      <span className="bc-reel__spacer" />
      {loud.length > 0 && <span className="bc-reel__meta">{loud.length} waiting</span>}
      {deferred.length > 0 && <span className="bc-reel__meta">{deferred.length} deciding</span>}
      {settled > 0 && <span className="bc-reel__meta">{settled} settled</span>}
      {cards.length > 1 && (
        <span className="bc-reel__dots" aria-hidden="true">
          {cards.map((c) => (
            <i key={c.env.id} className={c.env.id === shown.env.id ? 'is-on' : undefined} />
          ))}
        </span>
      )}
    </section>
  );
}

/** The tier clock. Same semantics as /live's, reading the caller's `now` so one interval drives all. */
function ReelClock({ ask, now }: { ask: ReturnType<typeof deriveAsks>[number]; now: number }) {
  if (ask.state === 'held') return <Elapsed holding />;
  if (ask.state !== 'open') return null;
  const left = ask.deadline - now;
  if (left <= 0) return <Elapsed holding={askTierHolds(ask.tier)} />;
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  return (
    <span className="bc-reel__clock">
      {m}:{String(s).padStart(2, '0')} left
    </span>
  );
}

function Elapsed({ holding }: { holding: boolean }) {
  return (
    <span className="bc-reel__clock bc-reel__clock--over">
      timed out{holding && <span className="bc-reel__holding"> — agent holding</span>}
    </span>
  );
}

function BellIcon() {
  return (
    <svg className="bc-reel__bell" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.8a2.9 2.9 0 0 1 2.9 2.9v1.9l1 1.6H2.1l1-1.6V4.7A2.9 2.9 0 0 1 6 1.8zM4.9 9.6a1.15 1.15 0 0 0 2.2 0" />
    </svg>
  );
}
```

Note the unused import guard: `REEL_DWELL_MS` is imported for the CSS-matched animation duration in
Step 2 — if the final CSS hard-codes it instead, drop the import rather than leaving it dangling
(`pnpm lint` will fail on it).

- [ ] **Step 2: Style it for 720p**

Append to `packages/web/src/live/Broadcast.css`:

```css
/* The asks reel (ADR 226). Sized for a 720p encode, not a desk: the stage is 1080p and the stream
   is downscaled ×0.667, so /live's 11.5px rail would land near 7.7px before Twitch's encoder. This
   is why the reel is not styled off .lc-asks — the two answer to different resolutions. */
.bc-reel {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 18px;
  font-size: 19px;
  line-height: 1.25;
  border-radius: 12px;
  background: color-mix(in srgb, var(--paper) 88%, transparent);
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  backdrop-filter: blur(6px);
}
.bc-reel--loud {
  border-color: color-mix(in srgb, var(--warn, #c2410c) 45%, transparent);
}
.bc-reel__bell {
  width: 20px;
  height: 20px;
  flex: none;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.1;
}
.bc-reel--loud .bc-reel__bell {
  animation: lc-asks-ring 2.4s ease-in-out infinite;
}
.bc-reel__who {
  width: 28px;
  height: 28px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
}
.bc-reel__lead {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  animation: bc-reel-in 420ms ease-out both;
}
.bc-reel__verb {
  opacity: 0.72;
}
.bc-reel__gist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 46ch;
  opacity: 0.85;
}
.bc-reel__tier {
  flex: none;
  font-size: 15px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
  opacity: 0.8;
}
.bc-reel__clock {
  flex: none;
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}
.bc-reel__clock--over {
  color: var(--warn, #c2410c);
  opacity: 1;
}
.bc-reel__spacer {
  flex: 1;
}
.bc-reel__meta {
  flex: none;
  font-size: 16px;
  opacity: 0.65;
}
.bc-reel__dots {
  display: flex;
  gap: 5px;
  flex: none;
}
.bc-reel__dots i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ink) 25%, transparent);
}
.bc-reel__dots i.is-on {
  background: color-mix(in srgb, var(--ink) 70%, transparent);
}
@keyframes bc-reel-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm build && pnpm typecheck`
Expected: clean. (Build first — typecheck reports phantom `.d.ts` errors otherwise.)

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/live/AsksReel.tsx packages/web/src/live/Broadcast.css
git commit -m "live: AsksReel — the asks rail as read-only stream chrome, sized for 720p

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Wire both halves into `/broadcast`

**Files:**
- Modify: `packages/web/src/routes/broadcast.tsx`
- Modify: `packages/web/src/live/OfficeScene.tsx:105-108` (the `topSlot` doc comment)

- [ ] **Step 1: Enable audio from the route**

In `broadcast.tsx`, add to the imports:

```ts
import { AsksReel } from '../live/AsksReel';
import { firehoseSound, roomTone } from '../live/sound';
```

and add a mount effect beside the stage effect:

```tsx
  // Sound on, unless the URL says otherwise. Both engines default OFF and normally need a click;
  // a capture box never gets one, which is what `--autoplay-policy=no-user-gesture-required` and
  // `enableForBroadcast` between them solve (ADR 226). Neither call persists — a stream must not
  // rewrite the preferences a human set on this machine.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('audio') === '0') return;
    firehoseSound.enableForBroadcast();
    roomTone.enableForBroadcast();
  }, []);
```

- [ ] **Step 2: Seat the reel**

In the `<OfficeScene …>` props, after `workCues="stack"`:

```tsx
          topSlot={<AsksReel envelopes={envelopes} roster={roster} />}
```

- [ ] **Step 3: Correct the `topSlot` comment in `OfficeScene.tsx`**

Replace lines 105-108 with:

```tsx
  /** Chrome floated over the TOP of the room. `/live` seats the answerable asks & approvals rail
   * here (nick's call: the office frames its own asks; the page above the panels stays quiet), and
   * `/broadcast` seats `AsksReel` — the same asks, read-only and cycling, because a stream cannot
   * answer one but should still show that thirteen are waiting (ADR 226). */
```

- [ ] **Step 4: Verify in the browser at stage size**

```bash
pnpm --filter @musterd/web build
```

Then, with the daemon serving on :4849, open `/broadcast?team=revive&h=720` in the Browser pane,
`resize_window` to 1280×720, and screenshot. Check: the reel renders, the text is legible at 720p,
it rotates every 6s, and the office is not covered.

> **TRAP** (`docs/` memory): `vite preview` caches `dist/` at start — restart it after every build
> or pages go blank with 404'd chunks.

- [ ] **Step 5: Perf gate**

Run: `pnpm perf:check`
Expected: PASS. `totalJsGzipBytes` rises slightly (`AsksReel` + `reel.ts`, no new dependency). On
breach, delete code — do not raise the budget (ADR 183).

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/routes/broadcast.tsx packages/web/src/live/OfficeScene.tsx
git commit -m "broadcast: sound on, and the asks reel over the room

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: ADR 226, the epoch bump, and the measured mix

**Files:**
- Create: `docs/decisions/226-broadcast-audio-and-asks.md`
- Modify: `packages/protocol/src/feature-epoch.ts:41`
- Modify: `docs/superpowers/specs/2026-08-04-broadcast-audio-and-asks-design.md` (§1.6)
- Modify: the broadcast hosting spec (`docs/design/broadcast-hosting-design.md`)

- [ ] **Step 1: Open the draft PR before writing the ADR**

ADR 223: push the branch as a draft PR *before* writing the ADR, so 226 is visible to the next seat.

```bash
git push -u origin feat/broadcast-audio-and-asks
gh pr create --draft --title "Broadcast gets a voice — page audio on the stream, and the asks rail on /broadcast (ADR 226)" --body "Spec: docs/superpowers/specs/2026-08-04-broadcast-audio-and-asks-design.md

Lane 01KZ7A7H7NC0HT2K6AYPYNKRQ5. Claims ADR 226.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 2: Run the calibration capture**

This is the measurement §1.6 of the spec is holding a blank for. On the capture box (or a Linux
container with the sink up):

```bash
musterd broadcast --team revive --out /tmp/calib.mp4 --duration 120 --encoder libx264 --audio
ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,channels,sample_rate /tmp/calib.mp4
ffmpeg -hide_banner -nostats -i /tmp/calib.mp4 -af ebur128 -f null - 2>&1 | tail -20
```

Expected: a real `aac` stream, **not** silent (the `ebur128` summary must not read `-70 LUFS`
or lower). Record the integrated loudness.

- [ ] **Step 3: Set the broadcast master gain and record the number**

If integrated loudness is far from a broadcast-sane target, add a single master gain in
`enableForBroadcast` on both engines and re-measure. Then fill §1.6 of the spec with the measured
value **and** what was measured to get it, in the form `LIFE_GAIN` uses in `sound.ts`.

- [ ] **Step 4: Write ADR 226**

`docs/decisions/226-broadcast-audio-and-asks.md`, H1 exactly `# 226 — Broadcast audio and the asks
reel`. Must include `## Observability & Evaluation` (`pnpm check:obs-evals`). Cover: the stream had
no audio path at all rather than a disabled one; PulseAudio over in-page `MediaRecorder` and why;
hosted-only; the throttle; the reel as a separate component; and the entrypoint preflight as the
guard against a silent live stream.

- [ ] **Step 5: Bump the feature epoch**

`packages/protocol/src/feature-epoch.ts:41` — `5` → `6`. This is a client-visible capability change
(ADR 148).

- [ ] **Step 6: Full gates, then undraft**

```bash
pnpm exec prettier --write docs/decisions/226-broadcast-audio-and-asks.md docs/superpowers/specs/2026-08-04-broadcast-audio-and-asks-design.md
pnpm gates && pnpm lint && pnpm adr-numbers:check
```

Expected: all green. `pnpm lint` is a separate gate from `format:check` — run both.

```bash
git add -A && git commit -m "docs: ADR 226 — broadcast audio and the asks reel

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git push
gh pr ready
```

- [ ] **Step 7: The real hosted run**

```bash
musterd stream doctor
musterd stream build
musterd stream start --args "--duration 600"
```

Watch for `▸ audio sink up · musterd.monitor` in the machine logs, then confirm by ear on Twitch:
the room tone bed is audible, act cues land over it, and cues do not machine-gun during a burst.

- [ ] **Step 8: Merge**

```bash
gh pr merge --squash --auto --delete-branch
```

Then `lane_submit` on `01KZ7A7H7NC0HT2K6AYPYNKRQ5`.

---

## Self-Review

**Spec coverage:** §1.1 → T2S1 · §1.2 → T2S2–4 · §1.3 → T1 · §1.4 → T3, T7S1 · §1.5 → T4 · §1.6 →
T8S2–3 · §2.1 → T6 · §2.2 → T5, T6 · §2.3 → T6S2 · §2.4 → T7S3 · Testing → T1S1, T3S1, T4S1, T5S1,
T7S4–5, T8S2/S7 · Documentation → T8 · Risks → T2S3 (silent sink), T1S3 (drift), T8S2–3 (mix),
T7S5 (budget), T7S4 (legibility). No gaps.

**Placeholders:** none. §1.6's blank is a measurement produced by T8S2, not an unwritten step.

**Type consistency:** `PULSE_SINK` defined T1S3, used T1S1 and T2. `enableForBroadcast` defined T3,
used T4S3 and T7S1. `shouldChime` defined T4S3, used T4S1. `reelIndex`/`REEL_DWELL_MS` defined T5S3,
used T6S1. `AsksReel` props defined T6S1, used T7S2. Checked.

**One known rough edge:** T6S1 imports `REEL_DWELL_MS` for an animation duration the final CSS may
hard-code instead. Flagged inline — drop the import rather than leave it dangling, or `pnpm lint`
fails.
