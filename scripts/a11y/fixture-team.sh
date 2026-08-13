#!/usr/bin/env bash
# A synthetic team on a throwaway daemon, so the contrast gate can measure the CONNECTED board.
#
#   scripts/a11y/fixture-team.sh up          # daemon + team + goals + lanes, then exits (daemon stays)
#   scripts/a11y/fixture-team.sh down
#   scripts/a11y/fixture-team.sh preflight   # assert the isolation, create nothing
#
# `contrast-gate.mjs` drives this; it is standalone so you can also stand the board up by hand and
# look at it.
#
# ── Why this exists ─────────────────────────────────────────────────────────────────────────────
#
# The gate's first cut swept the built client off a static server, which covers the prerendered
# routes and nothing else: `/board` and `/live` need a daemon, so a static server only ever reaches
# their pre-connect state — one measurable element apiece. Everything the product actually says
# lives past that point. Pointed at a real daemon on 2026-08-12 the same sweep found ELEVEN more AA
# failures, ten of them on the goal grid, on the surface of the seat who had measured that grid by
# hand two hours earlier. The connected page is not a nice-to-have for this gate; it is where the
# text is.
#
# ── The isolation contract, inherited whole from scripts/perf/broadcast-bench-fixture.sh ────────
#
# That fixture leaked teams into the LIVE daemon's DB on 2026-07-27, with every env var apparently
# set correctly. Its conclusion is copied here verbatim in substance, because the failure mode is
# identical and the cost is someone else's roster:
#
#   * every CLI call carries `--server` explicitly. A flag outranks env, binding and config in both
#     resolution paths, and `team create` reads ONLY the flag and the config file.
#   * before anything is written, the daemon answering at $SERVER must report OUR scratch DB on
#     /health. Env vars say what we intended; /health says what will actually be written.
#   * teardown kills by RECORDED PID. `pkill -f serve` also kills the real daemon and every other
#     seat's — that mistake has already cost a session on this machine.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIX="${A11Y_FIXTURE_ROOT:-${TMPDIR:-/tmp}/musterd-a11y}"
PORT="${A11Y_FIXTURE_PORT:-4879}"
TEAM="${A11Y_FIXTURE_TEAM:-paper}"

export MUSTERD_DB="$FIX/a11y.db"
export MUSTERD_PORT="$PORT"
export MUSTERD_WEB_ROOT="$ROOT/packages/web/dist/client" # note /client
SERVER="http://127.0.0.1:$PORT"
export MUSTERD_SERVER="$SERVER"
if [ "$PORT" = "4849" ]; then
  echo "✗ refusing to seed a fixture on the default daemon port" >&2; exit 2
fi
LIVE_DB="${HOME}/.musterd/musterd.db"

BIN="$ROOT/packages/cli/dist/bin.js"
ADMIN="$FIX/admin"

as_admin() {
  (cd "$ADMIN" && MUSTERD_CONFIG="$ADMIN/config.json" node "$BIN" "$@" --server "$SERVER")
}

health_field() {
  { curl -sf "$SERVER/health" 2>/dev/null || true; } | node -e \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s)['$1']??''))}catch{}})"
}

preflight() {
  local want="$MUSTERD_DB" got
  if [ "$want" = "$LIVE_DB" ]; then
    echo "✗ preflight: MUSTERD_DB is the live daemon DB ($want)" >&2; exit 3
  fi
  if [ "${want#"$FIX"/}" = "$want" ]; then
    echo "✗ preflight: MUSTERD_DB ($want) is outside the scratch root ($FIX)" >&2; exit 3
  fi
  got="$(health_field db)"
  if [ -z "$got" ]; then
    echo "✗ preflight: no daemon answering /health at $SERVER" >&2; exit 3
  fi
  if [ "$got" != "$want" ]; then
    echo "✗ preflight: the daemon at $SERVER writes to a DB that is not ours — REFUSING to create anything" >&2
    echo "    it reports: $got" >&2
    echo "    we expect:  $want" >&2
    [ "$got" = "$LIVE_DB" ] && echo "    that is the LIVE daemon. Something resolved past this fixture's scoping." >&2
    echo "    stray daemon on :$PORT? try: A11Y_FIXTURE_PORT=<other> $0 up" >&2
    exit 3
  fi
  echo "▸ preflight ok — $SERVER is backed by $got"
}

down() {
  [ -f "$FIX/daemon.pid" ] && kill "$(cat "$FIX/daemon.pid")" 2>/dev/null || true
  case "$FIX" in
    ''|'/'|"$HOME"|"$HOME"/.musterd*)
      echo "✗ refusing to rm -rf A11Y_FIXTURE_ROOT=$FIX" >&2; exit 3 ;;
  esac
  rm -rf "$FIX"
}

up() {
  [ -d "$MUSTERD_WEB_ROOT" ] || { echo "✗ no web build at $MUSTERD_WEB_ROOT — run \`pnpm build\`" >&2; exit 2; }
  down >/dev/null 2>&1 || true
  mkdir -p "$ADMIN"
  # A fresh .db beside a stale -wal/-shm is SQLITE_IOERR (10), which reads like a full disk.
  rm -f "$MUSTERD_DB" "$MUSTERD_DB-wal" "$MUSTERD_DB-shm"

  # `exec`, so the recorded PID is the daemon and not the subshell — otherwise `down` kills the
  # wrapper and orphans a node holding the port and a deleted DB, which the next `up` then refuses.
  (cd "$ADMIN" && MUSTERD_CONFIG="$ADMIN/config.json" exec node "$BIN" serve --port "$PORT" \
     >"$FIX/daemon.log" 2>&1) &
  echo $! >"$FIX/daemon.pid"
  for _ in $(seq 1 60); do curl -sf "$SERVER/health" >/dev/null && break; sleep 0.5; done
  curl -sf "$SERVER/health" >/dev/null || { echo "✗ daemon never came up:" >&2; tail -20 "$FIX/daemon.log" >&2; exit 1; }

  # Everything below this line writes. Nothing above it did.
  preflight

  as_admin team create "$TEAM" --as ada >/dev/null

  # Roster. Names are chosen to spread the seat-identity hue band (memberAvatar derives colour from
  # the name), because the avatar chips are text on those colours and that pairing is measurable
  # here and nowhere else. Both kinds, because human/agent take different inks.
  for m in bo:agent cy:agent della:agent evan:human fen:agent gus:human hana:agent; do
    as_admin team add "${m%%:*}" --kind "${m##*:}" >/dev/null
  done

  # Goals across every card state the grid can render: planned, in-flight, shipped-with-outcome and
  # shipped-WITHOUT — the last one is the torn "…what changed?" slip, which has its own ink.
  as_admin goal declare "Paper trail" --goal-id told --story "A goal that says what it promised." >/dev/null
  as_admin goal declare "Quiet ship" --goal-id mute --story "Shipped without a word about it." >/dev/null
  as_admin goal declare "Still queued" --goal-id queued --story "Nothing has started yet." >/dev/null
  as_admin goal outcome told "The board says what changed, in the team's own words." >/dev/null

  # Lanes across every state, so every runway tone, chip and footer variant paints. `told` gets a
  # done lane so it derives `shipped`; `mute` likewise but keeps no outcome note.
  as_admin lane open "carry the story"        --goal told   --claim >/dev/null
  as_admin lane open "land the first change"  --goal told >/dev/null
  as_admin lane open "the quiet one"          --goal mute   --claim >/dev/null
  as_admin lane open "waiting on nobody"      --goal queued >/dev/null
  as_admin lane open "a lane on no goal at all" >/dev/null
  as_admin lane open "stuck behind something" --claim >/dev/null

  # `lanes --json` returns {lanes:[…], warnings:[…]} — the board, not a bare array.
  ids() { as_admin lanes --json | node -e \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const f=(JSON.parse(s||'{}').lanes??[]).find(x=>x.title==='$1');process.stdout.write(f?f.id:'')})"; }

  as_admin lane update "$(ids 'carry the story')"       --state active >/dev/null
  as_admin lane update "$(ids 'land the first change')" --state done >/dev/null
  as_admin lane update "$(ids 'the quiet one')"         --state done >/dev/null
  as_admin lane update "$(ids 'stuck behind something')" --state blocked >/dev/null
  as_admin lane update "$(ids 'a lane on no goal at all')" --state awaiting_acceptance >/dev/null

  echo "▸ a11y fixture up — team '$TEAM' at $SERVER"
  echo "  $SERVER/board?team=$TEAM"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  preflight) preflight ;;
  *) echo "usage: $0 up|down|preflight" >&2; exit 2 ;;
esac
