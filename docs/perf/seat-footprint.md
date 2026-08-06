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

## 2026-08-05 closed-window pass (app restart + global MCP diet)

Full transcript: `docs/perf/footprint-window-20260805-155220.log`.

| moment | swap | free mem | procs | sidecars |
| --- | --- | --- | --- | --- |
| app up (pre) | 9923/11264 MB | 67 MB | 737 | 212 in 15 stacks |
| app down | 988/6144 MB | 1699 MB | 473 | **0** |
| app reopened, sessions resumed (lean config) | 1544/2048 MB | 139 MB | 509 | 34 in 5 stacks |

### Finding 3 — the app restart alone returned ~9 GB of swap

Quitting Claude.app took all 198 held sidecars with it (confirming finding 1:
they were app-held, not orphaned — the sweep found nothing to kill), and swap
collapsed 9.9 GB → 1.0 GB with the swapfile pool itself shrinking 11.3 GB →
2 GB. The single biggest recoverable cost on this machine is the desktop app's
accumulated session stacks.

### Finding 4 — the global diet cut sidecars ~6× at equal session count

Global `~/.claude.json` mcpServers is now empty (musterd was already
per-project; ElevenLabs, cloudflare-obs, embrace, figma, flyctl, langfuse,
posthog, supabase dropped — backup kept beside the file). Same sessions
resumed after relaunch now spawn 34 sidecar procs vs 212 before. The remaining
per-session spawns are plugin-provided MCPs (chrome-devtools, playwright,
pdf-server — note each resumed session still carries a pdf-server at ~30 MB
resident now that pages are unswapped); a plugin-scoping pass is the next diet
increment if needed.

## 2026-08-06 five-seat stagger test (post-diet, post-ADR 242)

Protocol: t0 with 4 working seats, 5th launched staggered, probe every 5 min
for 30 min. Daemon sampler (60 s ticks) running throughout.

| t | swap | free mem | sidecars |
| --- | --- | --- | --- |
| 00:43 (t0, 4 seats) | 7069/8192 MB | 49 MB | 61 in 8 stacks |
| 00:48 | 6082/7168 MB | 57 MB | 70 in 9 |
| 00:53 | 6246/7168 MB | 61 MB | 70 in 9 |
| 00:58 | 7707/8192 MB | 61 MB | 79 in 10 |
| 01:03 (peak) | 8162/9216 MB | 51 MB | 79 in 10 |
| 01:08 | 6890/8192 MB | 50 MB | 70 in 9 |
| 01:13 | 7305/8192 MB | 70 MB | 70 in 9 |

### Verdict — 5 concurrent seats: survivable, not comfortable

Swap **oscillates** in the 6–8 GB band and the swapfile pool grew to 9.2 GB at
peak then contracted back — the pager keeping up, in sharp contrast to the
pre-diet baseline's monotonic climb to 10.3/11.3 GB (near-standstill). Sidecars
held at 70–79 procs across 5 seats vs 212 pre-diet. Free memory pinned at
50–70 MB throughout (macOS under sustained pressure — expected).

Honest reading: the diet moved the machine from "5 seats ≈ standstill" to
"5 seats works with elevated swap churn". 8 GB of RAM remains the binding
constraint; the marginal desktop-app seat costs ~9 sidecar procs plus its
renderer, and the swap band says a 6th concurrent seat would likely tip it.
This curve is the baseline for any future admission-control threshold
(ADR 242 future work): the honest ceiling of this machine is **5 working
seats, with 4 as the comfortable operating point**.
