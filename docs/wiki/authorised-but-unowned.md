# An authorised migration with no owner does not happen

ADR 344 authorised the retirement of the shared Team bootstrap key, built the whole mechanism, and named nobody to run it — so fifteen days later 2 of 13 workspaces had moved, and the credential the migration existed to retire was still a valid claim input while sitting in four published container images.

## The shape

An ADR can decide a migration completely and still leave it undone. ADR 344 §7 keeps the legacy
Team-scoped bootstrap record "solely for a documented compatibility window" and says a release
removing it "must be separately ADR-gated after every configured Workspace has moved to a scoped
credential." That sentence names a precondition. It names no owner, no date, and no lane.

Everything the migration needed was built and landed on 2026-09-01: the decision (ADR 344), the
full lifecycle — protocol, migrations, store, http, ws, `musterd team bootstrap mint|list|revoke|cutover`,
host, mcp (lane `01M1F3ZNWQ`) — and ADR 350 retiring the legacy credential on paper. Nothing was
missing. The mechanism was complete and the outcome had not occurred, and those two facts are
compatible for as long as nobody notices.

The gap was not found by a gate. It was found because nick asked, on 2026-09-16, whether members
have unique keys.

## What the window actually cost (measured 2026-09-15)

Measured by stanley against the hub daemon, fourteen days after ADR 344 landed:

| | |
|---|---|
| `teams.bootstrap_cutover_at` for `revive` | NULL |
| active legacy bootstrap records, all teams | 6 |
| `claim_seat` scoped records | 2 (`delta`, `schmidt`) |
| scoped records carrying an expiry | 0 |
| seat bindings on the hub laptop holding an `mskey_` value | 13 |

The trigger was a real leak: a seat binding entered a Docker build context and was published to a
container registry in four images. The remediation question — *what does this key authorise, and
whose is it* — could not be answered from outside the secret, because the legacy record is one
shared value for every workspace. That is what the open window costs, and it is why the cutover is
the actual remediation rather than a tidy-up: the leaked value stays a valid claim input until the
legacy record is disabled.

## The migration's own progress reads as corruption

`musterd team agent-key` (recovery mode) refuses to record anything because the bindings disagree — twelve workspaces on one `mskey_` value and `agents-schmidt` alone on another (2026-09-16, izzo; falsify: migrate a second workspace and re-run it — if the refusal were really about damage it would clear, and instead it gets *worse* as the migration progresses). <!-- claim: defect -->

This is not a botched rotation. `schmidt` is one of the two seats that *did* migrate. By ADR 344 §8
a scoped credential and the legacy key are both opaque `mskey_` values whose matching record the
server finds by hash — so what the recovery tool has to work from is identical in the migrated and
un-migrated cases, and it sees only "these do not all match." The migration's high-water mark is
indistinguishable from damage, which means the tool gets louder exactly as the work succeeds. Same
property ADR 403 was written about, seen from a different command; a
[cannot-separate-two-causes](cannot-separate-two-causes.md) instance on a credential rather than a
schema version.

## The gate passed while the outcome failed

~~Every successor created by `musterd wire --migrate-bootstrap` is stored with `expires_at: null`, so following the runbook exactly makes every Workspace cutover-ready with credentials valid forever (2026-09-22; falsify: read `migrateLegacyBootstrapCredential` in `packages/server/src/store/teams.ts` before `cf5f950d` — a version that computes a deadline would disprove it)~~ **FIXED 2026-09-22 by [#1657](https://github.com/SandRiseStudio/musterd/pull/1657) / `cf5f950d`** (ADR 440). <!-- claim: defect -->

The store hard-coded the null, while cutover readiness deliberately treats an unexpired credential
with a null expiry as valid — neither half is wrong alone. The constructor now sets
`MIGRATED_BOOTSTRAP_TTL_MS`, ninety days from server-side creation, and no client supplies or
chooses it.

The readiness gate was never wrong about what it checked. It proved **scoped use**, exactly as
designed, and scoped use is not bounded lifetime — ADR 403's actual requirement. A migration whose
own supported path satisfies its gate and misses its purpose is the failure mode worth carrying
forward: ask what the gate proves, then ask separately whether that is the outcome the work exists
for. Related: [controls-in-force](controls-in-force.md), [double-gated-tests](double-gated-tests.md).

ADR 440 §5 deliberately does **not** rewrite already-used successors carrying a null expiry — the
no-surprise rule for issued authority. The one such credential (`big-body`'s) therefore needs one
staged administrator rotation, which is owed work with an owner named, not a silent fix. That is
the same mistake this page is about, so it is written down rather than assumed.

## Running it deafens the seat that runs it

The prescribed pair — `musterd wire --migrate-bootstrap` then `musterd claim <seat> --bootstrap` —
both succeed, and readiness really is satisfied. But the bootstrap claim mints a lease that ends
with the command, so the seat's session Presence is dead the moment it returns and every interrupt
check is refused (2026-09-22, ryder; falsify: complete a bootstrap claim and run `musterd inbox --interrupt-check` — silence means this no longer holds). <!-- claim: defect -->

Nothing looks wrong from outside: the roster still shows the seat joined. Neither obvious repair
works — `musterd reclaim` refuses because the successor is deliberately non-admin, which is exactly
what the cutover was for, and `team_join` alone short-circuits on "Already joined" because its
idempotent path treats a dead lease as already-joined and re-mints nothing. `team_leave` then
`team_join` restores it, and that pair is now a required step in the runbook rather than a
troubleshooting note. The underlying `team_join` liveness bug is ryder's separate lane.

Worth noticing *who* found this: the first seat through, because a fleet migration run one seat at a
time makes the first run a probe whether or not anyone calls it one. The six behind ryder were
warned before they ran. A batch would have deafened all seven at once.

### It is not only the cutover step

The deafness is wider than the command that first exposed it. A seat that had migrated hours
earlier, and had been working normally since, went deaf mid-session with no bootstrap command
anywhere nearby (2026-09-22, dolly; falsify: hold a migrated seat's session open across a long wait and run `musterd inbox --interrupt-check` — silence means this no longer holds). <!-- claim: defect -->
So `claim --bootstrap` is one way to lose Presence, not the only one, and "I already ran the repair
once" is not protection. The check is cheap; run it at task boundaries, not just after the cutover.

Two details make it harder to spot than ryder's case. `team_leave` answered **"Not joined to revive
— nothing to leave"** while the CLI was still refusing interrupt checks — so the first half of the
documented repair reads like a no-op on a seat that genuinely needs it, and a seat that stops there
concludes it was never broken. Run `team_join` anyway; it re-mints Presence and the interrupt check
goes silent. ~~And a `musterd inbox --wait 900` returned "no directed act within 300s" — a shorter
window than asked for. Whether the truncation is caused by the dead lease or is an unrelated cap is
not established here, but a seat waiting on a blocking ask should not assume its wait ran to length.~~
**CAUSE ESTABLISHED 2026-09-22** — the truncation and the deafness are the same event; see below.

### The wait is what kills it

`musterd inbox --wait` ends the seat's own session lease, so after a long wait the seat is deaf every time, and the window it reports is 300s regardless of what was asked for (2026-09-22, dolly, 2 of 2; falsify: `team_join`, confirm `--interrupt-check` is silent, run `musterd inbox --wait 420`, then run `--interrupt-check` again — silence means this no longer holds). <!-- claim: defect -->

Asked for 600 it said 300; asked for 420 it said 300 and had not exited eight minutes later.

The obvious rival explanation — that the lease just expires on an idle session and the wait merely
spans it — was tested rather than argued away. With Presence confirmed live, seven minutes of
`python3 -c 'time.sleep(420)'` and no musterd call at all left `--interrupt-check` silent, while a
`--wait` of the same length deafened the seat on both runs. Idle is not what does it. That control is
the point: the two causes produce an identical symptom, and only the one that holds the rail idle
*without* waiting can tell them apart — a [cannot-separate-two-causes](cannot-separate-two-causes.md)
instance that happens to be separable.

This is the part worth carrying off this page, because it is not about the migration at all: **the
command a seat is told to hold with is the command that makes it unreachable.** A blocking ask
answers "HOLDS, 15m"; a seat that holds the documented way destroys its own ability to receive the
answer, and nothing in the transcript says so — the wait returns a plausible "no directed act"
either way. Hold with `team_inbox_check` at task boundaries instead, and treat any `--wait` as a
command that requires a `team_join` after it.

## The habit

- **A migration clause in an ADR is not a migration.** "After every X has moved" is a precondition,
  not a plan. If the ADR that authorises the move does not also open the lane that performs it,
  the window is open until someone happens to ask.
- **The compatibility window needs a closing date at the moment it is opened**, by whoever opens it.
  ADR 403 exists because nothing else set one; it should not have had to.
- **Ask what the readiness gate proves, not whether it is green.** Scoped use and bounded lifetime
  are different properties, and the gate for one is silent about the other.
- **Expect the tooling to misread partial progress.** When the before and after states are the same
  opaque shape, "these disagree" is what a half-finished migration looks like from the outside, and
  telling that apart from damage takes a field the tool was never given.

## The close

Not yet recorded. The cutover has not run: as of 2026-09-22 seven held seats and one residency host
were still on the legacy credential, and `musterd team bootstrap cutover` refuses until every held
seat and enrolled host proves scoped use (runbook: [`docs/operations/legacy-bootstrap-cutover.md`](../operations/legacy-bootstrap-cutover.md)).
The after-counts — `bootstrap_cutover_at` non-NULL, 0 active legacy records, every binding and
enrolled host on a scoped credential with an expiry — belong in this section, dated, when the lane
that owns it (`01M2NR6BQCBJD8504J0J8S44MW`) runs it without `--force`.
