#!/usr/bin/env bash
# Stand up a synthetic, *animated* team for capture benchmarking, and leave it running.
#
#   scripts/perf/broadcast-bench-fixture.sh up     # daemon + seats + act driver
#   scripts/perf/broadcast-bench-fixture.sh down
#
# Then measure against it:
#   node scripts/perf/broadcast-baseline.mjs --team bench --server http://127.0.0.1:4877 \
#     --encoder libx264 --secs 60 --label "…"
#
# Two things here are load-bearing, both learned the expensive way:
#
#   * **The room must be moving.** The office loop parks after ~6 frames on an idle room, and every
#     draw metric then reads 0 while looking like a successful run. So a driver posts an act every
#     few seconds, from a rotating seat, for as long as the fixture is up.
#   * **It is synthetic, never a copy of the live DB.** A `.backup` of the real team would be easier
#     and puts real message content on a rented machine. Seats are seeded from nothing instead.
#
# Everything is scoped by env (MUSTERD_DB / MUSTERD_PORT / MUSTERD_SERVER / MUSTERD_CONFIG) so this
# cannot reach a real daemon — see the MUSTERD_SERVER note below for why that is not optional.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BENCH="${BENCH_ROOT:-${TMPDIR:-/tmp}/musterd-bench}"
PORT="${BENCH_PORT:-4877}"
TEAM="${BENCH_TEAM:-bench}"
SEATS="${BENCH_SEATS:-6}"
BEAT="${BENCH_BEAT:-3}" # seconds between acts

export MUSTERD_DB="$BENCH/bench.db"
export MUSTERD_PORT="$PORT"
export MUSTERD_WEB_ROOT="$ROOT/packages/web/dist/client" # note /client
SERVER="http://127.0.0.1:$PORT"
# Without this, every CLI call resolves its server from ~/.musterd/config.json and talks to the REAL
# daemon on :4849 — which is how the first run of this script seeded two junk teams into the live DB
# that the CLI then had no command to remove. MUSTERD_SERVER outranks the config file.
export MUSTERD_SERVER="$SERVER"
[ "$PORT" = "4849" ] && { echo "✗ refusing to benchmark against the default daemon port" >&2; exit 2; }

BIN="$ROOT/packages/cli/dist/bin.js"
ADMIN="$BENCH/admin"
# Seats live *beside* the admin folder, never under it: a binding is resolved by walking up parent
# directories, so a seat nested inside the admin's folder is refused as "already bound to driver".
SEATDIR="$BENCH/seats"

# `musterd <args>` as a given seat: its own folder AND its own config, because the config's `current`
# identity otherwise wins over the folder and every send is attributed to the admin.
as_seat() { local dir="$1"; shift; (cd "$dir" && MUSTERD_CONFIG="$dir/config.json" node "$BIN" "$@"); }
as_admin() { as_seat "$ADMIN" "$@"; }

approve_pending() {
  for id in $(as_admin requests --pending --json | node -e \
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const r of JSON.parse(s||'[]'))console.log(r.id)})"); do
    as_admin requests decide "$id" --approve --standing >/dev/null
  done
}

down() {
  # Only ever by recorded PID. `pkill -f serve` also kills the real daemon and every other seat's —
  # that mistake cost a session.
  for f in "$BENCH/daemon.pid" "$BENCH/driver.pid"; do
    [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true
  done
  rm -rf "$BENCH"
  echo "▸ fixture down"
}

up() {
  [ -d "$MUSTERD_WEB_ROOT" ] || { echo "✗ no web build at $MUSTERD_WEB_ROOT — run \`pnpm build\`" >&2; exit 2; }
  down >/dev/null 2>&1 || true
  mkdir -p "$ADMIN" "$SEATDIR"
  # A fresh .db beside a stale -wal/-shm is SQLITE_IOERR (10), which reads like a full disk.
  rm -f "$MUSTERD_DB" "$MUSTERD_DB-wal" "$MUSTERD_DB-shm"

  (cd "$ADMIN" && MUSTERD_CONFIG="$ADMIN/config.json" node "$BIN" serve >"$BENCH/daemon.log" 2>&1) &
  echo $! >"$BENCH/daemon.pid"
  for _ in $(seq 1 60); do curl -sf "$SERVER/health" >/dev/null && break; sleep 0.5; done
  curl -sf "$SERVER/health" >/dev/null || { echo "✗ daemon never came up:" >&2; tail -20 "$BENCH/daemon.log" >&2; exit 1; }

  as_admin team create "$TEAM" --as driver >/dev/null
  as_admin team policy --reseat-known-agents on >/dev/null
  for i in $(seq 1 "$SEATS"); do
    as_admin team add "s$i" --kind agent >/dev/null
    mkdir -p "$SEATDIR/s$i"
  done
  KEY="$(node -e "console.log(require('$ADMIN/config.json').agentKeys['$TEAM'])")"

  # `claim` BLOCKS until an admin decides (ADR 077), so every seat claims in the background and the
  # admin approves underneath them. `join` alone is not enough: it opens the request and exits, and
  # the seat is never bound — so its sends fall back to the admin identity and the room stays empty.
  for i in $(seq 1 "$SEATS"); do
    (cd "$SEATDIR/s$i" && MUSTERD_CONFIG="$SEATDIR/s$i/config.json" \
       node "$BIN" claim "s$i" --team "$TEAM" --key "$KEY" >"$SEATDIR/s$i/claim.log" 2>&1) &
  done
  for _ in $(seq 1 20); do sleep 1; approve_pending; done
  wait_bound=0
  for i in $(seq 1 "$SEATS"); do grep -q 'occupied on' "$SEATDIR/s$i/claim.log" 2>/dev/null && wait_bound=$((wait_bound + 1)); done
  [ "$wait_bound" -eq "$SEATS" ] || { echo "✗ only $wait_bound/$SEATS seats bound — see $SEATDIR/*/claim.log" >&2; exit 1; }

  # The beat. Rotating status_updates keep seats `working`, which is what puts characters at desks,
  # produces speech bubbles, and keeps the loop drawing instead of parking.
  (
    n=0
    while :; do
      n=$(((n % SEATS) + 1))
      as_seat "$SEATDIR/s$n" send --to @team --act status_update "bench beat $n" >/dev/null 2>&1 || true
      sleep "$BEAT"
    done
  ) &
  echo $! >"$BENCH/driver.pid"

  echo "▸ fixture up — $SEATS seats on '$TEAM' at $SERVER (an act every ${BEAT}s)"
  echo "  $SERVER/broadcast?team=$TEAM"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
