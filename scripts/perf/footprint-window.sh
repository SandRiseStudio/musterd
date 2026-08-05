#!/bin/bash
# Phase 0 closed-window pass (seat-footprint lane).
#
# Run this in Terminal *before* quitting the Claude desktop app — the agent
# session driving this work lives inside that app, so it cannot observe its own
# shutdown. This script waits for the app to exit, then does the three things
# that are only possible (or only safe) while it is closed:
#
#   1. probe with the app down    — proves whether its ~199 held sidecars died
#   2. sweep true orphans         — ppid-1 + allowlist matches only
#   3. diet ~/.claude.json        — the app rewrites this file on quit, so the
#                                   edit must land after that write
#
# Then reopen the app; a fresh session reads log/ to pick the work back up.
set -uo pipefail

REPO="/Users/nick/agents-kimi"
PROBE="$REPO/scripts/perf/seat-footprint.mjs"
OUT="$REPO/docs/perf/footprint-window-$(date +%Y%m%d-%H%M%S).log"
CFG="$HOME/.claude.json"

# Servers to lift out of the GLOBAL config. musterd stays (every seat needs it);
# per-project entries under projects.* are untouched — this only stops every new
# session inheriting servers it will never call.
REMOVE=(ElevenLabs cloudflare-workers-observability embrace figma flyctl langfuse posthog supabase)

exec > >(tee -a "$OUT") 2>&1
echo "=== footprint window pass — $(date -Iseconds) ==="

echo
echo "--- [0] probe: app still up (baseline for this pass) ---"
node "$PROBE"

echo
echo "--- waiting for Claude.app to exit (⌘Q it now; Ctrl-C to abort) ---"
while pgrep -x -f '/Applications/Claude.app/Contents/MacOS/Claude' >/dev/null 2>&1; do sleep 2; done
echo "app is down at $(date -Iseconds); settling 5s"
sleep 5

echo
echo "--- [1] probe: app down ---"
node "$PROBE"

echo
echo "--- [2] orphan sweep (ppid 1 + sidecar allowlist only) ---"
ORPHANS=$(node "$PROBE" --json | python3 -c '
import json,sys
snap = json.load(sys.stdin)
pids = [p for s in snap["stacks"] if s["classification"] == "orphaned" for p in s["pids"]]
print(" ".join(str(p) for p in pids))
')
if [ -z "$ORPHANS" ]; then
  echo "no reparented orphans — nothing to sweep (expected: the app took its own with it)"
else
  echo "orphaned pids: $ORPHANS"
  ps -o pid=,rss=,args= -p ${ORPHANS// /,} | cut -c1-160
  # shellcheck disable=SC2086
  kill $ORPHANS 2>/dev/null
  sleep 3
  # shellcheck disable=SC2086
  kill -9 $ORPHANS 2>/dev/null
  echo "swept."
fi

echo
echo "--- [3] global MCP diet on ~/.claude.json ---"
cp "$CFG" "$CFG.bak-$(date +%Y%m%d-%H%M%S)"
python3 - "$CFG" "${REMOVE[@]}" <<'PY'
import json, sys
path, remove = sys.argv[1], set(sys.argv[2:])
cfg = json.load(open(path))
g = cfg.get("mcpServers", {})
kept = {k: v for k, v in g.items() if k not in remove}
dropped = sorted(set(g) - set(kept))
cfg["mcpServers"] = kept
json.dump(cfg, open(path, "w"), indent=2)
print("dropped from global:", dropped or "(none)")
print("kept in global:", sorted(kept) or "(none)")
PY

echo
echo "--- [4] probe: post-diet, app still down ---"
node "$PROBE"

echo
echo "=== done. reopen Claude.app, then tell the next session to read: ==="
echo "$OUT"
