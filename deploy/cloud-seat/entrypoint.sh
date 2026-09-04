#!/bin/bash
# Cloud seat entrypoint — every boot, idempotent (cloud-seats design, increment 1; rescoped
# 2026-09-03: the VM is a JOINER daemon, not a thin client — ADR 325 / 376).
#
# Non-secret env (fly.toml): MUSTERD_TEAM, MUSTERD_HUB (+ MUSTERD_HUB_PORT), TAILSCALE_HOSTNAME_PREFIX.
# Secrets (`fly secrets set`, never in the image or repo):
#   TAILSCALE_AUTHKEY     single-use tailnet auth key — consumed on first boot only
#   MUSTERD_SEAT          the seat this machine hosts (an agent already on the roster)
#   MUSTERD_AGENT_KEY     the team agent key (`musterd team agent-key --show` on the hub)
#   MUSTERD_INVITE        `msinv_…` from `musterd node invite` on the hub — consumed on first boot
#   GH_TOKEN              a fine-grained token that can clone + push the work repo
#   ANTHROPIC_API_KEY  or  CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token` on a Max account)
#
# Order matters and each step is a no-op once done: tailnet → daemon → team → enroll → seat → wake.
set -euo pipefail

: "${MUSTERD_TEAM:?}" "${MUSTERD_HUB:?}" "${MUSTERD_SEAT:?}"
HOME="${HOME:-/data/home}"
export HOME
mkdir -p "$HOME/.musterd" /data/tailscale /run/tailscale
LOG_DIR=/data/log
mkdir -p "$LOG_DIR"

log() { printf '%s cloud-seat: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# ── 1. tailnet ────────────────────────────────────────────────────────────────────────────────────
# Fly machines are real VMs with /dev/net/tun, so tailscaled runs with kernel networking (the
# broadcast image proved this — scripts/broadcast/entrypoint.sh). State lives on the volume, so the
# node keeps its tailnet identity across redeploys and the auth key is spent once, on first boot.
mkdir -p /var/run/tailscale
tailscaled --state=/data/tailscale/tailscaled.state >"$LOG_DIR/tailscaled.log" 2>&1 &
for _ in $(seq 1 30); do tailscale status >/dev/null 2>&1 && break; sleep 1; done
if ! tailscale status >/dev/null 2>&1; then
  set +x
  for _ in $(seq 1 10); do
    tailscale up --authkey="${TAILSCALE_AUTHKEY:?first boot needs TAILSCALE_AUTHKEY}" \
      --hostname="${TAILSCALE_HOSTNAME_PREFIX:-musterd-seat}-${MUSTERD_SEAT}" --accept-dns=false 2>/dev/null && break
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

# ── 2. the daemon (this machine's own; a replica — ADR 325) ───────────────────────────────────────
# Loopback-bound: nothing on this machine is reached from outside; it dials the hub. SQLite lives
# on the volume via MUSTERD_DB (Dockerfile).
musterd serve --port 4849 --host 127.0.0.1 >>"$LOG_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 60); do curl -fsS -m 2 http://127.0.0.1:4849/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -m 2 http://127.0.0.1:4849/health >/dev/null || { log "daemon did not come up — see $LOG_DIR/daemon.log"; exit 1; }
log "daemon up (pid $DAEMON_PID)"

# ── 3. the team, locally ──────────────────────────────────────────────────────────────────────────
# A joiner holds the team under the same slug before it enrolls (node-enroll-http.test.ts stands
# its joiner up the same way). Roster identity converges via the git-exported roster (ADR 058):
# the team home is cloned from ROSTER_REPO when set, otherwise created bare and reconciled from
# whatever the hub's events carry. Which of those the dogfood needs is P4's first finding.
TEAM_HOME="$HOME/musterd/$MUSTERD_TEAM"
if [ ! -d "$TEAM_HOME/.musterd" ]; then
  mkdir -p "$(dirname "$TEAM_HOME")"
  if [ -n "${ROSTER_REPO:-}" ]; then
    gh repo clone "$ROSTER_REPO" "$TEAM_HOME"
  else
    mkdir -p "$TEAM_HOME"
  fi
  ( cd "$TEAM_HOME" && musterd team create "$MUSTERD_TEAM" --as nick ) || log "team create: already present or refused — continuing"
fi

# ── 4. enroll at the hub (first boot only; ~/.musterd/node.json is the proof) ─────────────────────
if ! grep -q "\"$MUSTERD_TEAM\"" "$HOME/.musterd/node.json" 2>/dev/null; then
  set +x
  ( cd "$TEAM_HOME" && musterd node join "$MUSTERD_HUB_URL" "${MUSTERD_INVITE:?first boot needs MUSTERD_INVITE}" )
  log "enrolled at $MUSTERD_HUB_URL"
fi

# ── 5. the seat's workspace ───────────────────────────────────────────────────────────────────────
# The seat is an ordinary Member (spec §spine 2) that already exists on the roster; this machine
# just gives it a workspace, wired for claude-code, and the team agent key it provisions with.
WORKSPACE="/data/agents-$MUSTERD_SEAT"
if [ ! -d "$WORKSPACE/.git" ]; then
  gh auth setup-git >/dev/null 2>&1 || true
  gh repo clone SandRiseStudio/musterd "$WORKSPACE"
fi
if [ ! -f "$WORKSPACE/.musterd/binding.json" ] && [ ! -f "$WORKSPACE/.claude/musterd.json" ]; then
  set +x
  musterd team agent-key --key "${MUSTERD_AGENT_KEY:?}" >/dev/null
  ( cd "$WORKSPACE" && musterd agent "$MUSTERD_SEAT" --harness claude-code --here )
fi
( cd "$WORKSPACE" && pnpm install --frozen-lockfile >>"$LOG_DIR/workspace-install.log" 2>&1 ) || log "workspace pnpm install failed — see $LOG_DIR/workspace-install.log"

# ── 6. residency (ADR 131): what makes the seat wakeable HERE ─────────────────────────────────────
# `residency on` lands the standing resume grant in the workspace binding and registers the
# workspace in this machine's host registry — the list `musterd host` polls for. Admin-authorized:
# the creator credential minted by `team create` above is this machine's admin. Idempotent.
( cd "$WORKSPACE" && musterd residency on --as nick --seat "$MUSTERD_SEAT" ) \
  || log "residency on refused — the seat is not wakeable on this machine until it succeeds (P4 finding)"

# ── 7. the wake actuator (ADR 131) — the machine's life is this process ───────────────────────────
# No systemd in a Fly container: the entrypoint IS the supervisor. If the daemon dies the actuator's
# polls fail loudly and Fly's restart policy (fly.toml has none → the machine stays up, the log
# says why) makes the failure visible instead of silently rebooting into the same state.
log "wake actuator starting for seat $MUSTERD_SEAT"
exec musterd host --interval 30 --timeout 600 >>"$LOG_DIR/host.log" 2>&1
