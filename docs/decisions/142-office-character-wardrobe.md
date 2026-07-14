# 142 — The office character wardrobe: everyone varies, except the one thing that identifies them

- Status: accepted — 2026-07-13
- Date: 2026-07-13

## Context

ADR 133 replaced the Rive rig with a procedural skeleton, so office members finally walk and sit. But every
member was still drawn from **one hard-coded look**: `SKIN = '#f0c9a0'`, one hair cap, no legs to speak of.
A floor of nine people was a floor of nine identical figures in different-coloured shirts. That is a worse
failure than it sounds — a room of clones does not read as _a team_, it reads as a chart.

Two further problems were visible on the live dashboard:

- **The head was the loudest shape on the character** — a big pale sphere that swallowed the body.
- **Seven of the twelve desks faced north or west**, so most of the team showed the viewer the back of their
  head. A face is the single thing that makes a member read as a person rather than a coloured block, and
  almost nobody had one pointed at the camera.

## Decision

**Vary everything about a person except the one thing that says who they are.**

### The identity read is load-bearing, and it lives on the top

A member's `color` (`memberColor(name, kind)`) is not decoration. It is the same hue as their roster dot,
their label and their desk, and it is how a human picks _miley_ out of a crowded floor at a glance. So:

- **The top keeps the identity hue.** It varies by **cut**, not colour — tee, long-sleeve, stripe, hoodie,
  vest. (`bareArms` is the strongest of these: a short sleeve changes the forearm's _colour_ to skin, which
  at 90 units tall is a bigger difference than any pattern could be.)
- **Everything else runs free** — skin, hair style/colour/length (including **bald**), facial hair, hats,
  trousers, shoes.

`Appearance` deliberately has **no top-colour field**, and a test asserts its absence: adding one would
silently break the agreement between the body, the roster and the label, and nothing else would fail.

Skin spans a full rainbow — deep browns through to mint, periwinkle and coral — in **one list**, natural and
fantastical together, so no member is ever "the odd one out". These are stylised block people; a floor where
everyone is a slightly different beige is both duller and a worse look than one where people are plainly,
cheerfully different.

### Contrast is a constraint, not a preference

With a rainbow skin palette, an _independent_ hair pick eventually puts green hair on a green head — and at
30px that is not a person, it is a blob. Both hair and hat colours are therefore chosen by walking their
palette from a hashed start and taking the **first entry with real brightness separation from the skin**
(`pickContrasting`). Still deterministic, still uncorrelated in _which_ colour you get; it just refuses the
invisible ones. Both failures (green-on-green hair, a teal beanie on a teal head) shipped in the first pass
and were caught by the character sheet.

### The face is billboarded, not projected

The first cut placed eyes and visor at a `+z` offset in character space — geometrically correct, and it
looked terrible. **On a 2:1 iso floor, "south" projects to down-_left_, not straight down**, so offsetting a
face along its facing slides it onto the cheek: the visor read as a _monocle_. Leaning it "only a little"
just made a smaller monocle.

So the face does not use the projection at all. It is laid out in **pure screen space, centred on the
skull** — level, symmetric, like a sticker on the front of a ball. The _body_ already tells you which way a
member is turned; the face only has to be legible, and at 25px across, legible means centred. Hair and hats
are drawn as a disc **clipped to the head**, which is what produces a clean hairline instead of a beret
balanced on a ball.

### Two desks turn to face the room

Desks 4 and 8 flip from `N` to `S`. Kept to **two**: turning the whole floor toward the camera would make
the room read as a stage set rather than an office.

### The agent/human tell survives the wardrobe

Agents keep **antenna + chest LED + visor** — and the antenna is the _only_ tell visible from behind, so it
is short and stubby rather than long and thin. Agents get no facial hair (there is nowhere for it to read
under a visor, and a bearded robot muddies the one tell the office cannot afford to lose). Humans get eyes,
a blink, and optional facial hair. A hat does not hide an antenna: it pokes through, which is the correct
joke.

### `/character-sheet`

A new design fixture (like `/office-preview`): the character rendered at ~4×, at every facing, in every
pose, across two dozen names. **This is not a nicety.** The office draws people ~40px tall, and at that size
a wardrobe bug is invisible until it ships — the green-on-green head, the beach-ball afro and the monocle
visor were all _already on screen_ and all three were invisible to me in the office view. Iterating on a
character inside the office is flying blind. The sheet shows the **distribution**, which is the thing that
actually matters: nobody cares whether one member looks good, only whether the whole floor does.

## Consequences

- `appearance.ts` is pure and deterministic — same name → same person, across frames, reloads and machines,
  exactly like seats and colours already are. It is `Pick<OfficeNode, 'name' | 'kind'>` in, look out; no
  clock, no randomness, nothing to cache.
- The character is now **three files with hard lines between them**: `skeleton.ts` (animation, no renderer),
  `appearance.ts` (identity, no renderer), `character.ts` (renderer, no animation and no identity). The 3D
  door ADR 133 opened stays open: a future glTF path replaces `character.ts` alone, and both the walk cycle
  and the wardrobe survive it — an `Appearance` maps to material/mesh choices just as readily as to fills.
- **No new inputs and no wire change.** Every look is derived from the member's existing `name` + `kind`.
  Nothing to migrate, nothing to store, nothing for a member to configure — and therefore nothing that can
  drift out of sync with the roster.
- A member's appearance is **not user-settable**. That is a deliberate non-goal here: the moment a look is
  chosen rather than derived, it needs storage, a UI, and a policy for what happens when two members pick
  the same thing. If we ever want it, it is a new ADR with a real design, not a field bolted onto this one.

## Observability & Evaluation

- **Traces:** n/a — a browser-side rendering change inside the `/live` office canvas. It emits no protocol
  acts, reads no new server state, and adds no inputs: an `Appearance` is a pure function of the `name` and
  `kind` the roster already carries. Nothing to instrument that ADR 089–091 does not already cover for the
  acts that drive the scene.
- **Eval:** n/a — no agent-facing model decision and no dataset to score. The office is a decorative
  surface; the roster (`RosterPanel`) remains its accessible, load-bearing counterpart (08-web.md), so
  nothing an agent or human _acts on_ depends on how a member is drawn. What is machine-checkable is
  asserted instead in `appearance.test.ts`: determinism, spread across a roster, hair/hat contrast against
  skin, hats and facial hair staying _rare_, traits picked independently, the agent tell intact, and — the
  load-bearing one — that no top-colour field exists.
- **Experiment:** n/a — no behavioural variant and no flag. A single deterministic renderer change, verified
  visually against `/character-sheet` and `/office-preview`, driven headless.
