#!/usr/bin/env bash
# Superseded by `musterd stream` — kept as a forwarder so the muscle memory (and any shell profile
# that still exports MUSTERD_AIR_ADDR) keeps working.
#
# What moved and why: every verb this script had is now `musterd stream <verb>`, and the flow gained
# the thing this script could not have — `musterd stream doctor`, which checks each precondition
# (tailscale up, `serve` forwarding the daemon, the daemon accepting the tailnet Host on the ADR 040
# gate, flyctl authed, app, secrets, image) and prints the exact repair. Those preconditions all
# failed as the same unhelpful "the broadcast page never reported ready", which is what made the
# first day of hosted streaming cost four launches. `start` also discovers the tailnet address now,
# so MUSTERD_AIR_ADDR is no longer required.
set -euo pipefail

echo "▸ scripts/broadcast/live.sh is now \`musterd stream\` — forwarding to \`musterd stream ${1:-}\`" >&2
echo "  (run \`musterd stream doctor\` first; it is the part that did not exist before)" >&2

exec musterd stream "$@"
