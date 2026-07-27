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
SERVER="http://${MUSTERD_AIR_ADDR}:4849"

# Fly machines are real VMs with /dev/net/tun, so tailscaled runs with kernel networking — no
# userspace SOCKS proxy, and Chrome needs no proxy flags. State is a tmpfs path: the node is
# ephemeral by design and must not survive the machine (pair with an ephemeral+reusable auth key).
mkdir -p /var/run/tailscale /tmp/tailscale
tailscaled --state=/tmp/tailscale/tailscaled.state >/tmp/tailscale/tailscaled.log 2>&1 &
for _ in $(seq 1 30); do
  tailscale up --authkey="$TS_AUTHKEY" --hostname=musterd-broadcast --accept-dns=true 2>/dev/null && break
  sleep 1
done
tailscale status >/dev/null || { echo "✗ tailscale never came up"; tail -20 /tmp/tailscale/tailscaled.log; exit 1; }

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

# The measured passing configuration — change it in the spec before changing it here.
# shellcheck disable=SC2086
exec node /app/packages/cli/dist/bin.js broadcast \
  --team "$TEAM" \
  --server "$SERVER" \
  --twitch \
  --resolution 720p \
  --fps 25 \
  --encoder libx264 \
  ${BROADCAST_ARGS:-}
