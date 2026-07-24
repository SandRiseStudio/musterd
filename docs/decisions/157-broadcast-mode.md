# 157 — Broadcast mode: the office as a stream source

- Status: accepted — 2026-07-24. Increment 1 (the page mode) landed in #365; Increment 2 (the
  `musterd broadcast` capturer) was originally **gated** behind ≥2 real OBS streams, but nick waived
  the gate the same day ("keep moving so we don't have to rely on OBS") and it is now **built** —
  see the Increment 2 section. Number **157 pinned** — next free on `origin/main` (highest is 156),
  enforced by `adr-numbers:check` (#350).
- Date: 2026-07-24
- Builds on: [ADR 079](079-live-isometric-office.md) / [ADR 086](086-ambient-office-life.md) /
  [ADR 133](133-procedural-character-skeleton.md) (the office scene this streams),
  [ADR 151](151-web-perf-budgets-gate.md) (the byte budgets + the "loops stop when unseen" contract
  this carves an exception out of), [ADR 155](155-human-presence-ladder.md) (an authed web tab counts
  as an online human — the phantom-presence hazard a stream must not trip),
  [ADR 063](063-read-only-observer-seat.md) / [ADR 136](136-observer-grades-public-watch-links.md) (the read-only
  observer seat this connects as), [ADR 064](064-observer-seat-ttl.md) (the 24h observer TTL the
  unattended-recovery path exists for), [ADR 131](131-harness-residency-wake-ledger-host.md) (the daemon supervises,
  never spawns — the constraint Increment 2's process model has to respect).

## Context

Nick wants to stream the animated musterd office to Twitch a few hours a week. It is the most
legible artefact the project has: a room where agents visibly work, walk over to each other, and
speak — the argument for musterd, playing by itself.

The obvious approach was tried and failed: **OBS window-capturing a Chrome window** melted the
laptop. That path pays for the same pixels three times — Chrome renders the page, the compositor
hands the window to the screen-capture API, and OBS scales and re-encodes it — on top of a machine
already running the daemon and a roomful of agents. It is also fragile in ways streaming punishes:
the frame is whatever the window happens to look like, so a notification, a resize, a scrollbar or a
theme flip all go out live.

The web UI, meanwhile, is deliberately built to do the _opposite_ of what a stream source needs.
Its perf contract (`packages/web/AGENTS.md`) says **animation loops must stop when unseen** — the
office parks its rAF loop the moment the tab is hidden, which is exactly the state a capture runs in.
It renders at the device's DPR, so the pixel size of the scene depends on which monitor the window is
on. And it honours `prefers-reduced-motion`, which on a capture machine would ship a frozen room to
everyone watching.

## Problem

Give the office a **render mode meant to be captured**, without paying for it anywhere else:

1. The scene keeps animating while hidden or headless — but **only** on that page. The
   "loops stop when unseen" rule is a measured win every /live viewer relies on; a broadcast mode
   that quietly relaxed it globally would be a regression dressed as a feature.
2. The frame is **deterministic**: a fixed 1920×1080 stage at DPR 1, no panels, no controls, no
   connect form, nothing that reflows.
3. Streaming **cannot put a phantom human on the roster**. ADR 155 made an authenticated web tab
   count as an online human — correct for a person watching /live, wrong for a machine that will sit
   connected for hours while nobody is there.
4. Byte cost ≈ 0 for everyone not streaming.

## Decision

### Increment 1 — `/broadcast`, a render mode of the office (this PR)

**A separate route, not a mode of `/live`.** `packages/web/src/routes/broadcast.tsx` serves
`/broadcast?team=<slug>`. TanStack file routes code-split, so a viewer who never streams downloads
none of it. More importantly it makes requirement 3 **structural**: the broadcast route contains no
advanced-seat branch at all — it resolves its credential through `acquireObserver` and nothing else —
so there is no code path by which streaming could attach a seat credential and light up a human
presence row. `/live?team=…&broadcast=1` is accepted as a spec alias and redirects here, so the
guarantee survives the URL people will actually guess.

**One flag, threaded end to end.** `OfficeOptions.broadcast` (office-scene) ← `broadcast` prop
(`OfficeScene`) ← the route. It inverts exactly three decisions, extracted as pure predicates in
`packages/web/src/live/office-scene/broadcast.ts`:

| gate                                            | viewer                      | broadcast     |
| ----------------------------------------------- | --------------------------- | ------------- |
| `officeVisible` — run the render loop?          | tab must be visible         | always        |
| `officeDpr` — canvas backing scale              | `min(devicePixelRatio, 2)`  | pinned to `1` |
| `suspendIgnored` — honour `setSuspended(true)`? | yes (collapsed panel parks) | never         |

`officeVisible` is the single seam all three loop gates and the ambient scheduler already consulted
(`VISIBLE()`), so the change is one closure, not four call sites. `OfficeScene` additionally passes
`reduced = false` under broadcast: reduced-motion is a _viewer's_ preference and a stream source has
no viewer — honouring it on the capture machine would freeze the room for everyone watching, and
would drop the Tier-A ambient CSS layer (ADR 086) with it.

**The stage.** A full-viewport letterbox centring a fixed `1920×1080` stage. Fit-to-window uses
`transform: scale()`, which does not affect `clientWidth` — so the scene lays out and renders at
exactly 1920×1080 no matter how small the operator's preview window is, and an OBS browser source at
1920×1080 captures 1:1.

**The overlay** is deliberately minimal: team name plus a LIVE pill, bottom-left,
`pointer-events: none`. A designed overlay (ticker, act captions, brand frame) is a follow-up lane;
shipping a half-designed one now would only be something to undo.

**Unattended recovery.** A stream has no operator to click "reconnect", so a stale observer
credential (daemon reset, 24h TTL — ADR 064) drops and re-mints rather than dead-ending on a form.
Unlike /live's two-strike fallback, this retries indefinitely: the right failure mode for a page
expected to be alone in a window for hours.

### Perf-contract carve-out — why this is not a hole in ADR 151

The contract's rule is that **idle cost is paid by every viewer, forever**. That is what makes an
un-suspended loop expensive: it multiplies across everyone who ever opens the page. Broadcast mode
does not multiply. It runs on exactly the machines a human deliberately pointed at
`/broadcast?team=…` in order to encode the result — where a _stopped_ loop is the bug, not the cost.
So the carve-out is scoped by construction (a separate route, an explicit flag, off by default)
rather than by a comment asking future readers to be careful.

Measured cost of the whole increment (gzip; `pnpm perf:check` for the totals, and the sum of each
route's HTML `modulepreload` set for the per-route rows — `/live`'s preload set does **not** contain
`broadcast-*.js`, which is the code-split claim, checked rather than assumed):

|                               | main            | with /broadcast      | Δ              |
| ----------------------------- | --------------- | -------------------- | -------------- |
| entry chunk `index-*.js`      | 99,955 B        | 100,076 B            | **+121 B**     |
| shared `routes-*.js`          | 41,479 B        | 41,479 B             | **0**          |
| `/live` preload set (JS)      | 131.7 KB        | 132.7 KB             | +1.0 KB        |
| `/board` preload set (JS)     | 105.1 KB        | 105.2 KB             | +0.1 KB        |
| site total JS / CSS           | 222.1 / 17.0 KB | 224.1 / 17.6 KB      | +2.0 / +0.6 KB |
| the `/broadcast` chunk itself | —               | 936 B JS + 658 B CSS | new            |

No budget was raised (JS 224.1/244.1, CSS 17.6/19.5). The +1.0 KB on `/live` is chunk-boundary
overhead, not new code: once `broadcast.tsx` also imports `client.ts` / `format.ts` /
`useLiveStream.ts`, rolldown hoists them into shared chunks instead of inlining them into the live
chunk. Duplicating them per route would have been worse in aggregate; +2.0 KB site-wide for a whole
new route is the trade.

### Increment 2 — `musterd broadcast` (**built 2026-07-24; the OBS gate was waived**)

As originally accepted, this increment was gated behind ≥2 real OBS streams on Increment 1. Nick
waived that gate the same day — the point of the arc is streaming _without_ a GUI in the loop, and
he chose not to spend two evenings proving OBS adequate before replacing it. The design shipped as
sketched:

- **CLI, not daemon.** `packages/cli/src/commands/broadcast.ts`, dispatched from `bin.ts`. The
  daemon does **not** spawn it — ADR 131's residency model is explicit that the daemon supervises
  and never spawns processes. It runs foreground (`serve` posture, Ctrl-C to stop); LaunchAgent
  supervision is deferred until unattended streaming actually wants it.
- **Headless Chromium** on `/broadcast?team=…`, launched with `--headless=new
--window-size=1920,1080 --force-device-scale-factor=1`, driven over CDP (the
  `scripts/perf/live-baseline.mjs` pattern). It waits on `window.__broadcastReady` before encoding —
  "the page loaded" and "the page is streaming a real team" are different states, and a dead daemon
  fails fast instead of streaming a blank page.
- **CDP screencast → CFR pump → ffmpeg.** `Page.startScreencast` is change-driven and a rested
  office legitimately emits no frames, so a pure pump (`makeFramePump`) re-emits the latest frame on
  a fixed 1000/fps clock — a still room becomes a still, valid stream. Backpressure is drop-not-queue
  (a skipped duplicate frame is invisible; an unbounded buffer is an OOM). ffmpeg encodes
  `h264_videotoolbox` on macOS / `libx264` elsewhere, muxes a silent audio track (RTMP ingests
  reject video-only), keyframes every 2 s (Twitch's ask), and writes one of exactly three sinks:
  `--out <file.mp4>` (the no-key proof mode, same encode path), `--twitch`, or `--rtmp <url>`
  (any provider, verbatim).
- **The stream key is a secret**: `MUSTERD_STREAM_KEY` or the macOS Keychain item
  `musterd-stream-key` — never a flag (argv leaks into shell history and `ps`) and never musterd
  config, which is committed and exported to git (ADR 058).

The pure parts (option parsing, sink/key resolution, ffmpeg argv, the pump, the Chrome argv) are
exported and unit-tested; the runtime shell around them is thin by design.

## Consequences

- The office now has two consumers with opposite defaults. `broadcast` is the only knob that tells
  them apart, and it is off unless a route sets it — so the invariant to preserve is "nothing but
  `/broadcast` passes it", which a reader can check in one grep.
- `/broadcast` is unauthenticated in the sense that anyone who can reach the daemon can open it, and
  it will provision an observer to do so. That is the same posture as `/live` (ADR 063/134:
  observers mint from a local peer only), and the seat it gets is read-only.
- A stream shows the team's traffic, including directed acts, because a full-grade observer sees the
  whole timeline (ADR 136). **Streaming a team is a disclosure decision, not a rendering one.** If
  that ever needs limiting, the mechanism already exists — connect via a public-grade watch-link
  seat, which sees team/broadcast traffic only.
- The office caption ("3 agents · 1 human") is suppressed under broadcast so the overlay owns all
  on-screen text. It is a candidate for the designed overlay, not a loss.

## Observability & Evaluation

**Traces** — the page publishes two probes for a capturer or a check to read: `window.__office` (the
live scene handle, the same debug affordance `/office-preview` exposes) and `window.__broadcastReady`,
which is `true` only while the firehose is actually connected. The overlay is the human-readable twin
of the second: the pill reads CONNECTING until the stream is live, so a glance at the OBS preview
distinguishes "encoding a dead page" from "encoding the team". No new daemon-side telemetry — a
broadcast connects as an ordinary observer and appears in the existing observer accounting.

**Eval** — three checks, at three levels:

1. _Unit_ (`office-scene/broadcast.test.ts`, root vitest): each gate, both directions, including the
   **regressions that matter more than the feature** — a non-broadcast office still parks on
   `visibilityState: 'hidden'`, and still renders at the capped device DPR. Plus
   `client.test.ts`: `acquireObserver` returns the observer seat and never picks up any other stored
   credential — the machine-checkable half of the presence-safety claim.
2. _Headless_ (**run at merge time**, against a temp daemon on a DB copy serving the built client;
   the recipe the Increment 2 capturer would automate): launch `--headless=new
--window-size=1920,1080 --force-device-scale-factor=1`, and — three lessons the first run taught —
   (a) stub `document.visibilityState` to `'hidden'` via `Page.addScriptToEvaluateOnNewDocument`,
   because headless "new" reports `visible` and the contract under test is the _hidden_ tab; (b) hash
   the office **canvas** (`toDataURL`), not a page screenshot, whose topbar clock always moves; (c)
   have at least one seat online-and-working — an _empty_ room legitimately rests on a still frame in
   every mode. Then: on `/broadcast?team=…` three samples ~1–2s apart must **differ**, on a canvas of
   exactly 1920×1080 (DPR pinned); on `/live?team=…` under the same hidden stub they must be
   **identical** — the perf contract still holding. Result 2026-07-24: both directions PASS
   (broadcast canvas 1920×1080, 3 distinct hashes; /live canvas byte-identical across 3 samples).
3. _Live_ (the acceptance run): open `/broadcast?team=revive`, background the tab, confirm the
   animation continues and that `musterd status` shows **no new human online** — the ADR 155 hazard,
   checked against the daemon rather than against the code.

**Experiment** — the original pre-registered gate (≥2 OBS streams before building Increment 2) was
waived by nick on 2026-07-24, so the question it would have answered — "is OBS adequate?" — goes
unanswered by choice. The measurement plan transfers to the capturer itself: per real stream, record
laptop thermals/CPU while encoding, ffmpeg's own dropped/duplicated frame counts, and every operator
intervention (a restart, a reconnect). Those numbers decide the two deferred pieces — LaunchAgent
supervision (justified by interventions) and a scale-to-zero Fly encoder (justified by thermals).
The measure that would falsify the whole approach is subtler and worth naming: if nobody watches,
the bottleneck was never the render pipeline, and no amount of capture engineering fixes it.

**Increment 2 eval, run at build time (2026-07-24):** 16 unit tests over the exported pure parts
(option/sink/key resolution incl. the no-key failure, ffmpeg argv contract — image2pipe rate, silent
audio, 2 s keyframes, flv-vs-faststart per sink, codec swap —, pump semantics: silent-before-first,
duplicate-when-rested, newest-wins), plus the end-to-end proof: `musterd broadcast --team revive
--out proof.mp4 --duration 10` against the live daemon captured a playable 10 s 1920×1080 H.264 at
30 fps with the office visibly animating.
