# 08 — Web surface (`@musterd/web`)

> **Living document.** Like the rest of `docs/architecture`, this is direction, not gospel. If you find
> it disagrees with the code, fix the smaller of the two and update the other in the same commit; if the
> disagreement is a real decision, write an ADR. This chapter is the map the other web ADRs (061–064,
> 072/073, 079, 086, 094, 096/097, 099, 102, 104, 107) assume but never draw in one place.

## What the web package is

`@musterd/web` is the **browser console for a team** — a read-only window onto the same Members the CLI
and MCP adapter serve, rendered from the daemon's firehose. It is a TanStack Start (React + Vite) app.
It owns **no state the daemon doesn't**: every view is a projection of what the server derives or
streams. There is no board CRUD, no second store, no write path beyond the self-provisioning observer
seat it needs to subscribe.

Two design commitments follow from "read-only projection":

- **The daemon is the source of truth.** The web renders `GET` projections (`/messages`, `/lanes`,
  `/report`) and the live firehose. When a view looks stale, the fix is a server projection, not client
  state. (See the ADR 104 board: "the dashboard renders what the engine derives.")
- **Same origin as the daemon in production.** The daemon static-serves the built app (ADR 062), so the
  client talks to `window.location.host` for `/teams`, `/ws`, `/health` — no configured base URL. In dev,
  `vite.config.ts` proxies those paths to the daemon (`MUSTERD_DAEMON`, default `:4849`) and strips the
  browser `Origin` so the ADR 040 cross-origin gate sees a clean request.

## Routes

| Route               | What it is                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` (`index.tsx`)   | Marketing / hero + the roadmap map (rendered from `content/roadmap.data.ts`, the same source `ROADMAP.md` is generated from).                                                            |
| `/live`             | The team console: the isometric **office** + the **stream** + the governance **roster**. The flagship surface.                                                                           |
| `/board`            | Read-only kanban over `GET /lanes` — one column per lane state (ADR 104 increment 1).                                                                                                    |
| `/approvals`        | The approval queue / card web views (ADR 072/073).                                                                                                                                       |
| `/audit`            | The audit-log view (ADR 071 projection).                                                                                                                                                 |
| `/office-preview`   | A design/verification harness: a scripted act sequence + a control bar that fires each `OfficeEvent` on demand. Not a live surface — the place to eyeball choreography without a daemon. |
| `/approval-preview` | The same idea for the approval card.                                                                                                                                                     |

## The `/live` connection model

`live/client.ts` + `live/useLiveStream.ts` implement the canonical **"backfill then tail"** pattern:

1. **Self-provision an observer seat.** The browser `claim`s its own read-only observer seat
   (self-authorizing, ADR 077 claim handshake; localhost-trust like team creation). `/board` and the
   other live views reuse the same hidden observer.
2. **Backfill history over HTTP** — `GET /teams/:slug/messages` — so the view is not empty on load.
3. **Subscribe to the firehose** — a WS `subscribe` with scope `team-all` (ADR 061) — and live-tail,
   **deduping by envelope id** against the backfill.

A shared read-only **watch link** (`/live?team=<slug>&as=<observer>#w=<credential>`, ADR 063) lets a team
hand someone a spectator view without provisioning them a real seat.

> **Known limitation (2026-07-07):** the HTTP backfill is capped (200) and returns the oldest of an
> over-cap history, so on a busy team the newest acts arrive only via the live socket, not the backfill.
> Deep-history scroll needs a paging fix; tracked separately from ADR 107.

## The three `/live` panels

- **Office** (`live/OfficeScene.tsx` + `live/office-scene/`) — a 2D isometric co-work office (ADR 079).
  Presence → placement, act → choreography, travel-intensity == notification tier. Per-member Rive
  characters (`character.riv`) with a code-drawn avatar fallback if the WASM/asset fails. ADR 086 layers
  ambient life (idle strolls, gestures) on top, idle-parked to 0 rAF/sec at rest.
- **Stream** (`live/Stream.tsx`) — the legible half: the act feed, newest-last, live rows type out,
  threaded replies indent, day/now dividers. This is where a human reads the team.
- **Roster** (`live/RosterPanel.tsx`) — the governance rail (ADR 070 projection): each seat's
  account-status and capability deviations, presence dot, and the ADR 105 "reconnecting" hint for a
  reclaimable seat. The accessible counterpart to the (decorative) office.

## Act rendering vocabulary (the load-bearing contract)

Every act projects to a consistent set of renderings. This is the seam ADR 102 (lane events) and ADR 107
(steering acts) each extended, and the thing to touch when a new act is added:

| Concern          | Lives in                                                                                              | What it produces                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Tone**         | `live/format.ts` `actTone` → `ActTone`                                                                | The colour role (accent / success / lane / steer / challenge / …). Backs the stream badge and the office cue/speech colour.                                              |
| **Label**        | `live/format.ts` `actLabel`                                                                           | The short human word in the badge (`status_update` → "status"). Clean single-word acts read verbatim.                                                                    |
| **Glyph**        | `live/Stream.tsx` `ACT_GLYPH` / `ActIcon`                                                             | A 12px stroke glyph per act in the badge.                                                                                                                                |
| **Tone colour**  | `live/office-scene/render.ts` `toneColor`                                                             | The concrete office cue/speech colour per tone (mirrors the `--lc-*` CSS tokens).                                                                                        |
| **Choreography** | `live/office-scene/mapping.ts` `actToEvent` → `OfficeEvent`, played by `office-scene/index.ts` `emit` | The office motion: screen-pulse, walk-over (help/handoff), megaphone, redirect sweep (steer), question cue (challenge), board pulse (defer), etc. `null` = not animated. |
| **Sound**        | `live/sound.ts` `CUES`                                                                                | A short WebAudio cue per act (opt-in, default off).                                                                                                                      |
| **CSS tokens**   | `live/Live.css` (`--lc-*`, `.lc-badge--*`)                                                            | The palette + badge/spine variants the tones resolve to.                                                                                                                 |

Two act **families** layer on the base acts:

- **Lane events (ADR 102)** ride `act: 'message'` + `meta.lane_*` (ADR 083 — no new act token). The web
  recovers the sub-type with `format.ts` `laneEvent(env)` → `lane_open | lane_claim | lane_state |
lane_resolve | lane_handoff`, and every renderer above keys on that recovered kind. A non-recovering
  client still sees a coherent `message`.
- **Steering acts (ADR 103 / render ADR 107)** — `steer` / `challenge` / `defer` are real protocol acts.
  `steer` is interrupt-class (a room-wide sweep + urgent redirect run); `challenge` is a "justify?"
  question cue; `defer` is a lane-family board pulse. See ADR 107 for the full projection.

**To add a new act's rendering:** add its `actTone` case (+ a `--lc-*` token and `.lc-badge--*` if it
needs a new colour), an `actLabel` case if the token isn't already a clean word, an `ACT_GLYPH` entry, a
`toneColor` case if it introduced a tone, an `actToEvent` case (+ an `OfficeEvent` kind and an `emit`
branch if it needs new motion), and a `sound.ts` cue. Cover the projection with a `mapping.test.ts` case
and a `format.test.ts` tone/label assertion. Verify against a live daemon or `/office-preview`.

## Module map

Curated, not exhaustive — the load-bearing files, grouped. (Intentionally **not** a `File tree` block:
the web tree is large and UI-heavy, so it is not under `arch-trees:check`; keep this list honest by
hand.)

```
router.tsx / routeTree.gen.ts   // TanStack router setup (routeTree is generated)
routes/                         // one file per route (live, board, approvals, audit, previews, index)
content/roadmap.data.ts         // the roadmap SOURCE — ROADMAP.md is generated from it (scripts/gen-roadmap.ts)
live/
  client.ts                     // observer claim + backfill + WS subscribe (browser port of the CLI watch)
  useLiveStream.ts              // the React hook: envelopes, roster, liveIds, conn status; drives the chime
  format.ts                     // act tone/label, laneEvent recovery, roster/colour/status projections
  Stream.tsx                    // the act feed + ACT_GLYPH + typewriter
  RosterPanel.tsx               // the governance roster rail + reconnecting hint
  OfficeScene.tsx               // React wrapper: mounts the scene, feeds it envelopes → emit
  Board.tsx / ApprovalQueue.tsx / ApprovalCard.tsx / AuditLog.tsx   // the other live views
  sound.ts                      // opt-in WebAudio firehose cues
  Live.css                      // the /live palette + component styles (--lc-* tokens)
  office-scene/
    index.ts                    // the imperative scene handle {update, emit, dispose}; the emit switch
    mapping.ts                  // actToEvent: act/envelope → OfficeEvent (the projection)
    types.ts                    // OfficeEvent / OfficeNode / Pose / OfficeHandle
    render.ts                   // canvas drawing primitives + toneColor + Cue
    actors.ts / nav.ts / seating.ts / layout.ts / iso.ts   // placement, walk routing, iso projection
    rig.ts / rive-rig.ts        // the Rive character rig contract + loader (client-only WASM)
    speech.ts                   // the over-head speech-bubble text model
components/                     // marketing surface (Hero, Roadmap, Footer, LiquidGlass, Wedge)
```

## Testing & verification

- **Unit:** the render seam is covered by fast vitest files — `office-scene/mapping.test.ts` (the
  `actToEvent` projection), `live/format.test.ts` (tones/labels/`toneColor`), and the scene's
  `actors`/`nav`/`seating`/`rig`/`speech` tests. Run from the repo root (`pnpm exec vitest run
packages/web/src/live/`) — a per-package `vitest` invocation trips the app's build target.
- **Visual / live:** drive `/office-preview` headless for choreography without a daemon, or point the
  dev server at a live daemon (`MUSTERD_DAEMON=…`) and watch real acts flow through `/live`. ADR 107
  records a full live-daemon verification of the steering acts.
- The build (`pnpm --filter @musterd/web build`) prerenders each route; a broken route fails the build,
  which the CI `gates` job runs.
