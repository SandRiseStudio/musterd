# Design — get broadcast capture off the laptop

**Lane** 01KYGXQCA4NEHDXNHMXB3G43S0 · **Owner** miley · **Date** 2026-07-26

## Problem

`musterd broadcast` streams the office to Twitch by running headless Chrome at 1920×1080 and ffmpeg,
side by side, for the length of the stream. Today both run on nick's development machine.

That machine is a **MacBook Air (Mac15,12), M3, 8 GB RAM, fanless**. The intended usage is roughly
**Mon–Fri 11:00–15:00 plus ad-hoc sessions** — call it 85–100 hours a month of sustained 1080p30
capture. Two properties of the hardware make that the wrong place for it, and neither is fixed by
making the code faster:

- **8 GB of RAM, already contended.** Measured while writing this design, with no capture running:
  2.3 GB swapped out, 31% memory free, against a working set of Claude Code, a dozen MCP servers, the
  daemon and a browser. Chrome rendering a 1080p canvas is a memory cost on top of that.
- **No fan.** Sustained multi-hour load on an Air throttles. A stream that is healthy for ten minutes
  degrades over four hours, and the failure mode is the encoder falling behind — the same wedge the
  capture-perf instrumentation (#389) exists to detect.

VideoToolbox does make the *encode* nearly free in CPU terms on this machine. That is a real
advantage and it is also irrelevant to both problems above: hardware encoding gives back no RAM and
no thermal headroom.

## Constraints

Stated by nick, 2026-07-26:

- The **only** driver is getting broadcast off the dev box. Reachability for other people, and a
  hosted product, are explicitly not motivating this.
- **No scheduling.** The 11–3 window is a description of when he expects to feel like streaming, not
  a timetable anything should act on.
- **Cloud only** — no hardware purchase.
- **Cold start does not matter.** There is no time by which he needs to be live.
- Anything cheap enough to leave on the Mac should stay there.

## Decision

**Move the broadcast pair — Chrome and ffmpeg — to a rented Linux machine whose lifetime is the
stream's lifetime. Leave everything else where it is.**

- **The daemon stays on the Air.** It serves a prerendered page and a WebSocket event feed; that is
  the cheap half, and moving it is out of scope (see _Rejected_).
- **Reachability comes from an overlay, not from musterd.** Tailscale joins the Air and the broadcast
  box; `--server` points at the Air's tailnet address so Chrome can load `/broadcast?team=<slug>`.
  This is [ADR 039](../../decisions/039-cross-network-topology.md) topology B, which already decides
  that the overlay supplies reachability, encryption and mutual auth so **musterd writes none of it**.
- **The machine's main process is the broadcast run.** Starting a stream boots the box; ending the
  stream exits the process and stops the box. This satisfies "no scheduling" without requiring nick to
  remember to shut anything down, and billing tracks the hours actually streamed.
- **Provider and machine class are deliberately undecided** until Increment 0 produces numbers.

### Porting cost is near zero

The CLI is already substantially portable, which was verified rather than assumed:

| concern    | today                                                | on Linux                                   |
| ---------- | ---------------------------------------------------- | ------------------------------------------ |
| encoder    | `videotoolbox` on darwin (`broadcast.ts:77`)         | falls through to `libx264` already         |
| Chrome path| hardcoded macOS default                              | `CHROME_BIN` env override already exists   |
| stream key | macOS Keychain                                       | `MUSTERD_STREAM_KEY` is checked *first*     |

No code change is required to run the capture on Linux. What changes is that the encode stops being
free: `libx264` is software, so the rented box pays for it in cores. **Sizing for that encode, not for
Chrome's render, is the thing most likely to be got wrong** — which is what Increment 0 measures.

## Rejected

- **Scheduled start/stop (cron around 11–3).** Rejected by nick: the window is descriptive, not a
  timetable. Process-lifetime machines achieve the cost saving without a clock.
- **A Mac mini (~$600).** The only option that keeps hardware encoding, zero porting risk, no overlay
  and no egress bill. Rejected: it spends hardware money up front on a problem a small monthly cloud
  bill solves, and nick ruled out purchases.
- **Hetzner x86 (CCX/CPX).** Was the obvious cheap answer; the **June 2026 price increases** removed
  that (CCX13 €15.99 → €42.99, +169%; CPX22 €7.99 → €19.49). The ARM CAX line took only ~30% and
  remains cheap, so if Hetzner is used at all it should be CAX — which is what makes ARM-Chromium a
  risk worth retiring in Increment 0 rather than at provisioning time.
- **Moving the daemon too** (ADR 039 topology A). Not motivated by the stated driver. It becomes the
  right call if the "laptop sleeps mid-stream" risk below turns from theoretical into annoying.
- **A hosted relay** (ADR 039 topology C). Named-not-scheduled in that ADR; nothing here changes that.

## Increment 0 — measure before renting

The failure this guards against is the one the capture-perf lane has already hit three times:
committing effort to a hypothesis that a measurement would have killed. Extrapolating from this Mac
is specifically weak — VideoToolbox means it never pays for the encode, so no number taken here
predicts what `libx264` costs on an Ampere or x86 core. **The candidates get measured by renting them
for an hour and running the real capture**, at a cost of roughly €0.20.

| run | machine                | encoder        | answers                                                |
| --- | ---------------------- | -------------- | ------------------------------------------------------ |
| A   | the Air (already due)  | `videotoolbox` | today's true baseline — the #369 draws/delivered question |
| B   | the Air                | `libx264`      | what losing hardware encode costs, on known hardware      |
| C   | Hetzner CAX (ARM), 1 h | `libx264`      | does Ampere hold 1080p30, and does Chromium run at all    |
| D   | Fly Performance, 1 h   | `libx264`      | the same on x86 dedicated, for the price comparison       |

**Pass/fail is queue growth, not CPU%.** The harness already treats `queueGrowthBytesPerSec` as the
margin metric: flat means the encoder is keeping up, rising means it is wedging regardless of how the
CPU percentage looks. A candidate either holds 1080p30 with flat queue growth or it is disqualified;
among those that pass, choose on price.

**Harness change required:** `scripts/perf/broadcast-baseline.mjs` builds its argv explicitly and has
no `--encoder` passthrough. Adding one is the only code change in this increment.

**Gate:** runs A and B inherit the existing quiet-machine discipline (`QUIET_LOAD_MAX = 2.0`, rows
stamped `contaminated` otherwise). They are blocked on the same quiet window the capture-perf lane is
waiting for.

Runs A and B also split Chrome's cost from the encode's, which sizes C and D rather than guessing at
them.

## Increment 1 — provision

Only after Increment 0 yields numbers. Pick the box from the passing candidates, join it to the
tailnet, install the stream key, and reduce going live to a single command. Detail deferred — writing
it now would be designing against estimates, which is the thing this spec exists to avoid.

## Risks recorded, not solved

- **The daemon is on a laptop that sleeps.** When it does, Chrome on the rented box loses the page and
  the stream dies. Accepted for now, because the alternative is moving the daemon, which is out of
  scope. This is the trigger to revisit topology A.
- **The stream key leaves the Keychain.** Today it lives in macOS Keychain and never touches argv. On
  a rented box it becomes an environment variable or a provider secret store — a genuine downgrade in
  secret handling. Recorded deliberately rather than allowed to happen quietly; Increment 1 should
  pick the strongest option the chosen provider offers.
- **ARM Chromium is unproven here.** Only load-bearing if Hetzner CAX wins on price; Increment 0 run C
  retires it before any commitment.

## Out of scope

No scheduling. No moving the daemon. No hosted multi-tenant relay. No `/live` or `/broadcast` route
changes — this is where the capture runs, not what it renders.

## Sources

Pricing checked 2026-07-26; both providers changed pricing in 2026 and these should be re-verified
before spending:

- [Hetzner price increase June 2026 — wz-it](https://wz-it.com/en/blog/hetzner-price-increase-june-2026-cpx-ccx-alternatives/)
- [Hetzner June 2026 price shock — byteiota](https://byteiota.com/hetzner-june-2026-price-shock/)
- [Fly.io pricing explained 2026 — Deploy Handbook](https://deployhandbook.com/pricing/fly-io)
