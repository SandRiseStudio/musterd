# Stream the office from a rented box (hosted broadcast)

> **Audience:** the operator moving `musterd broadcast` off their laptop onto a rented Linux machine
> whose lifetime is the stream's lifetime. **Design:** the hosting spec
> (`../superpowers/specs/2026-07-26-broadcast-hosting-design.md`) — measure-first; the configuration
> below is the one that passed (720p25 · libx264 · Fly `performance-4x`, 2026-07-27). **Topology:**
> ADR 039 B — a Tailscale overlay supplies reachability and encryption; musterd writes none of it.

## Shape

- **The daemon stays where it is**, loopback-bound. `tailscale serve` forwards it onto the tailnet,
  so nothing about the daemon or its LaunchAgent changes.
- **The rented machine's main process is the entrypoint's supervisor loop**, and the stream runs
  inside it. Ending the stream (stop, Ctrl-C semantics, the ADR 159 stall watchdog, `--duration`)
  exits the loop, and `--rm` destroys the machine — billing tracks streamed hours (~$10–12/mo
  at ~90h). The loop exists for one case: ADR 159 restarts a stream when the daemon is rebuilt
  under it, and on a laptop it does that by leaving a detached replacement and exiting. Here that
  exit _is_ the machine's exit, so the stream signals `75` instead and the loop runs it again.
- **No Docker on the operator's machine** — images build on Fly's remote builders.
- **Secrets are Fly secrets** (`TS_AUTHKEY`, `MUSTERD_STREAM_KEY`), set by the operator directly so
  they never pass through an agent, a script argument, or the repo.

## Start here

```sh
musterd stream doctor
```

It checks every precondition below against the _running_ system and prints the exact repair for each
one that is missing. Run it before anything else, and again after each fix. It exists because all of
these failures present identically — "the broadcast page never reported ready" — which points nowhere
near the cause and cost four launches on the first day.

Once it is green:

```sh
musterd stream build     # only after broadcast-relevant code changes
musterd stream start     # go live (discovers this machine's tailnet address itself)
musterd stream status
musterd stream stop      # ends the stream; the machine self-destructs, which ends the billing
```

`musterd broadcast` is the sibling verb that captures on **this** machine; `musterd stream` runs that
same capture on a rented one. (`scripts/broadcast/live.sh` still works — it forwards here.)

## One-time setup (operator)

The doctor names whichever of these is missing, with the command; they are written out here for
context.

1. **Tailscale on the daemon's machine** — install the app, sign in, then forward the daemon onto
   the tailnet (daemon stays loopback-bound):

   ```sh
   tailscale serve --bg --tcp 4849 tcp://127.0.0.1:4849
   ```

   Note the machine's MagicDNS name (`tailscale status` — e.g. `nicks-air.tailnet-name.ts.net`).

2. **Allow the tailnet host on the daemon.** The ADR 040 upgrade gate accepts a WebSocket only from
   a loopback `Host`, the bound host, or `MUSTERD_ALLOWED_HOSTS` — and the capture page is served
   over the tailnet address, so without this the firehose upgrade is refused with
   `ws_upgrade_rejected: host not allowed` and the page never reaches `live`. Add the tailnet IP and
   name to the daemon's environment — both, since the container resolves the daemon by IP (Fly owns
   `/etc/resolv.conf`, so MagicDNS never installs) while a browser would send the name:

   ```sh
   musterd service install --allowed-hosts 100.x.y.z,your-box.tailnet-name.ts.net
   ```

   > This is a real daemon change. An earlier draft of the design claimed topology B needed none;
   > the first live run disproved it. `musterd stream doctor` tests it by attempting a real
   > WebSocket upgrade against the _running_ daemon with that `Host` — not by reading the LaunchAgent
   > plist, because on 2026-07-27 a `launchctl bootstrap` silently didn't take and for two minutes
   > the plist said allow-listed while the daemon answered 403.

3. **A tailnet auth key for the box** — admin console → Settings → Keys → generate an **ephemeral,
   reusable** key (ephemeral: dead nodes vanish from the tailnet; reusable: every stream is a fresh
   node). Consider a tag with an ACL that only allows reaching the daemon's port.

4. **The Fly app + secrets:**

   ```sh
   fly apps create musterd-broadcast --org personal
   fly secrets set -a musterd-broadcast TS_AUTHKEY=<key> MUSTERD_STREAM_KEY=<twitch key> --stage
   ```

5. **Build the image** (repeat only after broadcast-relevant code changes):

   ```sh
   musterd stream build
   ```

   `build` records the digest it pushed and `start` runs exactly that. Running the `:capture` tag
   instead looked equivalent and was not: a rebuilt tag resolved to the _previous_ digest, and two
   machines silently streamed stale code while the fix sat in the registry.

## Streaming

```sh
musterd stream start     # go live — discovers this machine's tailnet address itself
musterd stream status    # ◉ live / ○ not live
musterd stream stop      # end stream; machine self-destroys
```

`--team <slug>` picks the team to render (defaults to `MUSTERD_TEAM`), `--app <name>` a second Fly
app, `--args "<flags>"` passes extra flags through to the capture process.

`fly logs -a musterd-broadcast` tails the run (tailscale up → daemon health check → chromium warm →
the ffmpeg stats line every 10s).

## Failure modes, recorded

- **A merge to `main` used to end the stream** (fixed 2026-07-27, but worth knowing the shape). The
  ADR 152 auto-refresher rebuilds the daemon for _any_ commit; ADR 159 then restarts the stream on
  the new code by spawning a detached replacement and exiting — correct on a laptop, fatal here,
  because `entrypoint.sh` `exec`'d the stream so its exit destroyed the VM one second after the
  replacement began streaming. Both of the first two hosted runs died this way, at 4 and 6 minutes;
  the second was ended by a **docs-only** merge. The entrypoint now supervises instead of `exec`ing.
  If you see a machine end within seconds of a merge, check that the running image contains the
  loop — an image built before this change still has the old `exec`.
- **The laptop sleeps mid-stream** → Chrome loses the page, the ADR 159 watchdog ends the stream,
  the machine destroys itself. Accepted in the spec; the trigger to revisit topology A (move the
  daemon).
- **`start` says the daemon is unreachable** → the entrypoint refuses to open a stream on a black
  stage. Check the Air is awake, `tailscale status` on both ends, and the `tailscale serve` forward.
- **Stream key rotation** → `fly secrets set -a musterd-broadcast MUSTERD_STREAM_KEY=<new>`;
  next `start` picks it up. The Keychain copy on the laptop is independent and still serves local
  `musterd broadcast` runs.
