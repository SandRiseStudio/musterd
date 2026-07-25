# 159 — Long-lived processes: stopping, and staying current

- Status: accepted
- Date: 2026-07-25

## Context

ADR 157 shipped `musterd broadcast` as a foreground command and deferred LaunchAgent supervision,
pre-registering the evidence that would justify revisiting it: "every operator intervention (a
restart, a reconnect)". Its first-real-stream findings closed with "LaunchAgent supervision and the
Fly encoder both remain unjustified by this run."

On 2026-07-25 the first intervention arrived, and it was not a small one. A
`musterd broadcast --team revive --twitch` process had been running **10h54m**. Stopping it needed
`SIGKILL`: `SIGINT` killed its children but left them `<defunct>`, and `SIGTERM` was swallowed. It
had also left **23 Chrome profile directories, 837 MB**, under `$TMPDIR`, and had streamed a build
that was ~11 hours and one merged PR out of date for its entire run.

The currency half of that is not specific to broadcast. The daemon refreshes itself (ADR 152) and
`/live` republishes itself (ADR 132), but `service refresh` rebuilds the **whole shared checkout**
and then bounces only the daemon's own label — so the wake actuator has always kept running whatever
code it booted with, with "run `musterd service restart --wake` by hand" as the documented remedy.
That is a currency policy that depends on somebody remembering.

## Problem

Three distinct failures, one incident.

**Stopping did not stop.** The frame pump wrote into ffmpeg's stdin and ignored the return value —
correct while ffmpeg is briefly behind, because dropping a frame permanently slows the `image2pipe`
timeline. But nothing bounded "briefly". A wedged or merely slow encoder let the queue grow with no
ceiling until the heap took the event loop down, and a stalled loop explains every symptom at once:
`SIGCHLD` is reaped through the loop, so children stayed `<defunct>`; the force-stop backstop is
`unref()`'d, so it only fires if the loop turns; and a signal with a JS listener is delivered through
the loop, so `SIGTERM` was swallowed too.

Three latent defects sat behind the same path. `anullsrc` is an infinite input and there was no
`-shortest`, so closing stdin never made ffmpeg exit — **the graceful stop was unreachable in every
run that ever happened**, and every file capture came out with no moov atom. The child `exit`
listeners were registered after up to 40 s of startup awaits, so a child dying in that window fired
into no listener and the command hung forever. And the CDP socket had no `onclose`/`onerror`, so
pending calls could only ever be settled by a reply — making `waitBroadcastReady`'s "30 s timeout" a
deadline that was only tested between settled awaits.

**Profiles leaked.** The `mkdtemp` profile was removed only on the normal return path. Every forced
stop reaches `process.exit()` without unwinding, so exactly the runs that ended badly leaked ~150 MB
each, and nothing ever swept what was already there.

**Nothing kept a long-lived process current.** A stream is the one musterd surface that can run for a
day, and it had no currency mechanism at all — nor did the wake actuator.

## Decision

**1. Bound the queue, and end loudly rather than hang.** The write policy becomes an exported
function with a ceiling (`STALL_BYTES`). Past it, stop feeding and take the force path. The ceiling
is sized from measurement, not intuition — see Observability below.

**2. Make the stop path reachable.** Add `-shortest` so closing stdin actually ends ffmpeg; capture
both children's exits at spawn and race them against startup; give the CDP layer `onclose`/`onerror`
rejection and a per-call timeout, and close it in cleanup.

**3. Sweep profiles at both ends.** Remove the profile in the `process.on('exit')` sweep, and
age-gate a sweep of stale ones at startup — the only thing that recovers ground already lost.

**4. A long-lived process watches the daemon's build and restarts itself.** The broadcast polls
`/health.build` and compares it to **the daemon's build as observed at that stream's start**, not to
its own stamp. When it changes, the shared checkout has been rebuilt underneath it: tear down
gracefully, then re-exec.

Comparing against the daemon-over-time rather than against our own stamp is the load-bearing choice.
Comparing our stamp to the daemon's would restart forever for anyone running a branch build, because
those never match and never will.

A full restart, not a page reload. Reloading would keep the RTMP session alive and never interrupt
viewers, but it refreshes only the web bundle — the capture pipeline in this process would stay
stale, which is half a fix wearing the costume of a whole one.

**5. `service refresh` bounces every agent running from the checkout it rebuilt.** Only agents that
are installed and resolve to _that_ checkout, and advisory: a sibling that will not bounce must not
fail a daemon refresh that already succeeded.

**Not decided here: LaunchAgent supervision for broadcast.** ADR 157's deferral stands. The incident
justified _currency_ and a working stop, both of which are process-local; it did not justify a
login-time agent that streams unattended.

## Consequences

Ctrl-C works, and now produces a valid container instead of a truncated one. A stream picks up new
code within a poll of the daemon bouncing. The wake actuator stops silently drifting.

A stream can now **end on its own** when the encoder falls far enough behind. That is a new
behaviour and a deliberate one: previously the same condition ended in a hung process needing
`SIGKILL`, so the change is from silent death to a diagnostic. It does mean a sufficiently loaded
machine will end a long stream — see the measurement below, which is the more important finding.

The re-exec leaves the replacement detached, so the shell prompt returns while the stream continues.
Ctrl-C therefore stops working across a restart. That is a real regression in the documented stop and
the reason a run-state file plus a `--stop` affordance is named as the follow-up rather than
shrugged at.

## Observability & Evaluation

**Traces.** No new instrumentation: ffmpeg's `-stats` line every 10 s already carries the truth
(`speed=`, frame count), `/health.build` already publishes the daemon's build (ADR 130), and the
startup line now prints the baseline build the stream is pinned to, so a glance says which code is on
air. The stall message names the cause and the remedy rather than a byte count alone.

**Eval.** The stop path is verified end-to-end, not by hand as the previous hardening was: a real
capture, a real `SIGINT`. Baseline (before) → result (after):

|                                | before                         | after                        |
| ------------------------------ | ------------------------------ | ---------------------------- |
| `SIGINT` during a live capture | never exited; needed `SIGKILL` | exits in ~1 s, code 0        |
| children after the stop        | both `<defunct>`               | none                         |
| the captured file              | no moov atom                   | valid, plays                 |
| a 10 s capture                 | —                              | exactly 300 frames at 30 fps |
| profiles on disk               | 23 dirs, 837 MB                | 0                            |

The stall ceiling and the restart predicate are exported and unit-tested against the same code the
command runs; both test sets were confirmed to fail against the previous logic rather than passing
vacuously.

**The measurement that matters, and it was a surprise.** Instrumenting a live capture showed the
ffmpeg stdin queue climbing 7.9 → 23.6 → 38.0 → 55.8 MB in twelve seconds — ~4.7 MB/s, essentially
the entire input rate, meaning ffmpeg was draining almost nothing. A 140 s capture on the same
machine reported **`speed=0.81x`**: 2 m 53 s of wall clock to encode 140 s of video. On a loaded
machine this pipeline does not sustain 30 fps, and a stream that runs below 1× falls behind
continuously for as long as it runs. That is the `speed < 1x` condition ADR 157 already named as the
thing to watch, and it is the most plausible reading of what actually killed the 11-hour stream: not
a wedged ingest, just a slow encoder with nothing bounding the backlog.

The first ceiling tried (64 MB, ~12 s of slack) ended a healthy capture within seconds, which is how
the 256 MB figure was chosen — generous enough that a monorepo build running alongside does not end a
stream, while still making the queue _bounded_, which is the property that stops a hang.

**Experiment.** The open question this hands forward is not answered here: **can this pipeline hold
1× on an unloaded machine, and at what fps?** The falsifier is direct — run a capture with nothing
else on the box and read `speed=`. If it sits below 1× there too, the input rate is wrong and the
answer is a lower default fps or a cheaper frame path, not a bigger buffer. Until that is measured,
the stall watchdog is a diagnostic, not a fix.
