# Feature epoch — the bump ritual

Bump `FEATURE_EPOCH` (packages/protocol/src/feature-epoch.ts) by 1 when a change gives the daemon or fresh seats a client-visible capability an older seat can't participate in or render — a new act, a new MCP tool, a roster-affecting field; NOT for bugfixes, refactors, or web-only tweaks.

## Why it exists (ADR 148, #314)

It replaced the per-member build-SHA `stale` chip, which lit amber on every SHA difference in a drifting dogfood fleet — while the genuinely-incompatible case can't reach the roster at all (a version-mismatched client is refused at the WS handshake). The roster shows a calm `behind` hint only when a live seat's known epoch is below the daemon's; everything else fails quiet. Missing a bump fails safe (the hint gets less sensitive), unlike a missed `PROTOCOL_VERSION` bump — that one is the hard wire gate.
