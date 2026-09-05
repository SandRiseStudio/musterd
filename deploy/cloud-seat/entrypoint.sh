#!/bin/bash
# Cloud seat entrypoint — the ROOT phase, every boot, idempotent (cloud-seats design, increment 1;
# rescoped 2026-09-03: the VM is a JOINER daemon, not a thin client — ADR 325 / 376; least
# privilege 2026-09-05 — ADR 390).
#
# This script does the one thing on the machine that needs root — bring the tailnet up (kernel
# networking wants /dev/net/tun and the tailscaled socket) — then hands the machine to seat.sh as
# the unprivileged `seat` user. The daemon, git, gh, the wake actuator and the woken `claude -p`
# never run as root. tailscaled stays behind as the sole root process.
#
# Non-secret env (fly.toml): MUSTERD_TEAM, MUSTERD_HUB (+ MUSTERD_HUB_PORT), TAILSCALE_HOSTNAME_PREFIX,
# TAILSCALE_ADVERTISE_TAGS (optional; a tagged auth key applies its tag without it).
# Secrets (`fly secrets set`, never in the image or repo):
#   TAILSCALE_AUTHKEY     single-use tailnet auth key — consumed on first boot only; scrubbed here
#   MUSTERD_SEAT          the seat this machine hosts (an agent already on the roster)
#   MUSTERD_INVITE        `msinv_…` from `musterd node invite` on the hub — consumed on first boot
#   GH_TOKEN              a FINE-GRAINED token scoped to the work repo + the roster repo (README)
#   ANTHROPIC_API_KEY  or  CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token` on a Max account)
# Refused: MUSTERD_AGENT_KEY. The hub's team agent key is daemon-private and must not be on this
# machine (docs/perf/cloud-seat.md finding 3); the joiner mints its own. Boot stops if it is set.
#
# Order matters and each step is a no-op once done: tailnet → (drop root) → daemon → team → enroll
# → seat → wake.
set -euo pipefail

: "${MUSTERD_TEAM:?}" "${MUSTERD_HUB:?}" "${MUSTERD_SEAT:?}"
HOME="${HOME:-/data/home}"
export HOME
SEAT_USER=seat
mkdir -p "$HOME/.musterd" /data/tailscale /run/tailscale
LOG_DIR=/data/log
mkdir -p "$LOG_DIR"

log() { printf '%s cloud-seat: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# ── 0. what must NOT be here ──────────────────────────────────────────────────────────────────────
# The hub's team agent key on a joiner is the over-grant the first boot found and the runbook
# removed; a stale `fly secrets set` can put it back silently. Refuse to boot rather than hold it.
if [ -n "${MUSTERD_AGENT_KEY:-}" ]; then
  log "REFUSING TO BOOT: MUSTERD_AGENT_KEY is set. The hub's team agent key must not be on this machine"
  log "(the joiner mints its own — README §Create). Fix: fly secrets unset MUSTERD_AGENT_KEY --app <app>"
  exit 1
fi

# ── 1. tailnet ────────────────────────────────────────────────────────────────────────────────────
# Fly machines are real VMs with /dev/net/tun, so tailscaled runs with kernel networking (the
# broadcast image proved this — scripts/broadcast/entrypoint.sh). State lives on the volume, so the
# node keeps its tailnet identity across redeploys and the auth key is spent once, on first boot.
mkdir -p /var/run/tailscale
tailscaled --state=/data/tailscale/tailscaled.state >"$LOG_DIR/tailscaled.log" 2>&1 &
for _ in $(seq 1 60); do tailscale status >/dev/null 2>&1 && break; sleep 1; done
if ! tailscale status >/dev/null 2>&1; then
  set +x
  # A tagged auth key applies its tag by itself; TAILSCALE_ADVERTISE_TAGS is for a tailnet that
  # wants the node to ask for it explicitly (README §Tailnet policy).
  TS_TAGS=()
  [ -z "${TAILSCALE_ADVERTISE_TAGS:-}" ] || TS_TAGS=(--advertise-tags="$TAILSCALE_ADVERTISE_TAGS")
  for _ in $(seq 1 10); do
    tailscale up --authkey="${TAILSCALE_AUTHKEY:?first boot needs TAILSCALE_AUTHKEY}" \
      --hostname="${TAILSCALE_HOSTNAME_PREFIX:-musterd-seat}-${MUSTERD_SEAT}" --accept-dns=false \
      "${TS_TAGS[@]}" 2>/dev/null && break
    sleep 2
  done
fi
tailscale status >/dev/null || { log "tailscale never came up"; tail -20 "$LOG_DIR/tailscaled.log"; exit 1; }

# Ask tailscaled for the hub's address rather than a resolver (MagicDNS is off: --accept-dns=false).
# MUSTERD_HUB is the laptop's tailnet name (or IP); the hub URL is built from the resolved IP, which
# the laptop daemon's ADR 040 allow-list admits alongside the name (`musterd service status`).
resolve_peer() {
  case "$1" in
    [0-9]*.[0-9]*.[0-9]*.[0-9]*) printf '%s' "$1"; return 0 ;;
  esac
  tailscale ip -4 "${1%%.*}" 2>/dev/null | head -1
}
HUB_IP="$(resolve_peer "$MUSTERD_HUB")"
[ -n "$HUB_IP" ] || { log "'$MUSTERD_HUB' is not a peer on this tailnet"; tailscale status | head -10; exit 1; }
MUSTERD_HUB_URL="http://${HUB_IP}:${MUSTERD_HUB_PORT:-4849}"
for _ in $(seq 1 30); do curl -sf --max-time 2 "$MUSTERD_HUB_URL/health" >/dev/null && break; sleep 1; done
curl -sf --max-time 2 "$MUSTERD_HUB_URL/health" >/dev/null \
  || log "hub unreachable at $MUSTERD_HUB_URL — is the laptop awake and \`tailscale serve\` forwarding 4849? (continuing: a joiner keeps its coordination layer offline, ADR 325)"
log "tailnet up · $MUSTERD_HUB → $HUB_IP"

# The auth key was spent on first boot (state on the volume); it must not ride into the seat's
# environment where a woken model could read it. The invite is consumed by seat.sh step 4 and is
# scrubbed there, before the actuator starts.
unset TAILSCALE_AUTHKEY

# ── 1b. drop root ─────────────────────────────────────────────────────────────────────────────────
# Everything under /data that is the seat's belongs to the seat: HOME (SQLite, config, node.json,
# bindings, ~/.claude.json), the repo + workspace, the logs. tailscale's state stays root's. The
# chown is a no-op after the first boot on this image; on a volume from the root-era image it is
# the one-time migration. `setpriv` (util-linux) is the exec-and-drop: no setuid helper, no
# inheritable capabilities, the seat's own supplementary groups.
for d in "$HOME" /data/musterd /data/musterd-"$MUSTERD_SEAT" "$LOG_DIR"; do
  [ -e "$d" ] || continue
  if [ "$(stat -c %U "$d")" != "$SEAT_USER" ]; then
    log "chown $d → $SEAT_USER (one-time)"
    chown -R "$SEAT_USER:$SEAT_USER" "$d"
  fi
done
log "dropping root → $SEAT_USER (tailscaled stays root; nothing else does)"
exec setpriv --reuid="$SEAT_USER" --regid="$SEAT_USER" --init-groups --inh-caps=-all \
  env HOME="$HOME" HUB_IP="$HUB_IP" LOG_DIR="$LOG_DIR" \
  bash /app/deploy/cloud-seat/seat.sh
