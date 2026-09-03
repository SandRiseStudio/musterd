# A member's colour is a fact the team owns — design

**Date:** 2026-09-03 · **Lane:** 01M1MM0VGJKYFSHP3Q1C10BTQN · **Seat:** miley · **Asked by:** nick

## The ask

Every agent and human on a team gets a distinct colour, assigned by default when the member is
created, customisable by whoever creates them, no two members on a team alike, and the *same*
colour everywhere — office floor, roster, message stream. The office surfaces are a second lane
(01M1MM1Y5H); this one makes the colour exist.

## What is true today

Nothing stores a colour. `memberHue(name, kind)` in `packages/web/src/live/format.ts` hashes the
member's name into a hue (agents 150–280°, humans 320–70°) and every surface derives from that one
number, with contrast-corrected variants (`memberAvatar` for white initials on a fill, `memberInk`
for the name as text on paper) computed *from the hue*. Two consequences:

- nothing prevents two teammates hashing to near-identical hues, and nothing can be customised;
- the a11y story is only as good as it is because the *hue* is the stored thing and lightness is
  derived. That is the constraint every approach below has to keep.

## Approaches

**A. Store a hex.** The most literal "colour". Rejected: a free hex breaks the derived-lightness
contract — white initials, the name as ink, the fill on the floor all stop clearing AA
automatically and the contrast gate lands back on the human who typed the hex.

**B. Web-only collision resolution.** Keep the hash, resolve near-collisions client-side. Rejected:
nothing persists, nothing can be chosen, and two clients could resolve differently.

**C. Store a hue on the member; assign unique at creation; a set verb; web prefers it.**
Chosen (nick, 2026-09-03). "Customise" becomes "pick a hue on the wheel", which is still every
colour, and every derived variant keeps clearing AA with no new gate.

Also decided: **the agent/human bands are dropped** (nick). Defaults spread over the full wheel
for maximum distinctness; kind reads from the character design (ADR 079 — antenna, chest LED,
visor) and from the roster chip, which were always the load-bearing tell.

## Design

### Protocol — `packages/protocol/src/member.ts`, new `packages/protocol/src/hue.ts`

- `Member.hue: z.number().int().min(0).max(359).nullish()`. `MemberSummary` extends `Member`, so
  the roster carries it with no further change. Nullish for back-compat: an older daemon omits it
  and every consumer falls back exactly as today.
- `HUE_MIN_SEPARATION = 15` (degrees). 24 fully separated slots on the wheel; the dogfood team has
  18 seats.
- `defaultHue(name): number` — the existing golden-ratio hash, over the full wheel.
- `assignHue(seed, taken: readonly number[]): number` — the nearest hue to `seed` (walking outward
  alternately ±1°) that is ≥ `HUE_MIN_SEPARATION` from every value in `taken`, on the circle. When
  no such hue exists (more than 24 seats) return the midpoint of the largest gap: still the most
  distinct choice available, never a refusal at creation.
- `hueConflict(hue, taken): number | null` — the first taken hue within the separation, or null.
- All three are pure and shared by server and CLI, so the two cannot disagree about what "taken"
  means.

### Server

- **Migration v65**: `ALTER TABLE members ADD COLUMN hue INTEGER` (guarded, the v31 pattern), then
  backfill: for each team, live members in `created_at` order, `hue = assignHue(defaultHue(name),
  taken-so-far)`. Departed members (`left_at` set) are left NULL and get a hue on revive. An
  existing DB comes out with no two live teammates within 15°.
- `AddMemberInput.hue?: number | null`. Explicit → validate 0–359 and refuse a collision with
  `MusterdError('conflict', 'hue 210 is within 15° of "ryder" (214)')`; absent → `assignHue`.
  `reviveMember` keeps an existing hue and assigns one only when the row has none.
- `MemberRow.hue: number | null`; `toMember` maps it.
- **Route** `POST /teams/:slug/members/:name/hue` `{ hue }` — the member themself or a team admin
  (`resolveCapabilities(viewer).is_admin`), the same authority split the governance routes use.
  Same collision refusal. Returns the member's summary.
- `AddMemberBody.hue` optional on `POST /teams/:slug/members`.
- **Reconcile** (`projection/reconcile.ts`) does not touch the column, so a file-backed team keeps
  its hues across every reconcile. A hue declared in the seat file is a follow-up, not this lane.
- **Sync**: the `members` table does not replicate row-by-row (nodes read the roster over HTTP),
  so nothing changes in `sync/`.

### CLI

- `musterd agent <name> --hue <0-359>` and `musterd human … --hue <0-359>` at creation.
- `musterd hue <name> [<deg>]` — bare prints the member's hue; with a degree sets it, refusing a
  collision by name. `--as` for authority as everywhere else.
- `client.ts`: `setHue(team, name, hue)`.

### Web — `packages/web/src/live/format.ts`

- `memberHue(name, kind, hue?: number | null)`: a stored hue wins; null → today's banded hash,
  unchanged, so a pre-v65 daemon renders exactly as before. `memberColor`, `memberAvatar`,
  `memberInk` gain the same optional third parameter.
- The office floor, nameplate and character top all read `OfficeNode.color`, computed once in
  `OfficeScene.tsx` — one edit covers the room. Roster, stream, asks strip, board, audit log and
  goal grid read `idx.get(name)?.hue` beside the existing `kindOf(name, idx)`. Mechanical: ~17
  files, one-line pass-throughs. A module-level name→hue map would touch fewer files and was
  rejected as a hidden global.

### Tests

- protocol: `assignHue` yields N distinct hues pairwise ≥ 15° for N ≤ 24; walks to the nearest
  free slot; picks the largest gap past 24; `hueConflict` finds the neighbour across 359→0.
- server: default assignment is unique on a fresh team; explicit collision refused naming the
  neighbour; migration backfills a pre-v65 DB collision-free; the route round-trips and the roster
  shows the new hue; a non-admin cannot set another member's hue; revive keeps the hue.
- CLI: `--hue` reaches the create body; `hue` prints and sets; a collision renders the server's
  message.
- web: stored hue wins, null falls back to the hash; the office node's colour comes from the
  stored hue.

### ADR

Next free number, recording the decision (hue not hex; bands dropped; uniqueness by separation;
where authority sits) with falsifiers.

## Out of scope

The office surfaces themselves (lane 01M1MM1Y5H): rail dot, nameplate and bubble borders, sender
prefix, act glyphs, the broadcast notice, the asks rail. File-declared hue for file-backed teams.
A colour swatch in the terminal roster.
