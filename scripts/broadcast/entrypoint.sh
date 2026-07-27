#!/usr/bin/env bash
# Hosted broadcast entrypoint: tailnet up → daemon reachable → stream until it ends → exit.
#
# The machine's main process IS the broadcast run (hosting spec decision): exiting here stops the
# machine, so ending the stream is the whole shutdown procedure and billing tracks streamed hours.
#
# Env (set by live.sh / Fly secrets — never baked into the image):
#   TS_AUTHKEY          tailscale auth key (Fly secret; use an ephemeral, tagged key)
#   MUSTERD_STREAM_KEY  Twitch stream key (Fly secret; resolveSink checks this before any Keychain)
#   MUSTERD_AIR_ADDR    the Air's tailnet MagicDNS name or 100.x address
#   MUSTERD_TEAM        team slug (default revive)
#   BROADCAST_ARGS      extra args, e.g. "--duration 14400"
set -euo pipefail

: "${TS_AUTHKEY:?TS_AUTHKEY missing — set it as a Fly secret}"
: "${MUSTERD_STREAM_KEY:?MUSTERD_STREAM_KEY missing — set it as a Fly secret}"
: "${MUSTERD_AIR_ADDR:?MUSTERD_AIR_ADDR missing — the Air tailnet name/IP}"
TEAM="${MUSTERD_TEAM:-revive}"

# Fly machines are real VMs with /dev/net/tun, so tailscaled runs with kernel networking — no
# userspace SOCKS proxy, and Chrome needs no proxy flags. State is a tmpfs path: the node is
# ephemeral by design and must not survive the machine (pair with an ephemeral+reusable auth key).
#
# `--accept-dns=false` is deliberate: Fly owns /etc/resolv.conf (it points at fly's own resolver),
# so MagicDNS never installs and a `*.ts.net` name does not resolve here — the first live run died
# on exactly that, with the tailnet up and the daemon reachable by IP. We resolve through tailscaled
# instead (see below), which needs no DNS at all.
mkdir -p /var/run/tailscale /tmp/tailscale
tailscaled --state=/tmp/tailscale/tailscaled.state >/tmp/tailscale/tailscaled.log 2>&1 &
for _ in $(seq 1 30); do
  tailscale up --authkey="$TS_AUTHKEY" --hostname=musterd-broadcast --accept-dns=false 2>/dev/null && break
  sleep 1
done
tailscale status >/dev/null || { echo "✗ tailscale never came up"; tail -20 /tmp/tailscale/tailscaled.log; exit 1; }

# Ask tailscaled for the peer's address rather than a resolver. Accepts an IP, a MagicDNS short name,
# or a full `host.tailnet.ts.net` (only the first label is meaningful to `tailscale ip`).
resolve_air() {
  case "$1" in
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) printf '%s' "$1"; return 0 ;;
  esac
  tailscale ip -4 "${1%%.*}" 2>/dev/null | head -1
}
AIR_IP="$(resolve_air "$MUSTERD_AIR_ADDR")"
[ -n "$AIR_IP" ] || {
  echo "✗ '$MUSTERD_AIR_ADDR' is not a peer on this tailnet — check the name against \`tailscale status\`"
  tailscale status | head -10
  exit 1
}
SERVER="http://${AIR_IP}:4849"
echo "▸ tailnet up · ${MUSTERD_AIR_ADDR} → ${AIR_IP}"

# The stream dies with the daemon link anyway (spec: accepted risk, the laptop can sleep) — but
# failing loud *before* going live beats a stream that opens on a black stage.
for _ in $(seq 1 30); do
  curl -sf --max-time 2 "$SERVER/health" >/dev/null && break
  sleep 1
done
curl -sf --max-time 2 "$SERVER/health" >/dev/null || {
  echo "✗ daemon unreachable at $SERVER — is the Air awake, tailscale up, and \`tailscale serve\` forwarding 4849?"
  exit 1
}

# Warm chromium once: the first launch in a fresh container builds font/GPU caches and can miss the
# capturer's 10s CDP window (learned on the bench box).
timeout 15 "$CHROME_BIN" --headless=new --no-sandbox --disable-dev-shm-usage \
  --user-data-dir=/tmp/chrome-warm about:blank >/dev/null 2>&1 || true

# This loop is the whole reason the entrypoint no longer `exec`s the stream.
#
# ADR 159 keeps a long-lived stream current: when the daemon is rebuilt underneath it, the stream
# restarts on the new code. On a laptop it does that by spawning a DETACHED replacement and exiting,
# so the shell prompt returns. Under `exec` here, that same move killed the machine — this process
# is the VM's main process, so its exit made Fly's init tear the box down one second after the
# replacement started streaming. Both hosted runs on 2026-07-27 died that way (4 min and 6 min; the
# second was ended by a docs-only merge, since the ADR 152 auto-refresher bounces the daemon for any
# commit at all).
#
# So the container supervises instead: MUSTERD_BROADCAST_SUPERVISED tells the stream not to fork but
# to exit RESTART_EXIT_CODE (75), and we run it again. Bash stays the main process throughout, so the
# machine's lifetime is the LOOP's lifetime, not one stream generation's — and the replacement is a
# genuinely fresh `node` on the rebuilt dist, which is what ADR 159 §4 decided (a full restart, not a
# page reload).
#
# Any other exit code still ends the machine, so `stream stop`, --duration, the stall watchdog and a
# real failure all keep tearing the box down exactly as before — billing still tracks streamed hours.
export MUSTERD_BROADCAST_SUPERVISED=1
RESTART_EXIT_CODE=75

# A restart loop needs a floor: if the daemon is flapping its build ref, a stream that relaunches
# instantly would spin and bill for nothing while never showing a viewer a frame.
RESTART_MIN_INTERVAL=10

while :; do
  started=$SECONDS
  # The measured passing configuration — change it in the spec before changing it here.
  set +e
  # BROADCAST_ARGS is a flag STRING ("--duration 14400"), so the splitting is the point.
  # shellcheck disable=SC2086
  node /app/packages/cli/dist/bin.js broadcast \
    --team "$TEAM" \
    --server "$SERVER" \
    --twitch \
    --resolution 720p \
    --fps 25 \
    --encoder libx264 \
    ${BROADCAST_ARGS:-}
  code=$?
  set -e

  [ "$code" -eq "$RESTART_EXIT_CODE" ] || exit "$code"

  elapsed=$((SECONDS - started))
  if [ "$elapsed" -lt "$RESTART_MIN_INTERVAL" ]; then
    sleep $((RESTART_MIN_INTERVAL - elapsed))
  fi
  echo "▸ restarting the stream on the rebuilt daemon code (ran ${elapsed}s)"
done
