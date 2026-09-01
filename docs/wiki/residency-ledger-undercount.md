# Residency ledger undercount

Any session count read from `residency.session_captured` rows that crosses 2026-08-28 undercounts real sessions by an unmeasured amount — heal-path sessions before ADR 336's fix left zero rows for their whole life, and from 2026-08-31 until #1150 every hook attestation more than five minutes after a claim was refused and swallowed.

## The warning, for anyone counting sessions from the ledger

Before #1110 (merged 2026-08-31 as `a647b9cc`), a session that took the workspace slot by the
tool-boundary heal — gated at SessionStart beside a live-looking occupant, handed the slot at its
first tool boundary — was never attested. It ran, acted as the seat, and produced **zero**
`residency.session_captured` / `residency.session_ended` rows (2026-08-28; falsify: query the
`audit` table for digest `982f768adf12` — the incident session in
[ADR 336](../decisions/336-attestation-follows-the-slot.md) — and find any row).

So a residency-based read — sessions per seat per day, wake cost per session, "was this seat
occupied at time T" — is a floor, not a count, for any window touching pre-`a647b9cc` data. Do not
compare session counts across 2026-08-28; say the undercount instead. ADR 336's Consequences names
this; this page exists so an analyst hitting the `audit` table finds it without reading the ADR.

Known instances, both 2026-08-28, both found by reading the `messages` table against the ledger:

- seat `ryder`: a two-hour interactive session (claimed a lane, closed one) — digest
  `982f768adf12`, zero rows; the newest row the daemon held for the seat was a wake child ended
  ninety minutes earlier.
- seat `dolly`: the superseded-seat overlap on lane `01KZ9GQN3EC77` — the second session of the
  pair was recoverable only from `messages` (dolly, first-hand, on #1110's review thread).

The general method when the ledger disagrees with behaviour: the `messages` table is the stronger
witness — a seat that sent acts had a session, whatever the ledger says.

## What the fix guarantees, and what it does not

Since `a647b9cc`, the tool boundary reconciles: an un-ended slot with no `attested_at` is announced
once, stamped only when the push lands (`attestSlotIfUnattested`, plus the same re-read pattern on
the capture path). Bounds that stay true after the fix:

- A gated session that never reaches a tool boundary still announces nothing — it also did no work.
- An unreachable daemon leaves the slot due, so the row can arrive minutes late; `started_at` never
  travels, so row timestamps were never session start times (ADR 336 Consequences).
- Co-tenancy (two live sessions on one seat) is still not signalled to either session; the ledger
  now sees both, but nothing tells them about each other.

## Post-fix live observation — made 2026-09-01

~~The post-change arm of ADR 336's experiment is unit tests only (five tests, four mutations). The
owed live observation — a real gated-then-healed session producing its first
`session_captured` row at a tool boundary on a build ≥ `a647b9cc` — has not been made yet
(2026-08-31; falsify: a dated entry below records it).~~ **Made 2026-09-01 13:26–13:28, seat
`ryder`, daemon on `8e1ff296`, CLI `main` + #1150** (falsify: the three `audit` rows below, and
`heal-probe-rig/run.sh` on this page's branch, which stages the sequence again in ~90 s).

The staged sequence, in a throwaway workspace bound to the seat: P1 takes the slot at SessionStart
and runs 40 s; P2 starts 8 s later beside the live P1 and is gated; P1 exits and is stamped ended;
P2's first tool boundary (~65 s in) heals the slot and — the fix under observation — attests it.

| local time | row | session |
| --- | --- | --- |
| 13:26:27 | `residency.session_captured` | P1, digest `ecf551d9e790` — at SessionStart |
| 13:27:19 | `residency.session_ended` | P1 |
| 13:27:44 | `residency.session_captured` | P2, digest `80bfa11e0b97` — **64.8 s after P2 started**, at its first tool boundary after P1's end; no earlier row for the digest |

Exactly one row for P2 although it made two tool calls — the boundary is idempotent, as the unit
tests claimed. P2's `binding.session` reads `started_at 13:26:39`, `attested_at 13:27:44`: the
detector signature below, seen for real.

Two things the rig had to learn, both measured: `claude -p` fires **no SessionEnd** (neither probe
transcript carries one), so P1 never stamps `ended_at` on its own and P2 would sit gated for the
whole `LOCAL_SESSION_LIVE_MS` window — the rig stamps P1's end the way an interactive exit does;
and a foreground `sleep` is hook-blocked in the child harness, which collapsed the first runs to
~10 s and staged nothing.

**What this observation does and does not say.** The mechanism observed is ADR 336's (#1110): a
healed slot announced at the tool boundary. #1150 is a precondition of seeing it, not the mechanism
— without it no probe row lands at all, for the reason in the next section — so this is the
post-change arm on `a647b9cc` **plus** #1150, and the pre-#1150 build cannot produce the
observation on any workspace older than five minutes.

## A second cause, live from 2026-08-31 until #1150: the five-minute lease

#1119 (ADR 337, merged 2026-08-31 as `7498d25f`) moved `POST /residency/session` from key-only
auth to `authClaimedAgent`, which requires a live agent session lease. `binding.session_lease` is
minted once, at claim, and lives five minutes (`AGENT_SESSION_LEASE_TTL_MS`). The attestation push
in `session.ts` presented that stored lease and never reclaimed — #1119 gave it the lease but not
the reclaim every other CLI path got — so **every SessionStart / SessionEnd / heal-path attestation
more than five minutes after the claim was refused with `401 invalid, expired, or revoked agent
session lease` and the refusal swallowed as "daemon unreachable": local slot written, no ledger
row (2026-09-01, seat `ryder`; falsify: on a build before #1150, POST the route with the binding's
stored lease and read the 401; the same credential and lease on `GET /members` answer 200).**
Consistent with the ledger's shape — 1229 `captured` against 622 `ended` all-time, 211 against 87
over the seven days to 2026-09-01 — though that ratio is suggestive only, since a session can also
end uncleanly. SessionStart usually landed because a claim had just happened; SessionEnd, hours
later, essentially never could.

#1150 reclaims once, in reply to the refusal, and never before it (a claim per hook was the
2026-09-01 storm, #1138/#1143). The minted lease is not written back: the one-shot's socket close
releases the Presence it is bound to, which the server reads as a dead lease — a second hook
presenting it was refused in ~1 of 4 runs, the other 3 being the close still in flight. A lease
that outlives its socket is a server decision under ADR 337.

For an analyst: the undercount window for this cause is `7498d25f`..#1150, for every seat, and it
is heaviest on `session_ended`.

One gap #1150 keeps, on purpose (2026-09-01; falsify: read `heldElsewhere` in
`packages/cli/src/commands/session.ts`): a hook whose seat is live in **another** workspace never
claims, because that claim would supersede the live adapter — so a SessionStart in a second
worktree while the adapter runs in the first attests nothing, and the slot stays unattested rather
than evicting. Two worktrees on one seat is the ordinary shape here. That is a recorded gap where
there was a silent eviction; count it as one. It also constrains the probe rig above: it stages a
row only while no adapter is live elsewhere on the seat, which is why the 13:26 run — made before
the rule — could evict this page's author's own adapter, and a re-run under #1150 as merged cannot.

The signature to watch for, usable as a detector: a workspace `binding.json` whose
`session.attested_at` is minutes after `session.started_at`, whose digest's **first** audit row
carries that late timestamp, with no earlier row for the digest. (A lost-stamp reconcile looks
similar but has an early first row — seat `ryder`'s session of 2026-08-31 14:09, digest
`e0ac6abbd891`, is that benign shape: captured at start, re-announced at 14:10:33.) The natural
trigger needs a newcomer starting within `LOCAL_SESSION_LIVE_MS` (10 min) of a still-live occupant
that then ends — wake child beside an interactive session is the common case.
