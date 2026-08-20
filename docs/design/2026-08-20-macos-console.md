# A lightweight macOS console for every agent session

2026-08-20 · exploratory design for lane `01M03AEZ1BVFB7T3FQPVWHNWF9` (nick's spike) · brainstormed
with nick, written by kimi · freezes once its decisions land in ADRs.

## The problem is weight, not terminals

The desktop apps are too heavy to live in. Claude.app alone measures ~1.4 GB
(`docs/perf/seat-footprint.md`); every desktop seat is an Electron renderer plus a full MCP sidecar
stack, and a machine running several seats' worth of Codex desktop / Claude desktop / Cursor IDE
falls over. The footprint spec's placement policy — only 1–2 seats get a desktop app, workers run as
headless terminal sessions — was the diet. This design is the diet becoming the product: **all**
seats headless, with one native app restoring the UX the bare terminal lacks.

The fallback everyone lands on — harness CLIs in terminal tabs — is light but a poor surface: no
identity (which tab *is* which seat?), no glanceable state (who is working, who is waiting on me,
who died?), no actions (reap, wake, resume). And because every viewer we have is a browser tab that
dies with the tab, the team keeps rebuilding push surfaces out of parts — osascript nags from the
ADR 166 liveness sweep, room wardens (ADR 157) — each a special case of one missing thing: a
durable, native place where sessions live.

## The landscape (researched 2026-08-20, so the bet is informed)

This space filled up in 2026. All of these are native, local-first, and explicitly anti-Electron:

| App | Stack | License | Continuity | Reading for musterd |
| --- | --- | --- | --- | --- |
| Clave | **Electron** + xterm.js | MIT | app-owned PTY | Disqualified by the performance goal — it *is* the weight |
| Codux | Rust + GPUI | GPL-3 | reconnect to running shells; headless host agent | A competing platform (memory injection, credential wrappers, 9 CLI adapters) — adopt it and you adopt its model |
| Kaji | Swift | — | session dispatch/resume | Too young to read much from |
| AIWorkstation | SwiftUI + SwiftTerm | MIT | none — "a restored card offers to relaunch rather than faking a dead process" | Cleanest reference architecture (canvas, PTY controllers, worktree isolation) |
| Vigil | SwiftUI + libghostty (GPU) | GPL-3 | **harness-native resume** (`claude --resume`, `codex resume`) + transcript replay | Philosophically musterd's twin: orchestration as real tool calls the app executes; honesty as a hard rule |

Two findings fell out of the survey:

**The terminal part is a commodity; the coordination is the moat.** Every entry re-implements the
same substrate — PTY, sidebar, worktree isolation. None of them knows what a session *is*: no seat,
no team, no inbox, no acceptance. Orchestration comparisons of the field name this exactly — the
session managers keep each agent's context isolated and "the team forgets between runs." musterd
already is the missing layer, so the app should be thin on terminal tech and thick on coordination:
the only session console where each session is a seat with identity, waiting acts, cost, and a wake
path.

**Harness-native resume beats process preservation for the actual pain.** The pain is *machine*
crashes. tmux survives an app quit; it does not survive the machine going down. The harnesses' own
resume (`claude --resume`, `codex resume`) survives both, because the transcript is the continuity,
not the process. And musterd already built that substrate — session capture with ids and transcript
paths (ADR 131/165/166), plus the wake actuator. An app-owned PTY + harness resume gives
better-than-tmux continuity with zero new machine dependency. (Vigil independently converged on the
same model: "process death and session death are decoupled.")

Building blocks are all proven: SwiftTerm (pure Swift VT100; ships in CodeEdit, Secure Shellfish,
La Terminal), libghostty for GPU rendering if SwiftTerm ever can't keep up, and documented tmux
control-mode with client libraries in Rust/Go/Node if process preservation is ever wanted back.

## Decision: build thin, on musterd's substrate

One native process. SwiftUI + SwiftTerm. Menu-bar extra for glance-and-act, a window for real work.

```
┌─ musterd console (one Swift process; <100 MB, ~0% idle CPU) ────┐
│  sidebar: seats — harness · state · cost · waiting-acts badge   │
│  main:    SwiftTerm view into the selected session's PTY        │
│  menu bar: presence dot + waiting count; drop-down of acts      │
└───────┬──────────────────────────────────┬────────────────────┘
        │ polls every few s                 │ spawns / resumes
┌───────▼──────────────┐          ┌─────────▼─────────┐
│ musterd sessions     │          │ app-owned PTYs:   │
│ --json (new verb)    │          │ claude · codex ·  │
└───────┬──────────────┘          │ cursor-agent · …  │
        │ unions                  └─────────┬─────────┘
┌───────▼─────────────────────────┐         │ capture hooks already write
│ harness enumerators (ADR 166,   │◄────────┘ session id + transcript path
│ 265, 270) · binding & host      │            into the binding (ADR 131)
│ registries · daemon roster ·    │
│ footprint costs · inbox flags   │
└─────────────────────────────────┘
```

### Data plane: `musterd sessions --json`

One new read-only CLI verb that unions what already exists: harness session enumeration, the
workspace binding and host registries, the daemon roster, per-stack footprint from the shipped
sampler, and waiting-act counts. The app polls it; there is **no enumeration logic in Swift** — one
source of truth, already covered by the enumerators' tests. The app degrades honestly when a field
is absent (daemon down → local-only mode, coordination section says so).

### Session plane: app-owned PTYs

SwiftTerm `LocalProcessTerminalView` per session, spawned in the seat's worktree. Full TUI
fidelity — claude and codex are full-screen terminal apps and render as themselves. The app is a
view: quitting it ends the *processes* it owns (v1 accepted) but loses nothing — see continuity.

### Continuity: resume, not preservation

Each binding already records its captured session (id + transcript path) via the capture hooks. On
relaunch — after a quit, a crash, a reboot — the console enumerates, matches sessions to seats, and
offers **revive** through the harness's native resume. The conversation is the state; the process
was always disposable. tmux becomes optional later hardening (survives *app* quit without a resume
round-trip), never the foundation.

### Coordination plane: the part nobody else has

The daemon supplies seat identity, presence, waiting-acts badges, per-stack cost, and the action
endpoints: wake over ADR 131 leases, `musterd reap` behind a confirmation, lane board read-out per
seat. The console authenticates as the human with the existing chmod-600 credential in
`~/.musterd` — it is a peer surface, like `/live`, not an admin backdoor.

### Honesty rules (stolen from Vigil, because they're right)

- A harness CLI that isn't detected is greyed out, never shown as available.
- A dead session is shown dead with a revive action, never faked as live.
- An action that can't be delivered errors; nothing pretends.
- Stale poll data is marked stale.

## Actions (full set, per nick's call 2026-08-20)

- **New session** — pick a seat → spawn its harness CLI in the seat's worktree.
- **Revive** — harness-native resume from the binding's captured session.
- **Reap** — the shipped `musterd reap` machinery, with cost shown before the kill.
- **Wake** — daemon wake lease for seats whose harness wakes remotely.
- **Jump-to** — focus the pane; sessions owned by an external terminal can't be adopted and say so.

## Performance budget

The design's reason to exist, so it's a budget, not a hope: the console process under 100 MB and
~0% CPU at idle with a dozen sessions attached; measured against the 1.4 GB Claude.app figure in
`docs/perf/seat-footprint.md`. If SwiftTerm can't hold that with full-screen TUIs scrolling,
libghostty is the researched fallback (Vigil renders with it).

## Error handling

Missing CLI → greyed launcher entry. Daemon down → sessions still spawn and run; the coordination
column says "local-only." Resume into a GC-expired transcript → fresh spawn with a note, not a
crash. Poll failure → stale marker on the data, never silently old numbers.

## What it is not

- Not an orchestrator. No agent trees, no prompt routing, no manager brains — musterd's acts
  already are the coordination protocol; the console is a surface onto it.
- Not a prompt-injection platform (Codux's memory/credential injection is its own product bet, not
  ours — musterd's guidance files already own that channel, ADR 259).
- Not a cloud anything. Local-first like the rest of musterd.
- Not a tmux wrapper, and not trying to adopt sessions already running in external terminals —
  going forward, sessions start from the console (or arrive via wake).

## Prerequisites

- An ADR covering: the new surface, the SwiftTerm (SPM) dependency, and the `sessions --json` verb.
- `musterd sessions --json` itself — a thin union over existing, tested parts.
- The app lives outside the pnpm workspace (SwiftPM/Xcode project); where it lives is an open
  question below.

## Open questions

- Name and repo location (an `apps/` dir in the monorepo, or its own repo).
- Distribution: local build for nick's machine first; signed/notarized dmg only if it earns it.
- Cursor-agent resume support — the ADR 265 capture work records sessions; confirm `cursor-agent`
  has a resume path as good as `claude --resume`.
- Whether the menu-bar extra absorbs the ADR 166 sweep's osascript nags (plausibly yes — the sweep
  pushes because there is no glanceable surface; the console is one).

## References

- Lane `01M03AEZ1BVFB7T3FQPVWHNWF9` — the spike this captures.
- `docs/superpowers/specs/2026-08-05-seat-footprint-design.md` — placement policy; sampler/reap
  substrate (shipped: `packages/server/src/footprint/`, `packages/cli/src/commands/reap.ts`).
- `docs/perf/seat-footprint.md` — the 1.4 GB figure and friends.
- ADR 131 (wake/session ladder), ADR 165 (cursor session capture), ADR 166 (liveness sweep),
  ADR 265 (`.workspace-trusted`), ADR 157 (room wardens — the transient-push problem).
- Field research: Clave, Codux, Kaji, AIWorkstation (MIT), Vigil (GPL-3); SwiftTerm; libghostty;
  tmux control-mode clients (`tmuxctl`, `libtmux`, `gotmuxcc`).
