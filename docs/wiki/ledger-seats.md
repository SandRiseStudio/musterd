# Ledger seats

The three `kind = "service"` seats on the revive roster — what each one is for, why none of them can be woken or handed work, and where the autorefresh charter went when the roster could not carry it.

## What a ledger seat is (ADR 232)

A ledger seat is an unattended actor given a name on the roster so that what it does is legible in the stream the team already reads. It announces and it escalates. It never claims a lane, never reviews anyone's work, and never needs waking — the loop that drives it is a LaunchAgent or a timer, not an inbox.

The distinction that makes it worth a seat rather than a cron line: **its silence is a signal.** A human seat that stops posting has gone to bed. A ledger seat that stops posting is stuck, and somebody should look.

On this roster: `autorefresh`, `guardian`, `streamwatch` (measured 2026-08-24 from `.musterd/seats/*.toml`; falsify: `grep -l 'kind = "service"' .musterd/seats/*.toml`).

## autorefresh — the charter, moved here from the seat file

This prose lived as a `charter` key in `seats/autorefresh.toml` from ADR 232 until 2026-08-24, where nothing served it and `musterd fmt` deleted it on sight (see below). It is kept verbatim because it is the only written statement of what the seat is:

> You are the auto-refresher: musterd's own machinery that keeps the team daemon on the latest main. Every ~2 minutes you check whether new code has merged; when it has, you rebuild the daemon and briefly restart it, telling the team in the stream ('bounced the daemon on \<commit\>') so nobody has to wonder what just happened mid-standup. You are a ledger seat (ADR 232): you announce and escalate, but you never take on work, review anyone's changes, or need waking — if your updates stop appearing, that silence itself means you are stuck and a human should run `musterd service status`.

For how the refresher actually works — the log, the debounce stamp, and the three traps — see [the shared daemon](shared-daemon.md). This page is the seat; that page is the machinery.

## guardian and streamwatch carry no charter

Both are `kind = "service"` with `role = "platform"` and nothing else (2026-08-24; falsify: `cat .musterd/seats/guardian.toml`). The guardian's operating knowledge is on [platform guardian](platform-guardian.md) instead — which is where autorefresh's now is too. **A ledger seat's charter belongs on its wiki page, not in its roster file**, and the reason is the next section.

## Why the charter could not stay in the seat file

`charter` is in `RoleFileSchema` and **not** in `SeatFileSchema` (2026-08-24; falsify: read `packages/protocol/src/seatfile.ts` — `charter: z.string().optional()` sits at line 80 inside `RoleFileSchema`, and is absent from the object at line 45). Zod's default `.strip()` therefore discards it on parse, so:

- `musterd fmt` rewrites the file from the parsed value and **deletes the paragraph**;
- the daemon's reconcile drops it and, since #988, says so in the log;
- `fmt --check` names it as data loss rather than a tidy-up, since #985.

Three mechanisms now *report* the drop. None of them preserve the prose — which is the point. It was 587 authored characters reaching no reader (2026-08-24; falsify: `OccupiedFrame.charter` is declared at `claim-handshake.ts:143` and populated by none of the five sites that build the frame — four in `http.ts`, one in `ws.ts`. If any site sets it, a seat charter does have a delivery path and the key belongs in `SeatFileSchema` after all). **The falsifier fired 2026-09-03** — every site sets it — but only halfway: what they deliver is the ROLE's charter (see below), so the seat charter's drop is unchanged and the `SeatFileSchema` conclusion stands.

**Measured population, not a sample** (2026-08-24; falsify: `grep -hoE '^[a-z_]+ *=' .musterd/seats/*.toml | sort -u`): across all 15 seat files the only key outside the schema is `charter`, and it appears in exactly one file. This measurement exists because the claim it replaces was wrong for the opposite reason — see the correction below.

## Do not fix this by adding `charter` to `SeatFileSchema`

The obvious repair is the wrong one, and it is worth naming because it will keep looking obvious.

A role's charter is *delivered*: reconcile writes it to the `roles` table (`packages/server/src/projection/reconcile.ts:83`) and the primer injects it as a `## Your charter` section (`packages/protocol/src/primer.ts:37-39`). A seat's charter has no such path. ~~`OccupiedFrame.charter` is declared in the protocol (`packages/protocol/src/claim-handshake.ts:143`) and populated by **nothing** — all five places the server builds an occupied frame omit it (verified 2026-08-24)~~ **INVALIDATED 2026-09-03** — all five sites now set `charter: getRoleCharter(ctx.db, team.id, targetMember.role)`. The falsifier fired, and the timing is the point: this claim was committed at 13:42 on 2026-08-24 ([#1012](https://github.com/SandRiseStudio/musterd/pull/1012)) and [#1001](https://github.com/SandRiseStudio/musterd/pull/1001) (ADR 307, primer identity-neutral across worktrees) merged the delivery path at 14:00 the same day — **eighteen minutes later**, from an unrelated lane that was not thinking about charters at all. Note what is and is not delivered: the frame now carries the **role's** charter, so a seat's *own* charter still has no path, and the paragraph below still stands.

So adding the field to the schema would convert a **visible drop** into an **invisible stored-but-unserved value**, and would silence the warning #988 shipped to catch exactly this. That is the general rule this instance produced:

> **When a value is not reaching anyone, deliver it or delete it. Never store it more correctly.** Storing it better is what makes the next person believe it works.

Sibling instances found the same night (2026-08-21): ~~`config.modelDrift` — computed, tested, read by nothing~~ (**DELIVERED 2026-09-03 by [#1239](https://github.com/SandRiseStudio/musterd/pull/1239)**, `c88efaf2` — it prints one stderr line naming declared vs observed at MCP initialize; the page's own rule decided it, deliver rather than delete); `neverExercised` in the control registry; `ReconcileResult.errors`, discarded by every caller, so a corrupt seat file was silently excluded from the projection. Related: [correct by coincidence](correct-by-coincidence.md), [instrument silence](instrument-silence.md).

If a seat charter ever *should* be delivered, the change is a populated `OccupiedFrame.charter` and a primer that renders it — with the schema key landing in the same change, not before it.

## Correction — this hazard was called "latent" and was not

~~The unknown-key hazard in `fmt` is latent; no live roster file exercises it (2026-08-21, dolly, on #977)~~ **FALSIFIED 2026-08-21 by ryder**, corrected in #982: `seats/autorefresh.toml` carried the 587-character `charter` at the time the claim was written, so the hazard was active and had been for weeks.

The error is worth more than the fact. The claim came from sampling only the six `roles/*.toml` files — where the change under review happened to look — and generalising to `unknownRosterKeys`, a mechanism shared by three file classes. **A claim about a shared mechanism needs a sample from every class that shares it.** The measurement two sections up is that lesson applied: all 15 seat files, not the one the work touched.
