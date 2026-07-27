#!/usr/bin/env bash
# Go live from the rented box — the Increment 1 "single command" (hosting spec).
#
#   scripts/broadcast/live.sh build    # build+push the image on Fly's builders (first time / after code changes)
#   scripts/broadcast/live.sh start    # boot a machine that streams; it destroys itself when the stream ends
#   scripts/broadcast/live.sh status   # is anything live?
#   scripts/broadcast/live.sh stop     # end the stream (graceful SIGINT → machine exits & self-destroys)
#
# Nothing here touches Docker locally — builds run on Fly's remote builders, and the container only
# ever runs on the rented machine. One-time setup (operator-only, secrets never pass through here):
#
#   fly apps create musterd-broadcast --org personal
#   fly secrets set -a musterd-broadcast TS_AUTHKEY=<ephemeral+reusable tailscale key> \
#                                        MUSTERD_STREAM_KEY=<twitch key> --stage
#
# Machine lifetime = stream lifetime: `--rm` destroys the machine when its process exits, so `stop`,
# Ctrl-C on the stream, the ADR 159 stall watchdog, or --duration all end the billing too.
set -euo pipefail

APP="${BROADCAST_APP:-musterd-broadcast}"
AIR="${MUSTERD_AIR_ADDR:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# `build` records the digest it pushed and `start` runs exactly that. Running the `:capture` tag
# instead looked equivalent and was not: a rebuilt tag resolved to the PREVIOUS digest, and two
# machines silently streamed month-old code while the fix sat in the registry. A digest cannot be
# stale by construction.
DIGEST_FILE="$ROOT/scripts/broadcast/.image-digest"

live_machine() {
  fly machine list -a "$APP" --json 2>/dev/null |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const m of JSON.parse(s||'[]'))if(m.state==='started')console.log(m.id)})"
}

case "${1:-}" in
  build)
    # --build-only pushes to the app registry without creating machines.
    # The config is only there to satisfy validation — see hosted.fly.toml.
    out="$(cd "$ROOT" && fly deploy . -a "$APP" -c scripts/broadcast/hosted.fly.toml \
      --build-only --push --remote-only --image-label capture 2>&1 | tee /dev/stderr)"
    digest="$(printf '%s' "$out" | grep -oE 'capture@sha256:[a-f0-9]{64}' | tail -1 | cut -d@ -f2-)"
    [ -n "$digest" ] || { echo "✗ could not read the pushed digest from the build output" >&2; exit 1; }
    printf '%s\n' "$digest" >"$DIGEST_FILE"
    echo "▸ built $digest — recorded for \`start\`"
    ;;
  start)
    [ -n "$AIR" ] || { echo "✗ set MUSTERD_AIR_ADDR to the Air's tailnet name (e.g. nicks-air.tailnet.ts.net)" >&2; exit 2; }
    existing="$(live_machine)"
    [ -z "$existing" ] || { echo "already live (machine $existing) — live.sh stop first" >&2; exit 1; }
    [ -s "$DIGEST_FILE" ] || { echo "✗ no built image recorded — run \`live.sh build\` first" >&2; exit 2; }
    IMAGE="registry.fly.io/$APP:capture@$(cat "$DIGEST_FILE")"
    fly machine run "$IMAGE" -a "$APP" \
      --vm-size performance-4x \
      --region sjc \
      --rm \
      --restart no \
      --env MUSTERD_AIR_ADDR="$AIR" \
      --env MUSTERD_TEAM="${MUSTERD_TEAM:-revive}" \
      ${BROADCAST_ARGS:+--env BROADCAST_ARGS="$BROADCAST_ARGS"}
    echo "▸ live — watch: fly logs -a $APP · end: scripts/broadcast/live.sh stop"
    ;;
  status)
    m="$(live_machine)"
    [ -n "$m" ] && echo "● live (machine $m)" || echo "○ not live"
    ;;
  stop)
    m="$(live_machine)"
    [ -n "$m" ] || { echo "○ nothing live"; exit 0; }
    # SIGINT is the broadcast CLI's graceful stop (ADR 159): ffmpeg finalizes, Chrome exits, the
    # process ends, and --rm destroys the machine.
    fly machine stop "$m" -a "$APP" --signal SIGINT --timeout 30
    echo "▸ stopped $m (machine self-destroys)"
    ;;
  *)
    echo "usage: $0 build|start|status|stop" >&2
    exit 2
    ;;
esac
