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
# `A11Y_FIXTURE_SEATS=` (empty) stands the team up with an EMPTY room. That is not a convenience
# knob, it is how the room's worth was measured: unoccupied, `/live` yields 25 measurable text
# nodes; occupied, 29 — and the four extra classes are the least of it, because the pairs that only
# exist in a busy room are the ones nothing had ever checked. See the header of the room block below.
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
# Seats live BESIDE the admin folder, never under it: a binding resolves by walking up parents, so a
# seat nested inside the admin's folder is refused as already bound.
SEATDIR="$FIX/seats"
# Who occupies the room. Names are load-bearing twice over: `memberAvatar`/`memberInk` derive colour
# from the name, so a spread of names is a spread of inks — and the stream prints the sender's name
# in its own ink, which is where that palette is actually read as text.
SEATS="${A11Y_FIXTURE_SEATS-bo cy della}"

as_seat() {
  local dir="$1"; shift
  (cd "$dir" && MUSTERD_CONFIG="$dir/config.json" node "$BIN" "$@" --server "$SERVER")
}
as_admin() { as_seat "$ADMIN" "$@"; }

approve_pending() {
  for id in $(as_admin requests --pending --json | node -e \
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const r of JSON.parse(s||'[]'))console.log(r.id)})"); do
    as_admin requests decide "$id" --approve --standing >/dev/null 2>&1 || true
  done
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

  # ── the room, occupied ────────────────────────────────────────────────────────────────────────
  #
  # Everything above paints the BOARD. `/live` is mostly a stream of acts, a rail of asks and a work
  # stack, and on a team where nobody is present those render their QUIET states: an "nothing waiting
  # on a human" rail, every roster chip reading `offline`, no posture but idle.
  #
  # Measured both ways rather than assumed (A11Y_FIXTURE_SEATS= gives the empty room): unoccupied
  # /live yields 25 measurable text nodes, occupied 29. The interesting part is not the count but
  # WHICH — fourteen element/ink pairs exist only in a busy room, and none of them had ever been
  # measured by anything:
  #
  #   the act→tone badges (`lc-badge--accent` "help", `--status`, `--handoff`) · the `working`
  #   posture chip · a quote and its author in the sender's own ink · the work stack's task, name,
  #   state and overflow · the asks rail's avatar and rest-count · the roster gap line
  #
  # Seats must genuinely CLAIM to send under their own name; `team add` alone leaves them unbound and
  # their sends fall back to the admin identity, which collapses the palette to one colour and is
  # exactly how a seeded room can still measure nothing. `claim` blocks until an admin decides
  # (ADR 077), so each claims in the background while the admin approves underneath them.
  if [ -z "$SEATS" ]; then
    echo "▸ a11y fixture up — team '$TEAM' at $SERVER (empty room: A11Y_FIXTURE_SEATS is unset)"
    echo "  $SERVER/board?team=$TEAM"
    return 0
  fi
  as_admin team policy --reseat-known-agents on >/dev/null 2>&1 || true
  KEY="$(node -e "console.log(require('$ADMIN/config.json').agentKeys['$TEAM'])")"
  for s in $SEATS; do
    mkdir -p "$SEATDIR/$s"
    (cd "$SEATDIR/$s" && MUSTERD_CONFIG="$SEATDIR/$s/config.json" \
       node "$BIN" claim "$s" --team "$TEAM" --key "$KEY" --server "$SERVER" \
       >"$SEATDIR/$s/claim.log" 2>&1) &
  done
  bound=0
  for _ in $(seq 1 25); do
    sleep 1; approve_pending
    bound=0
    for s in $SEATS; do grep -q 'occupied on' "$SEATDIR/$s/claim.log" 2>/dev/null && bound=$((bound + 1)); done
    [ "$bound" -eq "$(echo $SEATS | wc -w | tr -d ' ')" ] && break
  done
  if [ "$bound" -eq 0 ]; then
    echo "✗ no seat bound — /live would render an empty room and measure only its quiet states" >&2
    echo "  see $SEATDIR/*/claim.log" >&2
    exit 1
  fi

  # Acts across the tone map. `format.ts` paints each act a different colour and the stream is the
  # largest DOM surface on the page, so this is the bulk of what phase 2 actually measures.
  set -- $SEATS
  A="${1:-}"; B="${2:-$A}"; C="${3:-$A}"
  as_seat "$SEATDIR/$A" send --to @team --act status_update "carrying the story lane" >/dev/null 2>&1 || true
  as_seat "$SEATDIR/$B" send --to @team --act request_help "stuck behind something and out of ideas" >/dev/null 2>&1 || true
  as_seat "$SEATDIR/$C" send --to "$A" --act handoff "yours now — branch is pushed" >/dev/null 2>&1 || true
  as_seat "$SEATDIR/$A" send --to "$C" --act accept "took it, thanks" >/dev/null 2>&1 || true
  as_seat "$SEATDIR/$B" send --to @team --act status_update "back on it" >/dev/null 2>&1 || true

  # The asks rail, loud. One per tier: the tier chips and their countdown clocks are separate inks,
  # and a rail with nothing in it renders exactly one quiet line.
  as_seat "$SEATDIR/$A" send --to evan --act ask --meta species=consult --meta tier=advisory \
    "can you look at this before I go further?" >/dev/null 2>&1 || true
  as_seat "$SEATDIR/$B" send --to gus --act ask --meta species=escalate --meta tier=standard \
    "need a decision to keep moving" >/dev/null 2>&1 || true
  as_seat "$SEATDIR/$C" send --to evan --act ask --meta species=approve --meta tier=blocking \
    "approve this before it ships?" >/dev/null 2>&1 || true

  echo "▸ a11y fixture up — team '$TEAM' at $SERVER ($bound seats in the room)"
  echo "  $SERVER/board?team=$TEAM"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  preflight) preflight ;;
  *) echo "usage: $0 up|down|preflight" >&2; exit 2 ;;
esac
