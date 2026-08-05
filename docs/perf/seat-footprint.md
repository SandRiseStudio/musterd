# Seat footprint — measurement log

Probe: `node scripts/perf/seat-footprint.mjs [--json]` — one snapshot per run:
swap, free memory, MCP sidecar processes classified live / orphaned /
unattributed and grouped into stacks by launcher. Design:
`docs/superpowers/specs/2026-08-05-seat-footprint-design.md`. Append a snapshot
here at every milestone (pre/post diet, per shipped increment); never rewrite
old entries.

## 2026-08-05 baseline (pre-diet)

```
swap 10019/11264 MB · free mem 55 MB · 681 procs total
sidecars: 213 procs in 15 stacks · orphaned 0 procs (~0 MB RSS)
  live:2121      199 procs  1385 MB  /Applications/Claude.app/Contents/MacOS/Claude
  (+14 × 1-proc pdf-server stacks under per-session npm launchers, ~3 MB each)
```

Machine state: 3–5 nominal agent sessions; RSS badly **undercounts** true cost
here — with 55 MB free and 10 GB swapped, most sidecar pages are on disk, so
the 1.4 GB figure is a floor, not the total.

### Finding 1 — the "orphans" are not orphans

The design assumed dead sessions' sidecars get reparented to launchd (ppid 1)
and can be detected that way. **Measured: zero ppid-1 orphans.** The ~15×
duplication of every MCP server is real (213 sidecar procs), but the processes
are all *direct children of the live Claude desktop app process* (pid 2121).
The app keeps every session's MCP stack alive — including sessions whose tabs
are long closed — so the leak lives inside a living parent, invisible to the
ppid heuristic and out of reach of a safe external `kill` policy (the parent
owns them; the app may hold pipes to them or respawn them).

Consequences for the plan:

- **Phase 0 step 1 (manual orphan reap) changes shape:** the lever is not
  `kill`, it is *restarting the Claude desktop app* (drops all 199 in one
  move) and closing dead sessions promptly. `kill` remains correct for any
  genuinely reparented stragglers (today: none).
- **The product reap (`musterd reap`) keeps the ppid-1 + allowlist policy
  exactly because it is the only externally-safe kill**; the desktop-app-held
  duplication instead becomes a *report* ("N sidecar procs held by the Claude
  desktop app across M sessions — restart the app to reclaim") rather than a
  kill. The daemon can see it; only the user can safely act on it.
- **The config diet matters even more than assumed:** since stacks cannot be
  safely reaped out of a live app, not spawning them is the whole game.

### Finding 2 — stack grouping needs a session boundary the process tree lacks

All desktop-app sessions' sidecars share one parent (the app main process), so
"group by nearest non-sidecar ancestor" collapses them into a single 199-proc
stack. Per-session grouping inside the desktop app is not derivable from
`ps` alone. Terminal `claude` sessions do not have this problem (each CLI
process parents its own sidecars). Follow-up recorded for the ADR: report
desktop-app-held sidecars as one aggregate with a proc/session estimate,
rather than pretending to per-session resolution the data cannot support.
