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
| D   | Fly Performance, 1 h   | `libx264`      | **first** — x86 dedicated sizing, and the draws/delivered question on a machine where delivered is not depressed by contention |
| C   | Hetzner CAX (ARM), 1 h | `libx264`      | does Ampere hold 1080p30, and does Chromium run at all; gated on an account existing |
| A   | the Air (opportunistic)| `videotoolbox` | the local baseline — today's true numbers on the machine as it actually is |
| B   | the Air (opportunistic)| `libx264`      | what losing hardware encode costs, on known hardware      |

**Pass/fail is queue growth, not CPU%.** The harness already treats `queueGrowthBytesPerSec` as the
margin metric: flat means the encoder is keeping up, rising means it is wedging regardless of how the
CPU percentage looks. A candidate either holds 1080p30 with flat queue growth or it is disqualified;
among those that pass, choose on price.

**Harness change required:** `scripts/perf/broadcast-baseline.mjs` builds its argv explicitly and has
no `--encoder` passthrough. Adding one is the only code change in this increment.

### Rent quiet — the rented runs come first (amended 2026-07-26)

The original ordering assumed A and B would come first, on a quiet Air. That assumption does not
survive contact with the machine: its floor at the start of the session was already **5.5**, before
any build, against a bar of 2.0. On an 8-core laptop running Spotlight, a browser, Claude Code and a
dozen MCP servers, **the bar may describe a machine nick does not own.**

So the order inverts. **A rented box is quiet by construction** — nothing else runs on it — and it
costs cents. C and D run first; A and B demote to opportunistic, taken whenever the Air is genuinely
idle. If that never happens we lose the local baseline, but not the decision.

Two consequences follow:

- **The daemon runs on the rented box for the measurement**, using the temp-daemon recipe from the
  `/live` perf work (`MUSTERD_DB` copy + `MUSTERD_PORT`). Daemon, Chrome and ffmpeg all local to one
  quiet machine means **Increment 0 needs no Tailscale at all** — the overlay moves to Increment 1
  where it belongs.
- **The fixture is synthetic, not a copy of the real team.** Seeding a team with a representative
  number of seats keeps the benchmark reproducible and, more importantly, keeps real message content
  off a rented machine. Copying the live DB would have been easier and is rejected on both counts.

**Sequencing note:** the Fly MCP server is authenticated to nick's personal org, so **run D can be
done immediately**. There is no Hetzner account or `hcloud` CLI on this machine, so **run C is gated
on nick creating one** — and is only load-bearing if the ARM price advantage is worth pursuing after
D lands.

### On not moving the gate

`QUIET_LOAD_MAX = 2.0` is an absolute number on an 8-core machine, chosen reactively (the harness
comment records load "swung between 5 and 63" during the contaminated session). A better gate would
likely normalize per core and check *stability* rather than level — a steady load of 5 supports a
sounder comparison than one swinging 1→9, because variance within and between runs is what actually
corrupts these numbers.

**That change is not being made here.** Loosening a gate because it keeps returning no is precisely
the failure the gate exists to prevent, and renting quiet removes the pressure to do it. If the
threshold is ever revised it should be because per-core normalization is *more correct*, argued on its
own merits and recorded — not because a red light was inconvenient.

### Increment 0 is largely DONE — on the laptop after all (amended 2026-07-27)

The amendment above concluded the Air could not measure this and quiet had to be rented. **That was
wrong, and the fix was to change what was measured rather than where.** Two moves did it:

- **Measure ratios, not absolutes.** Under the old code `ticks === draws` by construction, so
  `draws < ticks` is proof the cap engaged — and a ratio cannot be distorted by a busy machine.
- **Drive a live-room fixture.** The office loop parks on an idle room, so a temp daemon over a
  `.backup` copy renders a static scene and measures nothing. A loop posting acts every ~3s keeps
  seats working. (An earlier attempt compared a live room to a static one and looked like a result.)

Everything the local arms could answer is answered, and it changed the plan (PR #393):

| question | answer |
|---|---|
| draws/delivered — is the double-paint real? | Yes: 60 painted, 60 delivered, **30 encoded**. |
| Is candidate #1 (draw-rate cap) worth building? | **No — reverted.** ~4 points of CPU, inside the run-to-run spread. The painting was never the expense. |
| Where does Chrome's cost actually live? | The **JPEG encode of every composited frame**. `everyNthFrame` derived from `--fps` took Chrome 139.8% → 92.9% (n=4). |

**The sizing number moved twice, downward both times.** The pipeline was reported as ~2.8 cores
(a tree total misread as a leaf), then measured at ~1.7, and after the screencast fix it is
**~1.2 cores with hardware encode** (`pipeline 120.3%`). Anything sized against the earlier figures
is oversized.

**What still needs rented hardware**, and it is now a much smaller question:

- **`libx264` cost on the target box.** Unchanged in kind: this Mac never pays for its own encode, so
  ffmpeg's ~15% here says nothing about software encode on an Ampere or x86 core.
- **The compositor-Hz assumption.** `everyNthFrame` counts *composited* frames, so the shipped
  derivation assumes ~60Hz. It held here (delivery landed on 30.0 every run). A slower box could
  composite below 2× the encode rate, and delivery would fall *under* fps with the pump padding the
  shortfall with duplicates. **This must be re-checked on the rented candidate**, and it is now the
  main reason to rent at all.

**A metric that did not survive, recorded so it is not re-derived:** `mpdecimate` unique-frame counts
cannot compare configurations across separate runs. Four runs of an *identical* config gave
971 / 861 / 644 / 637 — the count tracks how much the room happened to animate, not the config.

### Run D happened — and the box fails on the render, not the encode (amended 2026-07-27)

One hour of Fly `performance-4x` (4 dedicated x86 cores, 8 GB, sjc) answered both remaining
questions, one of them in a direction that changes the plan. Three 45–60s captures against a
6-seat synthetic fixture (`scripts/perf/broadcast-bench-fixture.sh`), all quiet, all agreeing:

| run | delivered fps | draw fps | encoded | queue growth | chrome % | ffmpeg % |
| --- | --- | --- | --- | --- | --- | --- |
| 1080p30 | 10.2 | 19.2 | 30.0 | 0.5 KB/s | 177.4 | 80.7 |
| 1080p30 repeat | 10.6 | 20.8 | 30.0 | −1.1 KB/s | — | — |
| 1080p30 + `--disable-gpu` | 10.3 | 20.2 | 30.0 | −0.3 KB/s | 186.5 | 85.4 |

- **Q1 (libx264 cost): answered, and it is fine.** ~0.85 of a core at 1080p30 with a flat queue.
  Software encode was never going to be the problem on a dedicated core.
- **Q2 (compositor Hz): answered, and it kills this machine class.** The compositor composites at
  ~20 Hz, not 60 — the canvas draws 19–21 fps, screencast delivery lands at ~10 fps, and the pump
  pads to a nominal 30 with duplicates. The stream would encode "30fps" of ~10 fps content.
- **The bottleneck is one pegged core.** During capture one Chrome thread sits at 99.9% while three
  cores idle; `--disable-gpu` (software compositor instead of SwiftShader GL) moves nothing. The
  office render + composite + JPEG path is serial, and a Fly/EPYC core is ~3× too slow for it where
  the M3 is not. **Renting more cores cannot fix a serial bottleneck** — a bigger Fly box buys
  nothing.
- The Air's own `libx264` arm (run B, taken opportunistically, contaminated but directional): ffmpeg
  ~102%, queue +502 KB/s, delivered 22.4 — the Air can't do software encode either, which no longer
  matters given the above.

**Consequence: "rent a small Linux VM" is dead as specified.** The capture's real requirement was
never cores or RAM — it is single-thread speed (or a GPU) for the render. The surviving options,
none of which this increment decides:

1. **Stay on the Air** — the only measured configuration that holds 1080p30. The RAM/thermal
   concerns in _Problem_ stand, but they are now the cheapest problem on the table.
2. **A GPU or high-clock cloud box** — changes the cost class the spec was written to avoid
   (hours of GPU rental, or the few providers selling >4 GHz dedicated cores).
3. **Shrink the render** — 720p halves the pixel work but needs the capture contract changed
   (the 1920×1080 window is pinned by Inc 1 of ADR 157), and quality on stream is the product.
4. **Hetzner CAX (run C)** — still unrun, but ARM server cores are slower single-thread than EPYC;
   nothing in these numbers suggests it passes. Only worth the hour if someone wants the coffin nail.

The rig survives for whoever measures next: `scripts/perf/broadcast-bench.Dockerfile` +
`broadcast-bench.fly.toml` (deploy-by-hand measurement box) and
`broadcast-bench-fixture.sh` (synthetic animated team). Total spend for the hour: well under a
dollar. The one code change it forced is real and keeps: Chrome on any containerised Linux needs
`--no-sandbox --disable-dev-shm-usage` (and a `/usr/bin/chromium` default), or it cannot start at
all — the spec's "no code change required" row was wrong in the way only running it finds.

### Option 3 chosen and measured — 720p25 passes on the same box (amended 2026-07-27)

nick picked **option 3 (shrink the render)** from the list above. Two changes made it real, and a
second rented hour on the identical machine class (Fly `performance-4x`) turned the verdict around:

- **`--resolution 720p`** (PR #407) sizes the whole path — the page's stage itself via `?h=720`
  (a CSS-scaled 1080p render would keep paying the raster cost the rung exists to remove), Chrome's
  window, the viewport override, and the screencast bounds. 1080p stays the ADR 157 default.
- **`everyNthFrame` stopped assuming 60Hz off darwin.** The skip derivation counts *composited*
  frames; this box composites at ~20–26Hz, so `floor(60/fps)=2` threw away half the frames it could
  actually produce. Same render cost, delivery 14 → 26.5fps. `compositorHz()` is now a platform
  fact: 60 on darwin (measured true), 30 elsewhere.

| run (performance-4x, libx264) | delivered | draws | encoded | queue |
| --- | --- | --- | --- | --- |
| 720p30, skip-from-60Hz | 14.0 | 27.6 | 30.0 | flat |
| 720p30, every frame | 26.5 | 25.1 | 30.0 | flat |
| **720p25, every frame** | **27.4** | 26.4 | **25.0** | **0.00 MB peak** |

**720p25 delivers above its encode rate with a flat-zero queue — the first passing configuration on
rentable hardware.** 720p30 lands at ~26 delivered (~12% duplicate padding); acceptable, but 25fps
is honest. Pipeline total ~2.8 cores, so `performance-4x` is also the right size — at the intended
~90h/month of process-lifetime billing that is roughly **$10–12/month**, plus ~$4 egress.

**Increment 1 therefore provisions: Fly `performance-4x` · `--resolution 720p --fps 25` ·
`libx264`.** nick has the 720p-vs-1080p quality samples; his eyeball is the last gate before the
tailnet + stream-key work.

## Increment 1 — provision

Only after Increment 0's remaining questions are answered. Pick the box from the passing candidates,
join it to the tailnet, install the stream key, and reduce going live to a single command. Detail
deferred — writing it now would be designing against estimates, which is the thing this spec exists
to avoid.

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
