# Presence honesty — evidenced working/active, textured offline, owned desks

**Date:** 2026-08-19 · **Author:** miley, from a design conversation with nick
**Status:** spec for review — implementation lanes follow the rollout order in §5

## 1. The problem

The presence model answers "is a process connected", but a seat is an identity with a
lifecycle. Two measured symptoms:

- **`idle` is unreachable for agents.** `resolveActivity` (ADR 010/155) reads a live agent
  `working` from its first `status_update` until the session dies — the decay window
  (`idleAfterMs`) is passed for humans only. Every seat posts a status at session start
  (the hooks say to), so an agent has exactly two observable states: working-while-online
  and vanished. nick has never seen a member `idle`; this is why.
- **Offline is a trapdoor.** The floor removes offline members entirely
  (`seating.ts: isGone → { kind: 'gone' }`), so a 10-seat team with two live sessions
  renders as a nearly empty room. The wire already carries the evidence to do better
  (`offline_reason`, `last_seen_at`, `wakeable`, effective `working_hours`) and the
  floor reads none of it.

**Principle (nick):** online/working vs online/active vs offline should be *as honest as
we can get*. Every rendered state must be earned by evidence the daemon actually has;
working hours are optional and nothing may depend on them existing.

## 2. States and derivation

### 2.1 Online: `working` decays to `active` — for everyone

Extend the ADR 155 Inc 3 status-age decay to agents. `working` requires *fresh* evidence:
a `status_update` within the window, or a live steering link (steering keeps outranking
decay — a driver link is a current action). Past the window the **state** decays but the
**claim is kept with its age**: the label renders `last: "<status>" · 20m ago`, never
erased. Deriving from `last_status_at` only; `quiescence` (ADR 219) stays decision-grade
and deliberately out of posture, as its schema comment demands.

- **Windows:** humans keep `presenceTimeoutMs` (45 s, unchanged). Agents get their own
  generous window, default **15 min**, config-overridable (`MUSTERD_AGENT_IDLE_MS` or
  equivalent). Accepted consequence: a heads-down agent that hasn't posted in 20 minutes
  reads `active` with a stale claim — the claim *is* stale; hooks already nudge status
  at task boundaries.
- **Rename `idle → active`** on the wire (posture + activity vocab), not as a display
  alias — ADR 138's rule is "clients render the wire token, no synonyms". Feature-epoch
  bump; old `idle` accepted on read for compat. "Idle" always described absence of a
  claim, not rest; `active` says what it is: connected, between claims.

### 2.2 Offline: texture derived from existing evidence, zero new wire fields

Rendering derives client-side from fields already on `MemberSummary`:

| Evidence (first match wins)             | Chip reads                          |
| ---------------------------------------- | ----------------------------------- |
| reclaim grace live (`reclaimable`)       | `reconnecting`                      |
| sticky `disconnected`                    | `disconnected · 12m` (adds age)     |
| sticky `session_ended` (new, §2.3)       | `session ended · 20m`               |
| sticky `seat_released` (new, §2.3)       | `seat released · 2h`                |
| outside effective `working_hours`        | `off shift` (+ `back 11am`)         |
| enrolled `wakeable`                      | `offline · wakeable`                |
| none                                     | `offline · 3d` — bare age, no claim |

Off-shift ranks above wakeable ("it's 2am" explains absence better than "you could wake
them"); a wakeable off-shift seat renders both: `off shift · wakeable`. No declared hours
→ the off-shift flavor never appears. Ages are coarse crumbs (`3d`); precise timestamps
stay on hover. We deliberately claim no per-seat "will wake on inbox/cron" beyond what
`wakeable` (ADR 131 residency) attests.

### 2.3 Offline-reason vocab split (ADR 141 amendment)

`signed_off` conflates deliberate exits. Split the sticky stamp:

| New stamp       | Stamped by                                            | Chip           |
| --------------- | ----------------------------------------------------- | -------------- |
| `left_team`     | `team_leave` / soft-remove (`leaveMember`)            | `left team`    |
| `seat_released` | explicit seat release / unbind (`markSignedOff` call sites) | `seat released` |
| `session_ended` | clean session exit — **new**: CLI/harness sends a graceful release on normal shutdown | `session ended` |
| `disconnected`  | presence ended without a goodbye (unchanged)          | `disconnected` |
| `signed_off`    | legacy rows: accepted on read, never newly stamped, renders as `seat released` | |

`session_ended` is what stops a normally-finished agent turn from wearing crash clothing —
today a clean process exit stamps `disconnected`. `disconnected` becomes the only alarming
flavor, and means it.

## 3. Chips and roster

The token is the chip; the evidence is the suffix. Online: `working` + status text (as
today); `active` + `last: "<status>" · 20m ago` (or `no status yet`); away/dnd unchanged
(self-set outranks, ADR 044). Offline: the §2.2 ladder. Roster ordering stays
posture-ranked; within offline it sorts by the same ladder, so actionable flavors
(reconnecting, disconnected) float and off-shift/old-dark sink.

**dnd is prominent on the nameplate** (nick): a mono `dnd` tag on the *collapsed* plate —
same slot grammar as the `service` tag (PR #899) — in `--lc-warn-ink` on a filled pill,
dot in the away color, plate rim tinted to match. Visible at both scales without
expanding.

## 4. The floor

**Owned empty desks.** Every offline member except `left_team` keeps a desk: chair in,
monitor dark, a small desk nameplate *baked into the canvas* (static paint; floating
labels stay present-only, so label cost doesn't grow). `left_team` members leave the room
entirely — `left_at` is the line, not presence. Flavor texture, all static paint keyed to
data refreshes (still-mode safe by construction, no new rAF):

- **warm desk** — screen glow fades with `last_seen_at` over the first ~hour.
- **disconnected** — a small amber warning glint on the desk nameplate.
- **off shift** — desk lamp off, cold screen; whole-team off-shift composes with the
  day-cycle-lighting increment into "the office at night".

**Desk capacity rule.** Present members claim desks first, exactly as today (zero
regression); non-left offline owners then fill remaining slots by the same name-hash
probe; when desks run out, longest-gone lose theirs first. Deterministic; normal rosters
keep every desk.

**Three pictures for the three non-working ways to be present:**

- **`active` → leisure spots** (nook couch, reception chairs, meeting table) — the
  existing idle mapping, finally reachable. Pose: leaning back, no screen glow. The decay
  produces an honest walk: `working → active` strolls desk→couch on the existing walk
  choreography; a fresh status walks them back. Flap bounded by the 15 min window.
- **`dnd` → their own desk, headphones on** (accessory rig exists) — dnd usually means
  *working, don't interrupt*. Desk and screen glow kept; choreography never walks to
  them; no speech lands on them; plus the §3 plate tag.
- **`away` → body off the floor** — jacket over their chair, `stepped away` on the desk
  nameplate. Away is declared absence; a body loitering on a rug contradicts the claim.
  (This also un-crowds the nook: today `away` clusters on the same rug the couch sits
  on, so idle-on-couch and away-in-nook were one picture.) The nook keeps its megaphone
  stage job.

## 5. Stream reading and rollout

On `/broadcast` everything arrives via the shared room (`officeRoom`). Stream notes: desk
nameplates and reason crumbs bake at stream scale (≥ ~13 px pre-encode, same floor as the
reel type), and the overlay's roster count adopts the vocabulary — `4 working · 2 active ·
3 off shift` beats `4 online`.

Rollout, one lane each, in order:

1. **Offline-reason vocab split** (§2.3) + graceful release on clean CLI exit — server +
   CLI + ADR; no UI.
2. **Agent decay + `idle → active` rename** (§2.1) + chip copy (§3) — the semantic core;
   ADR amending 155/138/140.
3. **Owned desks + offline texture** (§4) — pure web, biggest visual payoff.
4. **Away/dnd/active floor split + dnd plate tag** (§3–4) — pure web.
5. **Off-shift dimming** — lands with/inside the day-cycle-lighting increment of the
   office-liveliness ladder (separate program: celebrations, day-cycle lighting, seeded
   idle life, work-tracking sound; couch chats explicitly cut).

## 6. Non-goals

- No `quiescence` in posture (ADR 219 separation stands).
- No claimed wake-ability beyond ADR 131 `wakeable`.
- No new always-on motion: every new visual is static paint on data change; the only new
  movement is reseat walks on real state changes, via existing choreography.
- Couch *chats* stay cut (nick, 2026-08-19).

## 7. Open questions (to settle in the implementation ADRs)

- Exact agent decay window default (15 min proposed) and its config knob name.
- Whether the `active` rename ships one epoch with the decay (proposed: yes, one ADR).
- Desk-nameplate contrast: measure on the baked paper via `pnpm a11y:contrast` — the
  fixture team must seat an offline member so the gate can see one (`/office-preview`
  gains one, same argument as Jib the service seat).
