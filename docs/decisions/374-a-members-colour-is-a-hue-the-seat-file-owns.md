# ADR 374: a member's colour is a hue the seat file owns

**Status:** accepted · 2026-09-03 · miley (designer) · reviewed by dolly (ask 01M1MMBAY3) · asked by nick
**Lane:** 01M1MM0VGJKYFSHP3Q1C10BTQN · **Spec:** docs/superpowers/specs/2026-09-03-member-hue-design.md

## Context

Every surface that paints a member — the office floor, the nameplate, the roster avatar, the
stream chip, the asks strip — takes its colour from one number, `memberHue(name, kind)` in
`packages/web/src/live/format.ts`: a hash of the *name*, agents banded 150–280°, humans 320–70°.
Nothing stored it, nothing could change it, and nothing stopped two teammates hashing to hues a
glance cannot tell apart. nick asked (2026-09-03) for a colour that is assigned when a member is
created, can be customised by whoever creates them, is unique on the team, and is the *same*
colour everywhere.

Two facts shaped the answer:

1. **The a11y story lives in the hue.** `memberAvatar` (white initials on a fill) and `memberInk`
   (the name as text on paper) solve for a lightness *from the hue* at which the colour clears
   WCAG AA. Storing a hex would hand that gate back to the human who typed it.
2. **On a file-backed team, `members` is a projection** of `.musterd/seats/*.toml` via git
   (federation-data-census: "D (git)"); the sync layer carries no member rows. A colour that lived
   only in the DB column would be a different colour per machine — dolly's review finding, verified
   against `projection/reconcile.ts` before it was taken.

## Decision

1. **A member's colour is one integer, `hue` 0–359, an HSL degree.** Never a hex. `MemberSchema.hue`
   is nullish; the roster carries it; every colour function takes it as an optional third argument
   and falls back to the old name hash, to the degree, when it is absent — a pre-374 daemon renders
   exactly as before.
2. **On a file-backed team the seat file owns it**: `hue = 212` in `seats/<name>.toml`. Reconcile
   projects it on ADD, UPDATE and REVIVE and writes NULL when the file has none. The daemon never
   invents a hue for a file-backed member. On a DB-only team the daemon is the source and assigns at
   `addMember` when the caller says nothing.
3. **Uniqueness is measured in OKLCH hue, not HSL degrees.** `HUE_MIN_SEPARATION = 12` OKLCH
   degrees at the web's fill (`hsl(h, 68%, 62%)`); `hueSeparation` converts both ends before it
   measures. An explicit hue within that of a live teammate's is refused, naming them, at creation
   and at set. Departed seats hold no hue against anyone.
4. **Assignment is a walk, never a refusal.** `assignHue(seed, taken)` returns the seed if clear,
   else the nearest clear hue walking outward on both sides; past a full wheel it returns the hue
   farthest from its nearest neighbour and the CLI says `colour shared with <name>` out loud.
5. **No migration backfill.** v65 adds the column and nothing else. `musterd team hue
   --assign-missing` colours a roster that predates hues, seeded from the hue the web painted each
   seat with before (`legacyHue`, the banded hash) and moved only when it collides, so the colours
   people know survive and the pass is a reviewable diff. The full-wheel default (`defaultHue`, no
   bands — nick's call) is for *new* seats.
6. **Where it is set:** `musterd agent|human|team add … --hue <deg>` at creation; `musterd team hue
   <name> [<deg>]` after — the file on a file-backed team, `POST /teams/:slug/members/:name/hue` on a
   DB-only one (the member themself or a team admin; the route refuses on a file-backed team and
   points at the file). Under `team`, not a 47th top-level verb (dolly, per the surface survey
   #1245).

## Measured

- HSL hue is not perceptually uniform: fifteen HSL degrees between 105° and 120° is ~5° of OKLCH
  hue (fill-to-fill ΔE 0.026 — two greens); between 180° and 195° it is ~27° (ΔE 0.09 — cyan
  against blue). A 5× spread across the wheel; a 15° HSL rule would have seated a third of the team
  in greens that read as one.
- A greedy walk from hashed seeds fits fewer seats than 360/separation: at 15° OKLCH it seated
  17–20 over fifty trials (median 18 — the dogfood team has 18); at 12° it seated 22–26 (median 24),
  with a fill-to-fill ΔE of ~0.035 at the closest pair. Hence twelve.

## Consequences

- Reconcile is the writer of `members.hue` on file-backed teams; a hand-edit to a seat file is the
  supported way to recolour, and `team hue` is that edit with a collision check.
- The web threads `hue` through the ~17 call sites that already read `kindOf(name, idx)` (now beside
  `hueOf`). A module-level name→hue map would have touched fewer files and was rejected as a hidden
  global. `@musterd/protocol/hue` is not imported by the web bundle — `legacyHue` and the web's
  fallback are the same formula, pinned equal by a web test — to keep those bytes off `/live`'s graph.
- A `member.hue_assigned` audit row for the past-full-wheel case is deferred: nothing reads one yet,
  and a new replicated audit kind is the seam ADR 371 settled. The CLI warning carries the fact.
- Follow-ups: the office surfaces that wear the colour (lane 01M1MM1Y5H); a colour swatch in the
  terminal roster.

## Observability & Evaluation

- **Traces:** none new. A hue change on a file-backed team is a git commit to `seats/<name>.toml`
  (author, time and diff already recorded); on a DB-only team it is `members.updated_at` on the row.
  The past-full-wheel case prints `colour shared with <name>` at assign time; an audit row is deferred
  until a surface reads one (Consequences).
- **Eval:** the dry run against a copy of the dogfood roster on 2026-09-03 is the baseline: 18 seats,
  none coloured; the legacy hash had `grokbot`/`ryder` at **0.0°** apart (one colour) and the agent
  band held 17 seats; `--assign-missing` moved 10 of 18 off their legacy hue and left the closest pair
  at 12.1° OKLCH (`dolly`/`compo`). Re-run `musterd team hue --assign-missing` on a copy after any
  change to `assignHue` or the separation and compare: fewer moved at the same floor is better;
  a closest pair under the floor is a regression.
- **Experiment:** n/a — no user-facing metric to A/B; the question "can you tell two seats apart"
  is answered by the ΔE measurement, not by traffic.

## Falsifiers

- Two daemons reconciling the same seat files report the same hue per name
  (`reconcile.test.ts`, "two daemons").
- A file that drops its hue projects NULL on the next reconcile.
- `assignHue` over twenty hashed seeds yields pairwise separation ≥ 12° OKLCH; past a full wheel it
  still returns a hue that is not a duplicate (`hue.test.ts`).
- `POST …/hue` with a colliding value is 409 naming the neighbour; a non-admin recolouring a
  teammate is 403; 360 is 400 (`hue-http.test.ts`).
- `team hue --assign-missing` leaves every already-coloured seat file byte-identical and moves a
  seat only off an occupied hue (`team.hue.test.ts`).
- `memberHue(name, kind)` with no stored hue equals `legacyHue(name, kind)` for every name tried
  (`format.test.ts`).
