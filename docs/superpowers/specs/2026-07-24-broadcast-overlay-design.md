# Design — the office overlay (ADR 157 follow-up)

**Lane** 01KYAQTX667WF17C5DBE821SR0 · **Owner** miley · **Date** 2026-07-24

## Problem

`musterd broadcast` streams the isometric office to Twitch. The scene is charming and it tells a
stranger nothing: a viewer who lands on the channel sees pixel-people and has no way to learn they
are watching real AI agents coordinating on real work.

The on-stream chrome today is a placeholder — a grey/red `LIVE` pill and the team name, bottom-left.
It is the weakest thing on an otherwise finished broadcast.

Two properties make this harder than "add a caption":

- **The room rests.** The office deliberately settles onto a still frame between ambient beats every
  30–70s. A viewer can arrive at a motionless room with no speech bubble up. Chrome that only
  narrates events goes blank exactly when orientation matters most.
- **`/live` and `/broadcast` must not diverge.** Standing decision from nick (2026-07-24): the
  dashboard and the stream are the same product and must look it. Any chrome built for one belongs
  to both.

## Decision

Build **`OfficeOverlay`** — one shared component rendered inside `OfficeScene`, so both routes
receive it by construction rather than by discipline. It carries **orientation, not narration**:
what team this is, who is here, and what they are working on. Acts stay with the existing speech
bubbles, which already do that job well.

### Why not an act ticker

The obvious idea — a lower-third or ticker of live act text — was considered and rejected. On
`/broadcast` alone it would be good. Shared with `/live`, it sits a few inches from the stream rail
that already lists every act, and one of the two has to be the redundant one. The "always the same"
constraint is what decides it: a component that is excellent on one route and duplicative on the
other is not a shared component.

Lanes also survive the resting room in a way acts do not. A claimed lane is still true between
ambient beats; a status update three minutes ago is not on screen.

## Components

### `OfficeOverlay` (presentational)

Props: `{ teamName, roster, lanes, status }`. No fetching, no effects, no timers — it renders what
it is handed. Three bottom-anchored bands:

1. **Identity** — the musterd mark + team name.
2. **Signal** — the LIVE / CONNECTING dot (driven by `status`, honest about the connection) and the
   count of non-offline members.
3. **Working-on strap** — claimed lanes with their owners. This is the band that closes the gap:
   it turns pixel-people into _these agents, on this work, now_.

`pointer-events: none` throughout, inside the existing `--lc-z-overlay` layer, `aria-hidden`.

### `useWorkingOn(cfg, envelopes)` (data)

Returns the claimed lanes for the overlay's third band.

- One `fetchLaneBoard` on connect.
- Re-fetch **only** when a `lane_*` act arrives on the firehose both routes already subscribe to.

No polling. Lane changes are rare and self-announcing, so idle cost is effectively zero — required
by the ADR 151 perf contract, which every `/live` viewer pays into forever.

Both routes call this hook and pass `lanes` down. `OfficeScene` does not receive `cfg`, and giving
it one would widen its interface from "render this data" to "know how to talk to the daemon"; the
hook keeps that boundary intact.

### `/live` topbar reduction

The topbar currently carries the team name and a status pill with a live count — precisely bands 1
and 2. With the overlay present in both routes these become duplicates a few inches apart, so they
are **removed from the topbar**, which is left as pure operator chrome: watch link, sound, companion
toggle, clock. Net effect is less chrome and more information. Approved by nick 2026-07-24.

## Layout across two very different boxes

The same component renders into a full 1920×1080 stage on `/broadcast` and into one column of a
three-panel dashboard on `/live`. It sizes to its container, not to the viewport: the working-on
strap shows as many lanes as fit and collapses to the single most recently claimed one when narrow.
Bands 1 and 2 are always present — they are the cheapest and the most orienting.

## Disclosure — deliberate, not overlooked

`/broadcast` connects with `acquireObserver`, the **full-grade** observer credential, so directed
seat-to-seat acts (DMs, handoffs, asks, steers) appear in speech bubbles on the public stream. A
public-grade path exists (`acquireWatchLinkObserver`, ADR 136) and would filter them.

**nick's decision, 2026-07-24: leave it full-grade.** The team's traffic is overwhelmingly `@team`,
the loss would be a quieter stream, and the "watching real work" effect is worth the exposure. This
is a disclosure choice under ADR 157 Consequences, recorded here so it does not later read as an
oversight. Revisit if the team's directed traffic grows or the channel's audience changes.

## Constraints this must hold

- `pnpm perf:check` passes. The three-font allowlist (Fraunces, Space Grotesk, Space Mono) applies;
  no new dependencies.
- No new always-on animation. The overlay may not add a render loop; the existing single pulsing
  dot is the motion budget.
- Presence safety (ADR 155): `/broadcast` stays observer-only by construction. No advanced-seat path
  is added.
- The scene's broadcast carve-outs (full-rate render, DPR 1, reduced-motion ignored) are untouched,
  and no `/live` viewer optimization is relaxed to buy an effect.

## Testing

- Unit: `OfficeOverlay` renders each band from props; degrades correctly with an empty roster, zero
  lanes, and `status !== 'live'`.
- Unit: `useWorkingOn` fetches once on connect, re-fetches on a `lane_*` envelope, and does **not**
  re-fetch on other acts — the perf claim, asserted rather than assumed.
- Visual: capture 20–30s to mp4 via `musterd broadcast --out`, watched at 1:1 and scaled down,
  during both a busy moment and a resting room.
- Gates: root `pnpm test`, `pnpm lint`, `pnpm format:check`, `pnpm perf:check` — build first.
