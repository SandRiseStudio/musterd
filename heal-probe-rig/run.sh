#!/bin/sh
# ADR 336 owed arm — live gated-then-healed attestation probe (lane 01M1CT6XJRGQW341HSXW8WG09K).
#
# Stages the exact incident sequence from ADR 336 in a throwaway /tmp workspace bound to seat
# ryder, on the live build (>= a647b9cc):
#   P1 captures the slot and dies mid-way through P2's life;
#   P2 starts beside the live P1 -> gated at SessionStart (zero ledger rows);
#   P2's first tool boundary heals the slot and (the fix under observation) attests it.
# Expected on the ledger: P1 captured+ended; P2's FIRST session_captured row ~70s after it
# started, exactly one such row (idempotence via the second tool call), then P2 ended.
# Needs a CLI >= #1150 on PATH (the stored lease is dead five minutes after a claim; without the
# reclaim no probe row lands at all) and NO adapter live elsewhere on the seat: #1150 refuses to
# claim while the seat is held in another workspace, so a live MCP session on this seat means the
# probe stages nothing — by design, an eviction being the worse outcome.
set -e
W="/tmp/heal-probe-$(date +%s)"
SRC="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$W/.claude" "$W/.musterd"
cp "$SRC/hooks.settings.json" "$W/.claude/settings.local.json"
# The probe binds to this seat, so it needs this worktree's live credentials. They are read at
# run time and never checked in — a committed binding is a leaked agent_key and grant.
python3 -c "
import json, sys
b = json.load(open(sys.argv[1]))
b.pop('session', None)
b.pop('model_observed', None)
json.dump(b, open(sys.argv[2], 'w'), indent=2)
" "$SRC/../.musterd/binding.json" "$W/.musterd/binding.json"
cd "$W"
echo "probe workspace: $W"
date +"start: %H:%M:%S"

# NOT `sleep`: a foreground sleep is hook-blocked in this harness, and a blocked sleep is
# backgrounded, which collapses the whole timeline into ~10s and stages nothing.
claude -p 'Run this exact Bash command in the FOREGROUND and nothing else, then stop: python3 -c "import time; time.sleep(40)" && echo P1-done' \
  --allowedTools Bash --output-format json >p1.json 2>p1.err &
P1=$!
# `claude -p` fires no SessionEnd (measured 2026-09-01: neither probe transcript carries one), so
# P1 would hold the slot as "live" for the whole LOCAL_SESSION_LIVE_MS window and P2 would never
# heal. Stamp P1's end the way an interactive exit's SessionEnd hook does, the moment it exits.
( while kill -0 "$P1" 2>/dev/null; do sleep 1; done; sid=$(python3 -c "import json;print(json.load(open('p1.json'))['session_id'])" 2>/dev/null)
  date +"p1 exited, stamping end: %H:%M:%S"
  printf '{"session_id":"%s","transcript_path":"%s","hook_event_name":"SessionEnd","cwd":"%s"}' "$sid" "$HOME/.claude/projects/$(echo "$W" | sed 's#/#-#g')/$sid.jsonl" "$W" | musterd session end --stdin ) &
STAMP=$!
sleep 8
claude -p 'Run this exact Bash command in the FOREGROUND: python3 -c "import time; time.sleep(60)" && echo P2-one. When it completes, run this second exact Bash command: echo P2-two. Then stop.' \
  --allowedTools Bash --output-format json >p2.json 2>p2.err
wait "$STAMP" || true

date +"end: %H:%M:%S"
for f in p1 p2; do
  printf '%s session_id: ' "$f"
  python3 -c "import json;print(json.load(open('$f.json')).get('session_id','(unreadable)'))" 2>/dev/null || echo '(unreadable — see '"$f"'.err)'
done
echo "slot after (expect P2's id, ended_at and attested_at set):"
python3 -c "import json;print(json.dumps(json.load(open('.musterd/binding.json')).get('session'),indent=2))"
echo "$W" >/tmp/heal-probe-last
echo "done — tell ryder (or just team_send anything); the audit rows are the evidence."
