#!/usr/bin/env bash
# Stand up a synthetic, *animated* team for capture benchmarking, and leave it running.
#
#   scripts/perf/broadcast-bench-fixture.sh up     # daemon + seats + act driver
#   scripts/perf/broadcast-bench-fixture.sh down
#   scripts/perf/broadcast-bench-fixture.sh preflight  # assert the isolation, create nothing
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
# Everything is scoped by env (MUSTERD_DB / MUSTERD_PORT / MUSTERD_SERVER / MUSTERD_CONFIG), but env
# scoping alone is a *convention*, and this fixture already broke it once: on 2026-07-27 an in-progress
# version without the MUSTERD_SERVER export seeded teams `bench` and `bench2` straight into the live
# daemon's DB. Convention fails silently — the run looks perfect and the damage is only visible later,
# in someone else's roster. So isolation here is *asserted*, not assumed (see `preflight`):
#
#   * every CLI call passes `--server "$SERVER"` explicitly. A flag is the highest-precedence source in
#     every resolution path, including `team create`, which resolves its server on its own and never
#     consults the env→binding→config ladder the other commands share.
#   * before anything is created, the daemon answering at $SERVER must report *our* scratch DB on
#     /health. That is the assertion that actually closes the class: it does not care how a wrong
#     server got resolved — stale env, a `server:` in a binding.json, a stray daemon already squatting
#     the port, or a line typed by hand into a shell with none of this exported. If the DB on the
#     other end is not the scratch one, the run aborts before it can write.
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
# MUSTERD_SERVER outranks ~/.musterd/config.json for the commands that read the shared ladder. It is
# still set (the daemon and `broadcast-baseline.mjs` read it), but it is no longer what the isolation
# rests on — `--server` on every call plus `preflight` is.
export MUSTERD_SERVER="$SERVER"
if [ "$PORT" = "4849" ]; then
  echo "✗ refusing to benchmark against the default daemon port" >&2; exit 2
fi
# The live daemon's DB, as the CLI and daemon would resolve it with none of the above set. Nothing the
# fixture creates may ever land here.
LIVE_DB="${HOME}/.musterd/musterd.db"

BIN="$ROOT/packages/cli/dist/bin.js"
ADMIN="$BENCH/admin"
# Seats live *beside* the admin folder, never under it: a binding is resolved by walking up parent
# directories, so a seat nested inside the admin's folder is refused as "already bound to driver".
SEATDIR="$BENCH/seats"

# `musterd <args>` as a given seat: its own folder AND its own config, because the config's `current`
# identity otherwise wins over the folder and every send is attributed to the admin. `--server` is
# appended to *every* call rather than left to MUSTERD_SERVER: a flag is the top of the precedence
# ladder in both resolution paths the CLI has, and `team create` — the command that leaked — only
# reads the flag and the config file, never the env→binding chain the rest share.
as_seat() {
  local dir="$1"; shift
  (cd "$dir" && MUSTERD_CONFIG="$dir/config.json" node "$BIN" "$@" --server "$SERVER")
}
as_admin() { as_seat "$ADMIN" "$@"; }

# Read one field out of GET /health. Empty if the daemon is not answering or the field is absent — the
# `|| true` matters under `set -o pipefail`, so an unreachable daemon reaches preflight's own message
# instead of dying as a bare curl exit 7.
health_field() {
  { curl -sf "$SERVER/health" 2>/dev/null || true; } | node -e \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s)['$1']??''))}catch{}})"
}

# The gate. Run after the daemon is up and BEFORE a single team, seat or act is created.
#
# The check is deliberately about the *DB on the other end of the wire*, not about which env vars are
# set. Env vars answer "what did we intend"; /health answers "what will actually be written", which is
# the only question that matters and the one the 2026-07-27 leak got wrong while every intention looked
# right. Any mismatch is fatal — this never warns and continues, because a warning on a benchmark run
# is a warning nobody reads until the junk teams show up in the live roster.
preflight() {
  local want="$MUSTERD_DB" got
  if [ "$want" = "$LIVE_DB" ]; then
    echo "✗ preflight: MUSTERD_DB is the live daemon DB ($want)" >&2; exit 3
  fi
  if [ "${want#"$BENCH"/}" = "$want" ]; then
    echo "✗ preflight: MUSTERD_DB ($want) is outside the scratch root ($BENCH)" >&2; exit 3
  fi

  got="$(health_field db)"
  if [ -z "$got" ]; then
    echo "✗ preflight: no daemon answering /health at $SERVER" >&2; exit 3
  fi
  if [ "$got" != "$want" ]; then
    echo "✗ preflight: the daemon at $SERVER is writing to a DB that is not ours — REFUSING to create anything" >&2
    echo "    it reports: $got" >&2
    echo "    we expect:  $want" >&2
    if [ "$got" = "$LIVE_DB" ]; then
      echo "    that is the LIVE daemon. Something resolved past this fixture's scoping." >&2
    fi
    echo "    stray daemon on :$PORT? try: BENCH_PORT=<other> $0 up" >&2
    exit 3
  fi
  echo "▸ preflight ok — $SERVER is backed by $got"
}

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
  # `rm -rf` on an env-supplied path deserves a guard: BENCH_ROOT is a knob, and an empty or careless
  # one turns the teardown into something much worse than a leaked team.
  case "$BENCH" in
    ''|'/'|"$HOME"|"$HOME"/.musterd*)
      echo "✗ refusing to rm -rf BENCH_ROOT=$BENCH" >&2; exit 3 ;;
  esac
  rm -rf "$BENCH"
  echo "▸ fixture down"
}

up() {
  [ -d "$MUSTERD_WEB_ROOT" ] || { echo "✗ no web build at $MUSTERD_WEB_ROOT — run \`pnpm build\`" >&2; exit 2; }
  down >/dev/null 2>&1 || true
  mkdir -p "$ADMIN" "$SEATDIR"
  # A fresh .db beside a stale -wal/-shm is SQLITE_IOERR (10), which reads like a full disk.
  rm -f "$MUSTERD_DB" "$MUSTERD_DB-wal" "$MUSTERD_DB-shm"

  # --port explicitly, for the same reason every CLI call carries --server: the flag is the one source
  # that cannot be outranked, so the daemon lands where we said even if MUSTERD_PORT is lost.
  # `exec`, so the recorded `$!` is the daemon itself and not the subshell wrapping it. Without it
  # `down` killed the wrapper and left an orphan node holding the port and a since-deleted DB — which
  # the next `up` then found on /health and (rightly) refused to write to.
  (cd "$ADMIN" && MUSTERD_CONFIG="$ADMIN/config.json" exec node "$BIN" serve --port "$PORT" \
     >"$BENCH/daemon.log" 2>&1) &
  echo $! >"$BENCH/daemon.pid"
  for _ in $(seq 1 60); do curl -sf "$SERVER/health" >/dev/null && break; sleep 0.5; done
  curl -sf "$SERVER/health" >/dev/null || { echo "✗ daemon never came up:" >&2; tail -20 "$BENCH/daemon.log" >&2; exit 1; }

  # Everything below this line writes. Nothing above it did.
  preflight

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
       node "$BIN" claim "s$i" --team "$TEAM" --key "$KEY" --server "$SERVER" \
       >"$SEATDIR/s$i/claim.log" 2>&1) &
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
  # Standalone, so the same assertion can be run by hand before typing a `musterd …` line against the
  # fixture — the exact situation that leaked in the first place.
  preflight) preflight ;;
  *) echo "usage: $0 up|down|preflight" >&2; exit 2 ;;
esac
