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
# Comfortably inside the daemon's 45s PRESENCE_TIMEOUT_MS, with room for a slow re-join.
PRESENCE_HEARTBEAT_S="${A11Y_FIXTURE_HEARTBEAT_S:-20}"

BIN="$ROOT/packages/cli/dist/bin.js"
ADMIN="$FIX/admin"
# Seats live BESIDE the admin folder, never under it: a binding resolves by walking up parents, so a
# seat nested inside the admin's folder is refused as already bound.
SEATDIR="$FIX/seats"
# Who occupies the room. Names are load-bearing twice over: `memberAvatar`/`memberInk` derive colour
# from the name, so a spread of names is a spread of inks — and the stream prints the sender's name
# in its own ink, which is where that palette is actually read as text.
# Entries are `name:surface`. The surface half is load-bearing and was the gap this fixture had
# from the day it was written: a CLI claim is intrinsically `cli` (ADR 286), so with no `--surface`
# every seat in the room was a cli seat, no plate ever rendered a harness segment, and all four
# `--lc-hz-*-ink` tokens shipped unmeasured by the gate whose whole job is to measure shipped ink.
# One seat per harness that HAS a glyph (surfaceGlyph.ts: codex, cursor, grok, opencode) — a fourth
# seat over the old three, which is what covering the fourth ink costs. `claude-code` is deliberately
# not here: it renders as bare text, so it has no ink of its own to measure.
# A bare `name` (no colon) still means cli, so `A11Y_FIXTURE_SEATS='bo cy'` keeps working.
SEATS="${A11Y_FIXTURE_SEATS-bo:cursor cy:codex della:grok hana:opencode}"
seat_name() { printf '%s' "${1%%:*}"; }
seat_surface() { case "$1" in *:*) printf '%s' "${1#*:}" ;; *) printf 'cli' ;; esac; }

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
  # Heartbeats first, by RECORDED pid — a `pkill -f join` would reach into other seats' sessions.
  if [ -f "$FIX/heartbeat.pids" ]; then
    while read -r hb; do [ -n "$hb" ] && kill "$hb" 2>/dev/null || true; done <"$FIX/heartbeat.pids"
  fi
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
  want=0
  for e in $SEATS; do
    n="$(seat_name "$e")"; want=$((want + 1))
    mkdir -p "$SEATDIR/$n"
    (cd "$SEATDIR/$n" && MUSTERD_CONFIG="$SEATDIR/$n/config.json" \
       node "$BIN" claim "$n" --team "$TEAM" --key "$KEY" \
       --server "$SERVER" >"$SEATDIR/$n/claim.log" 2>&1) &
  done
  bound=0
  for _ in $(seq 1 25); do
    sleep 1; approve_pending
    bound=0
    for e in $SEATS; do
      grep -q 'occupied on' "$SEATDIR/$(seat_name "$e")/claim.log" 2>/dev/null && bound=$((bound + 1))
    done
    [ "$bound" -eq "$want" ] && break
  done
  # EVERY seat, not "at least one". The old guard was `-eq 0`, which passes on a PARTIAL room, and a
  # partial room is the failure this fixture is least able to survive: on 2026-09-02 a stale CLI dist
  # rejected `--surface grok`, della never claimed, the room silently went from 3 seats to 2, the
  # sweep measured 105 elements instead of 111 — AND STILL REPORTED GREEN. A gate that goes green by
  # losing part of its subject is the exact failure docs/wiki/measuring-a-moving-page.md exists to
  # name, and it is worse than a red because nobody goes looking. Shrinking the room is now a stop.
  if [ "$bound" -ne "$want" ]; then
    echo "✗ only $bound of $want seats bound — the room would be measured SHORT, and a sweep over a" >&2
    echo "  room that quietly lost a seat reports green for coverage it does not have." >&2
    for e in $SEATS; do
      n="$(seat_name "$e")"
      grep -q 'occupied on' "$SEATDIR/$n/claim.log" 2>/dev/null || {
        echo "  ✗ $n ($(seat_surface "$e")) — $(tail -1 "$SEATDIR/$n/claim.log" 2>/dev/null || echo 'no claim log')" >&2
      }
    done
    echo "  A ZodError on --surface here means the built CLI predates the surface: run \`pnpm -r build\`." >&2
    exit 1
  fi

  # ── presence, on the seat's own harness ───────────────────────────────────────────────────────
  #
  # `claim` binds the folder and then EXITS, and an agent-seat presence dies with the process that
  # holds its session lease (ADR 337) — so after a bare `up` this fixture's room had every seat
  # OFFLINE with no presence at all. Measured on main at 5392cf53: immediately after `up` reported
  # "3 seats in the room", the roster showed bo/cy/della `offline` with `presences: []`, and the only
  # live row on the team was the admin's. "Seats in the room" counted BINDINGS, which is not what the
  # page draws. Everything the header block below promises about a busy room — the posture chip, the
  # act→tone badges, a quote in the sender's own ink — has been measured against a room that had
  # nobody in it.
  #
  # `claim --detach --surface <harness>` is the fix (until 2026-09-04 this was `join --surface`, the
  # one-shot HTTP claim; ADR 377 folded join into claim and `--detach` names that path): it
  # attaches a presence that OUTLIVES the process (no session lease to lose) and stores the surface
  # on the identity, so every `send` below also goes out on that harness rather than falling back to
  # `cli`. That second half is what makes the harness segment render: the plate reads `node.surface`
  # from the LIVE presence, so a claimed-but-absent seat is a plate with no harness seg no matter
  # what it claimed as.
  # Backgrounded and approved underneath, exactly like the claims above: it opens its OWN claim
  # request and blocks on an admin decision (ADR 077), so running these in the foreground deadlocks
  # the fixture against itself — there is nobody else to approve them.
  for e in $SEATS; do
    n="$(seat_name "$e")"
    (cd "$SEATDIR/$n" && MUSTERD_CONFIG="$SEATDIR/$n/config.json" \
       node "$BIN" claim "$n" --team "$TEAM" --detach --key "$KEY" --surface "$(seat_surface "$e")" \
       --server "$SERVER" >"$SEATDIR/$n/join.log" 2>&1) &
  done
  joined=0
  for _ in $(seq 1 25); do
    sleep 1; approve_pending
    joined=0
    for e in $SEATS; do
      grep -q 'online via' "$SEATDIR/$(seat_name "$e")/join.log" 2>/dev/null && joined=$((joined + 1))
    done
    [ "$joined" -eq "$want" ] && break
  done

  # ── and a heartbeat, because a presence with nobody holding it is reaped in 45s ────────────────
  #
  # PRESENCE_TIMEOUT_MS is 45_000 and the reaper hard-DELETEs (packages/server config.ts / presence.ts),
  # so the join above buys the room ONE MINUTE. The gate's connected phase runs five sweeps off a
  # single `up` — /board, /live at two lighting values, the asks sheet, the plates — at roughly 15s
  # each, so on the old fixture the room would have emptied under the sweep somewhere around the
  # second one even if it had ever been occupied. Measured on main at 5392cf53: joined at t+0, gone
  # by t+70s. A room that empties partway through a run is the moving-page problem in its purest
  # form — the same commit measures differently depending on how long the fixture took to get there.
  #
  # Re-claiming detached is the heartbeat because it is the ONLY path that attaches a presence on a
  # chosen surface. A long-lived holder would be tidier, but every one of them forces `cli`: `inbox --watch`
  # takes its surface from the binding, and the binding path pins `cli` by construction (ADR 286,
  # config.ts). Measured: `join --surface cursor` (now `claim --detach`) then `inbox --watch` leaves the seat present on
  # `cli`, harness segment gone. So the fixture re-asserts instead of holding.
  #
  # Every heartbeat's PID is recorded, and `down` kills them BY PID for the same reason the daemon is
  # killed by PID: a `pkill -f` here would take out other seats' sessions on this machine.
  : >"$FIX/heartbeat.pids"
  for e in $SEATS; do
    n="$(seat_name "$e")"; sf="$(seat_surface "$e")"
    (
      while :; do
        sleep "$PRESENCE_HEARTBEAT_S"
        (cd "$SEATDIR/$n" && MUSTERD_CONFIG="$SEATDIR/$n/config.json" \
           node "$BIN" claim "$n" --team "$TEAM" --detach --key "$KEY" --surface "$sf" \
           --server "$SERVER" >>"$SEATDIR/$n/join.log" 2>&1) || true
      done
    ) >/dev/null 2>&1 &
    echo $! >>"$FIX/heartbeat.pids"
    # Detached from the job table AND from this script's stdout (above): a child that still holds the
    # script's stdout keeps `fixture-team.sh up | tail` from ever seeing EOF, so the caller hangs on a
    # fixture that is actually ready. The gate pipes this output, so that hang is a 5-minute timeout
    # rather than a visible error.
    disown $! 2>/dev/null || true
  done

  # …and every seat is PRESENT on the surface it was told to occupy. Binding is not enough and
  # neither is joining: a join that silently fell back to `cli` succeeds perfectly well and leaves
  # the harness inks unrendered again, which is the whole defect this fixture is here to close.
  # Assert against the roster the page will actually read, not against our own intent — this is the
  # falsifier for everything above it, and it is the check that would have caught the empty room.
  ROSTER="$(curl -sf "$SERVER/teams/$TEAM/members" || true)"
  for e in $SEATS; do
    n="$(seat_name "$e")"; want_surface="$(seat_surface "$e")"
    got="$(printf '%s' "$ROSTER" | MUSTERD_SEAT="$n" node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const m=(JSON.parse(s||"{}").members??[]).find(x=>x.name===process.env.MUSTERD_SEAT);
        const p=(m?.presences??[]).filter(p=>p.status!=="offline");
        process.stdout.write(p.map(p=>p.surface).join(","));
      })')"
    case ",$got," in
      *",$want_surface,"*) ;;
      *) echo "✗ $n claimed but is present on [$got], not '$want_surface' — the harness segment for" >&2
         echo "  '$want_surface' will not render, so --lc-hz-$want_surface-ink goes unmeasured." >&2
         # HEAD, not tail: a rejected surface is a ZodError whose last line is a bare `]`, and the
         # line that names the cause ("invalid_enum_value", "received": …) is at the top.
         echo "  claim said: $(tr -d '\n ' <"$SEATDIR/$n/join.log" 2>/dev/null | head -c 180 || echo 'no join log')" >&2
         echo "  (a rejected surface here means the built CLI predates it — run \`pnpm -r build\`)" >&2
         exit 1 ;;
    esac
  done

  # Acts across the tone map. `format.ts` paints each act a different colour and the stream is the
  # largest DOM surface on the page, so this is the bulk of what phase 2 actually measures.
  set -- $SEATS
  A="$(seat_name "${1:-}")"; B="$(seat_name "${2:-${1:-}}")"; C="$(seat_name "${3:-${1:-}}")"
  D="$(seat_name "${4:-${1:-}}")"
  as_seat "$SEATDIR/$A" send --to @team --act status_update "carrying the story lane" >/dev/null 2>&1 || true
  as_seat "$SEATDIR/$B" send --to @team --act request_help "stuck behind something and out of ideas" >/dev/null 2>&1 || true
  as_seat "$SEATDIR/$C" send --to "$A" --act handoff "yours now — branch is pushed" >/dev/null 2>&1 || true
  as_seat "$SEATDIR/$A" send --to "$C" --act accept "took it, thanks" >/dev/null 2>&1 || true
  as_seat "$SEATDIR/$B" send --to @team --act status_update "back on it" >/dev/null 2>&1 || true
  # Every seat sends at least once, and that is load-bearing rather than decorative: a seat with no
  # work reads as posture `active`, and `assignSeats` puts an active member on the LOUNGE furniture,
  # where there is no desk and therefore NO NAMEPLATE. Measured 2026-09-02 — with only three seats
  # sending, the fourth (opencode) lounged and its harness ink went unmeasured while the other three
  # were fine, which is the same "green by losing part of the subject" shape as the partial room
  # above, one layer in. A seat that must be MEASURED must be a seat that is SEATED.
  as_seat "$SEATDIR/$D" send --to @team --act status_update "at my desk, reading" >/dev/null 2>&1 || true

  # An OPEN HUDDLE, so the huddle rail (ADR 378 increment 2) has ink to measure. Without it the rail
  # renders nothing and the sweep goes green on a surface it never saw — the same "green by losing
  # part of the subject" failure the room block above documents. Two turns and a named seat that has
  # not spoken, because `.lc-huddle__silent` and `.lc-huddle__count` are their own (quietest) inks.
  HUDDLE_ID="$(as_seat "$SEATDIR/$A" huddle open --topic lane:01FIXTURELANE     --anchor docs/design/asks-rail.md --to "$B,$C" --turns 6     "the asks rail arc — ring or bar?" --json 2>/dev/null     | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).huddle_id??'')}catch{}})")"
  if [ -n "$HUDDLE_ID" ]; then
    as_seat "$SEATDIR/$B" huddle say "$HUDDLE_ID" --act challenge       "why a ring at all when the strip already has the tier?" >/dev/null 2>&1 || true
    as_seat "$SEATDIR/$A" huddle say "$HUDDLE_ID"       "because the tier is a colour and the clock is a shape" >/dev/null 2>&1 || true
  else
    echo "✗ a11y fixture: could not open the huddle the rail is measured on" >&2
    exit 1
  fi

  # The asks rail, loud. One per tier: the tier chips and their countdown clocks are separate inks,
  # and a rail with nothing in it renders exactly one quiet line.
  as_seat "$SEATDIR/$A" send --to evan --act ask --meta species=consult --meta tier=advisory \
    "can you look at this before I go further?" >/dev/null 2>&1 || true
  as_seat "$SEATDIR/$B" send --to gus --act ask --meta species=escalate --meta tier=standard \
    "need a decision to keep moving" >/dev/null 2>&1 || true
  as_seat "$SEATDIR/$C" send --to evan --act ask --meta species=approve --meta tier=blocking \
    "approve this before it ships?" >/dev/null 2>&1 || true

  # A LAPSED ask — a below-top tier whose clock ran out with no answer and no outcome envelope. It
  # is a distinct ink and a distinct card (quiet, no answer buttons) rather than a fourth copy of
  # the three above, and without one seeded here the sweep measures every ask state EXCEPT the one
  # that is deliberately understated, which is the one most likely to be under-contrasted.
  #
  # Backdated in the DB because `send` mints `ts` at now and lapsed is DEFINED by an old ts; a day
  # clears every tier's timeout with room to spare. Written with better-sqlite3 (already a
  # @musterd/server dependency) rather than a `sqlite3` binary, which is not guaranteed on CI.
  as_seat "$SEATDIR/$B" send --to evan --act ask --meta species=consult --meta tier=standard \
    "small one — going ahead unless you say otherwise" >/dev/null 2>&1 || true
  # Resolved from packages/server, not from cwd: pnpm does not hoist, so a bare require from the
  # repo root is MODULE_NOT_FOUND even though the package is installed.
  MUSTERD_SERVER_PKG="$ROOT/packages/server" node -e '
    const Database = require(
      require.resolve("better-sqlite3", { paths: [process.env.MUSTERD_SERVER_PKG] }),
    );
    const db = new Database(process.env.MUSTERD_DB);
    const n = db.prepare(
      "UPDATE messages SET ts = ts - 86400000 WHERE act = ? AND body LIKE ?",
    ).run("ask", "small one — going ahead%").changes;
    if (n !== 1) { console.error(`✗ fixture: backdated ${n} asks, expected 1`); process.exit(1); }
  ' || { echo "✗ a11y fixture: could not seed a lapsed ask" >&2; exit 1; }

  echo "▸ a11y fixture up — team '$TEAM' at $SERVER ($bound seats: $SEATS)"
  echo "  $SERVER/board?team=$TEAM"
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  preflight) preflight ;;
  *) echo "usage: $0 up|down|preflight" >&2; exit 2 ;;
esac
