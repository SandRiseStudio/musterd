# A member's colour is a fact the team owns — design

**Date:** 2026-09-03 · **Lane:** 01M1MM0VGJKYFSHP3Q1C10BTQN · **Seat:** miley · **Asked by:** nick ·
**Reviewed by:** dolly (ask 01M1MMBAY3, accepted with four findings — all taken, see *Review*)

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
- `HUE_MIN_SEPARATION = 12`, **in OKLCH degrees** — the stored number stays an HSL degree (it is
  what CSS and the canvas consume); `hueSeparation(a, b)` converts both to OKLCH hue at the web's
  fill (`hsl(h, 68%, 62%)`) before it measures. **HSL hue is not perceptually uniform** (finding
  2), and it was measured before the metric was chosen: fifteen HSL degrees between 105° and 120°
  is ~5° of OKLCH (ΔE 0.026, two greens); between 180° and 195° it is ~27° (ΔE 0.09, cyan against
  blue) — a 5× spread across the wheel. Twelve rather than fifteen because `assignHue` is greedy
  from hashed seeds and a greedy walk fits fewer seats than 360/separation: at fifteen it seated
  17–20 over fifty trials (median 18; the team has 18), at twelve 22–26 (median 24).
- `defaultHue(name): number` — the existing golden-ratio hash, over the full wheel.
- `assignHue(seed, taken: readonly number[]): number` — the nearest hue to `seed` (walking outward
  alternately ±1°) that is ≥ `HUE_MIN_SEPARATION` from every value in `taken`, on the circle. When
  no such hue exists (more than 24 seats) return the midpoint of the largest gap: still the most
  distinct choice available, never a refusal at creation.
- `hueConflict(hue, taken): number | null` — the first taken hue within the separation, or null.
- All three are pure and shared by server and CLI, so the two cannot disagree about what "taken"
  means.

### Seat file — `packages/protocol/src/seatfile.ts` (the source of truth on a file-backed team)

- `hue = 212` — optional integer 0–359 in `.musterd/seats/<name>.toml`. On a file-backed team
  **the file owns the hue and the DB column is its projection**, exactly like every other member
  fact the team owns (`role`, `lifecycle`, `working_hours`, `slack_user_id`). `members` never
  replicates row-by-row (federation-data-census: "D (git)"); the seat file travels with the repo,
  so two machines reconcile the same hue. A DB-invented hue would have been a different colour per
  machine — dolly's finding (1).
- **A file without a hue projects NULL**, and the web falls back to today's hash — which is
  deterministic, so every machine still agrees. The daemon never invents a hue for a file-backed
  member.

### Server

- **Migration v65**: `ALTER TABLE members ADD COLUMN hue INTEGER` (guarded, the v31 pattern).
  **No backfill.** A backfill would recolour the whole dogfood team in one upgrade (finding 3) and,
  on a file-backed team, would be overwritten by the next reconcile anyway. Hues are assigned by
  the CLI pass below, where they are reviewable.
- **Reconcile** (`projection/reconcile.ts`): `hue` joins `MemberIdentityFields` — projected on ADD,
  REVIVE and UPDATE, compared like the other fields, `seat.hue ?? null`. Reconcile is the writer
  (finding 8).
- `AddMemberInput.hue?: number | null`. Explicit → validate 0–359 and refuse a collision with the
  live members of the team: `MusterdError('conflict', 'hue 210 is within 15° of "ryder" (214)')`.
  Absent → on a **DB-only team** (no roster home) the server assigns via `assignHue`; on a
  file-backed team the value comes from the file (the CLI wrote it there before `addMember`, the
  ADR 058 §5 order).
- `MemberRow.hue: number | null`; `toMember` maps it; `MemberSummary` carries it.
- **Route** `POST /teams/:slug/members/:name/hue` `{ hue }` — the member themself or a team admin
  (`resolveCapabilities(viewer).is_admin`), the governance-route split. DB-only teams only: on a
  file-backed team the route refuses with "edit `.musterd/seats/<name>.toml` — the file owns it",
  the same refusal `team add` gives for a file-backed roster.
- `AddMemberBody.hue` optional on `POST /teams/:slug/members`.

### CLI

- `musterd agent <name> --hue <0-359>`, `musterd human … --hue`, `musterd team add … --hue`. On a
  file-backed team the CLI reads the other seat files, takes their hues, and writes
  `assignHue(defaultHue(name), taken)` — or the explicit value, refusing a collision by name —
  into the new seat file before calling `addMember`. On a DB-only team it passes the flag through.
- `musterd team hue <name> [<deg>]` (under `team`, beside `credential` — a per-member roster
  fact; not a 47th top-level verb, finding 5). Bare prints the member's hue and where it comes
  from. With a degree: file-backed → parse the seat file, set `hue`, `serializeSeat`, write (the
  `role.ts` edit pattern), refusing a collision against the other seat files; DB-only → the route.
- `musterd team hue --assign-missing` — the one-time pass that gives every seat without a hue one,
  **seeded with today's banded hash** (`memberHue(name, kind)` as the web computes it now) and
  walking only the seats that actually collide, so the colours people already know survive the
  upgrade and only the near-duplicates move (finding 3). Full-wheel `defaultHue` is for NEW
  members. Writes the seat files (file-backed) or calls the route per member (DB-only); the
  result is a reviewable diff.
- Past 24 seats `assignHue` returns the largest-gap midpoint; the CLI prints
  `colour shared with <name> — the wheel holds 24 fully separated hues` at assign time (finding 4:
  said out loud, never refused). Not an audit row yet — nothing reads one, and a new replicated
  audit kind is the seam ADR 371 just settled; when the roster wants to say "colour shared", add
  it then.
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
- protocol: the 24-slot ΔE falsifier above.
- server: reconcile projects a file hue on add / update / revive and NULLs it when the file drops
  it; DB-only default assignment is unique; explicit collision refused naming the neighbour; the
  route round-trips on a DB-only team and refuses on a file-backed one; a non-admin cannot set
  another member's hue; **two daemons reconciling the same seat files report the same hue per name**
  (dolly's falsifier for finding 1).
- CLI: `--hue` lands in the seat file (file-backed) or the create body (DB-only); `team hue`
  prints, sets, refuses a collision by name; `--assign-missing` seeds from the banded hash and
  moves only colliding seats; the past-24 warning prints.
- web: stored hue wins, null falls back to the hash; the office node's colour comes from the
  stored hue.

### ADR

Next free number, recording the decision (hue not hex; bands dropped; uniqueness by separation;
where authority sits) with falsifiers.

## Out of scope

The office surfaces themselves (lane 01M1MM1Y5H): rail dot, nameplate and bubble borders, sender
prefix, act glyphs, the broadcast notice, the asks rail. A colour swatch in the terminal roster.
A `member.hue_assigned` audit row (see the CLI section for when).

## Review (dolly, 01M1MMF2H6, 2026-09-03)

Accepted approach C and hue-not-hex. Four findings, all taken: (1) on a file-backed team the seat
file must own the hue or the colour differs per machine — restructured above, the file is the
source and the column its projection; (2) HSL hue is not perceptually uniform — the ΔE falsifier
decides the metric; (3) a migration backfill would recolour every existing seat at once — no
backfill, `--assign-missing` seeds from today's hash and moves only collisions; (4) past 24 seats
the shared colour must be said, not silent — the CLI says it (an audit row deferred, reason
above). Also taken: `team hue` rather than a top-level verb (5). Confirmed as-is: self-or-admin
authority (6), explicit pass-through over a module map (7).
