# Correct by coincidence

A value that stands in for the truth stays right only while the two happen to agree — and the fixtures that would have shown the disagreement are usually the same ones that made it invisible.

This is the noisy cousin of [instrument silence](instrument-silence.md): there the instrument says nothing, here it answers confidently and wrongly. Eight instances landed in one day (2026-08-20/21) across four subsystems, which is why it is a page rather than eight commit messages.

## The shape

A surface reports something it did not look at. It reports a **proxy** instead: a value that equals the truth under a condition nobody states, nobody checks, and nothing enforces. While the condition holds, the proxy is right — so tests pass, reviews approve, and the claim gets written into a title. When the condition breaks, the proxy is wrong *and silent*, because nothing was ever comparing the two.

Two questions catch it:

- **What would have to be true for this value to equal the thing it claims to be?** If you can answer, that is an unstated invariant — say it out loud and decide whether anything enforces it.
- **Could I construct the case where they differ?** If the fixtures cannot express it, the suite's green is not evidence about this claim at all.

## Instance: a position over an ordered log is a pair, not a number (2026-08-20; falsify: check out `5977771a`, keep the tie tests, and run `reaches every message when a ts tie straddles the page boundary` — reaching 220 of 220 means this claim is wrong)

`listInbox` orders by `ts ASC, id ASC`. Every position that walked that order stored only the `ts`. The proxy equals the truth exactly while no two messages share a millisecond.

Four places had it, found in sequence, each by fixing the one before:

1. **The paging cursor** — `since` filters `ts >` strictly, so a tie straddling the page boundary stranded the *whole* remainder: 220 messages, page one 200, page two **0**, and the drain loop read the empty page as "caught up". Fixed in [#946](https://github.com/SandRiseStudio/musterd/pull/946) by never splitting a tie group at the bound.
2. **The unread floor** — a message sharing the read cursor's millisecond could never appear as unread again, because the cursor only moves forward. Not stranded mid-walk: permanently invisible.
3. **`seen` in the ADR 090 delivery ledger** — `cursor.last_read_ts >= msg.ts` called a tied act *seen* while `listInbox` called the same act *unread*. One message, two surfaces, opposite answers. [#949](https://github.com/SandRiseStudio/musterd/pull/949).
4. **`slowestInboxLagMs`** — the backlog gauge dropped tied rows from its join, so it could report `0`, the caught-up value, while a message waited. Same PR.

The tell was available the whole time: `inbox_cursors` has stored `last_read_message_id` since it was written. The tiebreak was persisted and simply never read.

**Reachable, not theoretical.** Fan-out sends land sub-millisecond apart — `lane_warning`/`lane_open` pairs are observed 1 ms apart in live inboxes. It had not bitten yet: izzo measured 0 exact `ts` collisions in 205 rows of a live inbox (2026-08-20).

## Instance: the daemon reported the database it meant to open (2026-08-21; falsify: revert the `config.dbPath = db.name || config.dbPath` line in `index.ts` and run `index.test.ts` — a pass means this claim is wrong)

`createServer` takes `opts.db ?? openDb(config.dbPath)`. An injected handle never opens `config.dbPath`, but three readers reported it anyway: the startup log, the public `dbPath` accessor, and `db` on `/health` — the last of which exists, per its own comment, "so clients can confirm **which** database this daemon serves", and which the guardian turns into the `wrong_db` alert class.

The proxy holds because `openDb(p)` opens exactly `p`. So outside injection the two always agreed, and the value was **accidentally right** for the whole life of the code. It cost a real scare before it was named: izzo "nearly convinced myself I'd polluted the production database tonight" reading a daemon that was entirely in memory.

Fixed in [#953](https://github.com/SandRiseStudio/musterd/pull/953) by reconciling once where the handle is chosen, so all three readers are honest by construction rather than by three edits that can drift apart.

## Why it survived: the fixture could not construct the failure (2026-08-20; falsify: `grep -rn "ts: Date.now() + i" packages/` in history before `f60bae3f` and find a suite that seeds a `ts` collision — one would mean the case was expressible and simply untested)

Every fixture in the inbox family seeded `ts: Date.now() + i` — strictly increasing. A tie was **unconstructible**, so no run of those suites was evidence about tie behaviour, and 4600 green tests said nothing at all about the property ADR 290 is named for.

Two traps inside the trap, both hit for real:

- **A tie fixture that does not tie.** Calling `Date.now()` per iteration drifts, so rows meant to collide do not. The first attempt at the repro passed and looked like proof the defect was absent. Pin the base once.
- **An all-unread fixture passes by accident.** With everything unread, 205 messages come back as a 200-row prefix plus 5 drained — the right answer for the wrong reason. The fixture must exceed the bound **and** be read.
- **An oracle too wide to see the distinction it is named for** (2026-08-21; falsify: at `e67213aa~1`, disable the retired-marker branch in `config.ts` and run the rollout scenario — a failure means this claim is wrong). Here the fixture was fine and the **assertion** was the proxy. The rollout scenario asserted `toThrow(/harness configure/)`, but *both* pre-286 refusals say to run `musterd harness configure` — the retired `MUSTERD_SURFACE` marker, and no marker at all. Disabling the branch under test let the env fall through to the marker-less throw, which matched the same regex. So the assertion could not distinguish the two classes that #928 exists to draw apart, inside the scenario named for one of them. Distinct from the two traps above: the failure was constructible and was constructed — the oracle just could not tell it from the pass. The repair asserts each refusal specifically rather than tightening the regex until it goes red, which would have restored green while leaving the wrong belief about why.

## Related: coverage pinned one layer from the defect (2026-08-20/21; falsify: for each instance, re-introduce the named line and run the named suite — a failure means that instance is wrong)

Same family, different mechanism: the property is genuinely tested, but not where it can break. The suite is green and the defect is one revert away.

- **`multi-harness.test.ts`** was named in [#928](https://github.com/SandRiseStudio/musterd/pull/928)'s body as covering the retired-marker rollout path. Disabling the refusal in `config.ts` leaves it **5/5 green**; the property is really pinned by `surface-drift.test.ts`. Not a defect — but the PR pointed readers at the wrong test, and "pinned somewhere" is not "pinned by the thing named as its acceptance".
  **Repaired 2026-08-21** in [#957](https://github.com/SandRiseStudio/musterd/pull/957) (`e67213aa`), at the coverage rather than at the sentence — izzo withdrew the offered PR-body correction on the grounds that a corrected sentence leaves the gap in place with a more accurate label on it. The repair surfaced a sharper cause than "wrong test named"; it has its own trap below.
- **`speechAddressee`** is well tested as a pure function, while the construction that calls it was not: setting `addressee: null` — re-introducing the exact defect seen on the live stream — left `packages/web/src/live` **625/625 green** (observed on `e929f160`, 2026-08-21).
  **Amended 2026-08-21, and the amendment is narrower than the repair sounds.** [#956](https://github.com/SandRiseStudio/musterd/pull/956) (`b7f6966a`) moved the construction into `speechEventFor` in `mapping.ts`, where tests can reach it: mutating `addressee` there is now **2 failed / 630** on `798bdf55`. But the emit in `OfficeScene.tsx` is still uncovered — `h.emit({ ...speechEventFor(e), addressee: null })` runs **630/630 green**, and no test mounts `OfficeScene` at all. The layer that can silently drop the recipient got thinner, not absent. What #956 bought is that the *natural* way to write that line is now the correct one: a real reduction in how likely the defect is, and none in whether the suite would see it. Recording the distinction because this bullet is the one that keeps moving — it has been "pinned one layer from the defect" at three different layers in two days.
- **`neverExercised` in the control registry** meant "nobody wrote it here", not "nobody did it" — a gate exercised against the live daemon on 2026-08-05 was invisible because the evidence lived in the acceptance stream, where ADR 192 puts it. See [controls in force](controls-in-force.md).

The check that finds these is cheap and worth making routine: **re-introduce the defect and watch the suite fail.** If it stays green, the coverage is somewhere else than you think.
