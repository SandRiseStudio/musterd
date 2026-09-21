---
name: dated-and-falsifiable
description: A belief carries the date it was observed and the observation that would overturn it — plus the twelve named ways a green check or a quiet instrument lies to you, each with a repair. Use when writing down what you learned, when a check passes and you are about to believe it, when a tool reports nothing, or when a team keeps re-discovering the same thing.
---

# dated-and-falsifiable

Most teams write knowledge down as timeless assertions: *the cache is
invalidated on write*, *that flakiness is just the runner*, *the auth gate
covers the admin routes*. Every one of those was true on some day, about some
build, because somebody observed something. None of them record which day, or
what they saw, or what would have changed their mind.

Two years later nobody can tell a fact from a rumour, and the rumours are
winning, because a confident sentence with no date is indistinguishable from a
measured one and considerably easier to write.

This skill is one rule and a catalogue.

## The rule

**Every claim carries the date it was observed and an observation that would
overturn it.**

```
autorefresh never installs (2026-07-31; falsify: read needsInstall in service.ts)
```

Three parts, and each earns its place:

- **The claim**, stated as narrowly as you actually measured it.
- **The date**, because a claim about a moving system is a claim about a
  moment. Without it, the reader cannot tell whether to re-check.
- **The falsifier** — a concrete observation that comes out *differently*
  depending on whether the claim holds.

When the claim turns out wrong, **strike it and date the correction; never
overwrite.** `~~never installs (2026-07-31)~~ FIXED 2026-08-03 by #570`. The
history is in version control either way; what a struck line buys you is a
reader who can see that this page has been wrong before, and about what.

## The rule behind the rule: a falsifier must be able to fail

This is the part people skip, and it is the part that does the work.

Ask it out loud: **if this claim were false, what would this check show?** If
the answer is "the same thing", you have written a ritual, not a falsifier —
and running it will read as confirmation.

A worked example from our own repo, because it cost a week. A flaky test suite
was written up as "the runner, not a test", with a date, and with
`falsify: rerun the named file alone`. It had every part of the format and it
was wrong for seven days. A file passing in isolation is what harmless runner
noise looks like *and* what a real load-only defect looks like — one reading,
two causes, so the check could never have discriminated. The falsifier that
finally worked was 20 full-suite runs against 20 isolated ones.

This applies hardest to claims that something is **fine** — *that's just noise*,
*safe to ignore*, *we already handle that*. Those stop everyone looking, and no
linter will ever ask them for a date.

## The twelve ways a green check lies

Each of these was measured on a real codebase. They are ordered roughly by how
often we hit them. For each: the shape, the repair, and the check that finds it.

### 1. The quiet instrument

A tool reports nothing and you read it as *nothing happened*. A tool that
reports nothing is making a claim, and it is the claim least likely to be
checked.

Deploying one small relay cost us roughly six instrument failures and zero
system failures. Every one presented as the system being broken.

> **Repair:** before believing a silence, **make the instrument observe an event
> you caused yourself.** Only then does its quiet mean anything.

### 2. The command that never ran

Worse than a quiet instrument: the program never started, and what you read as
"no matches" was the shell refusing before it began. A negative result and an
unexecuted check are the same empty terminal.

Three that bit us in one hour, under zsh:

- An unquoted glob in a flag value is expanded by the shell, not passed
  through: `grep -r pat src/ --include=*.ts` dies with `no matches found`.
  There were 17 real matches; grep never saw the pattern. Piped, the pipeline
  exits **0** with empty stdout.
- **A pipe discards the upstream exit code.** `false | tail -1` exits 0. Every
  `<gate> | tail` in a transcript is a gate whose verdict was thrown away.
- `2>/dev/null` on an exploratory sweep converts every mistake into a clean
  negative result.

Cost on the day: one engineer concluded a live function had been deleted and
replaced it with an adapter, writing the false claim into a code comment, a PR
comment and a task description before review caught it.

> **Repair:** check exit codes rather than emptiness, and **search for a string
> you are certain is there.** If that comes back empty too, the instrument is
> broken, not the codebase.

### 3. The check that cannot separate two causes

The check runs, reads exactly the surface it was meant to read, and is
worthless — because two different causes produce the identical reading, and it
reports whichever one its author had in mind. This is **aliasing**: the signal
has fewer states than the world it describes.

A monitor called a *slow* service dead because both answered the same 2-second
bound. A spend breaker had never once fired in eight days, because it summed
successes and failures into one counter. An error handler took no binding at
all, so an unreachable host, a revoked token, a malformed body and an
unrecognised error all wrote one byte-identical log line — ten occurrences, and
seven of them are now permanently unattributable.

Note that it **looks like a passing check, not a broken one.** A guard that
never fires and a guard with nothing to catch produce the same empty query.

> **Repair:** ask *if the other cause were the true one, what would this show?*
> Then make the two causes produce different readings — a second probe on a
> different bound, a counter that does not sum successes into failures, a reason
> code bound from the error rather than guessed. And **exercise the check in the
> direction that should make it fail**; a check only ever verified in its
> passing direction has not been verified.

### 4. The proxy that happens to agree

A surface reports something it did not look at. It reports a **stand-in**: a
value that equals the truth under a condition nobody states, nobody checks, and
nothing enforces. While the condition holds the proxy is right, so tests pass
and reviews approve. When it breaks, the proxy is wrong *and silent*, because
nothing was ever comparing the two.

A position over an ordered log was stored as a timestamp alone — correct
exactly while no two records share a millisecond, and four separate features
inherited it. A server reported the database it *meant* to open rather than the
handle it was given, which cost somebody an hour of believing they had polluted
production from a process that was entirely in memory.

> **Repair:** ask **what would have to be true for this value to equal the thing
> it claims to be?** If you can answer, that is an unstated invariant — say it
> out loud and decide whether anything enforces it. Then ask whether you could
> *construct* the case where they differ. If your fixtures cannot express it,
> your suite's green is not evidence about this claim at all.

### 5. The test that manufactures its own evidence

A feature has a producer and a renderer. The convenient place to test is the
seam between them: build the input by hand, hand it to the renderer, assert the
output. That test is real. What it is not is a test of the claim its name makes.

We shipped a truncation marker the server could never emit — and the suite was
green the whole time, **including a test named for exactly that behaviour**. It
injected the flag into the renderer and asserted the marker appeared. The
renderer could indeed render it. Nothing could ever ask it to.

This is worse than no test. A missing test leaves an open question; a green test
named for the claim closes it, and the next reader and the next reviewer both
stop looking.

> **Repair:** if a test asserts a value the code must produce, **at least one
> test has to cross the boundary where it is produced.** The diagnostic is the
> revert asymmetry: break the producer and confirm that exactly the test named
> for the claim — and only that test — goes red.

### 6. The test that cannot fail

Two ways to lose falsifiability without noticing.

**It never runs.** A test behind two independent gates runs only when both are
open at once, and if nobody owns opening both, the answer is nobody,
indefinitely. One of ours landed behind two gates and was never executed for
three weeks; for that whole window it could not have passed, and one of its
assertions had been invalid *on the day it merged*. CI reported the file as
passing — because green, for a gated test, means skipped.

**Its assertion admits its own negative case.** This one costs nothing to
create and runs on every CI pass:

```ts
expect(line === '' || line.includes('pre-v3 shape')).toBe(true);
```

`line` came from a `.find(...) ?? ''`. The left disjunct is exactly the case
where the thing under test **was not emitted at all**. Deleting the entire
feature left this test green while its three siblings went red.

The mechanism worth naming is the **hedge**. That disjunction was not laziness,
it was uncertainty honestly felt — the author did not know which branch the
fixture reached and wrote something that would hold either way. That converts an
open question into a green tick, which is strictly worse than leaving the
question open. A hedge in prose invites a reader; a hedge in an assertion
silences one.

> **Repair:** **delete the thing under test and watch it go red.** One minute of
> work, and the only check that distinguishes a test from a decoration. A gated
> test carries an owner and the date it last really ran, or it is decoration —
> and first execution is part of landing, not a follow-up. Write the hedge as a
> question, never as an `||`.

### 7. The guard with one degree of freedom

A check that fires on *disagreement* — this build against that one, my copy
against yours — has nothing to compare when both sides are derived from one
shared source. And a shared build is a machine for making a fleet wrong the same
way everywhere.

Our hook-version guard read clean at all fifteen workspaces on one laptop. Not
because they were current — because they were **identical**, all fed by one
machine-wide settings file. Meanwhile the guidance actually installed in those
same fifteen workspaces spanned sixteen versions, from current to sixteen
behind.

Nothing was lying. The check answered the question it was asked, and that was
not the question anyone needed answered.

> **Repair:** what made the spread visible was not a better guard but a
> **per-actor self-report** — each actor reporting the version of the files it is
> actually running. One degree of freedom per actor is what makes a spread
> legible at all. And read the self-report off the actor's own files, never off a
> constant compiled into the binary; that is the same trap one layer up.

### 8. Silence measured while nobody was listening

A loop watches for heartbeats and reaps whatever has not spoken for a window.
The loop stops — a restart, a suspended laptop, a blocked event loop. When it
resumes it compares against `now - timeout`, finds that *nothing* spoke during
the gap, and executes at full width. Which is true, and means nothing: no
listener was there to hear it.

We made this mistake twice in two different clocks, then a third time in a
subtler form — the guard measured from the tick's start while the cutoff
measured from wherever the tick had got to, so a tick that itself blocked longer
than the window passed the guard on the way out and swept every live connection
on the way through.

> **Repair:** the loop keeps its own **continuity clock** and refuses to judge
> until it has been continuously running for at least the window it is about to
> judge by — and it judges on one clock, because nothing can be heard *inside* a
> tick either. The diagnostic: does this sweep behave differently on the first
> tick after boot than on the thousandth? If not, it is not asking.

### 9. The control nobody has ever fired

An unexercised guard is indistinguishable from a broken one. Four unrelated
failures on one day turned out to be one failure — a control everybody believed
was in force that was not. A test-timeout ceiling that reached zero of five
packages, because a package-local config inherits nothing. A gate cited as
satisfied that had never fired.

Two facts, routinely conflated, and the conflation is the bug:

- **Exercised** — when someone last ran this and watched what happened.
  Liveness.
- **Tripped** — whether it has ever actually caught anything. Efficacy.

Neither substitutes. A control exercised often and never tripping may be
guarding something that cannot happen, which is worth knowing. A control that
tripped once and has not been exercised since may have rotted, which is
invisible without a date.

> **Repair:** keep a list where every guard carries **last-exercised, or an
> explicit never-exercised reason — and never neither**, plus whether it has
> ever tripped. Make the declared absence expire too, or an undated
> never-exercised is a permanent exemption. Then ask each one the counterfactual:
> **would this have caught the incident that motivated it?** "No" is a passing
> answer — a control that admits it would have missed is more useful than one
> nobody asked. We threw away a freshly built check on that question, because the
> honest answer was that it would have passed on the very case that prompted it.
> Decoration that reads as protection is worse than nothing.
>
> Two honest limits to write down beside the list: it keeps registered controls
> honest, it does **not** discover unregistered ones — so it is a floor, not an
> inventory. And it does not discover *exercises* either: one of ours was
> recorded "never exercised" on a day when it had in fact been fired against
> production sixteen days earlier, by someone who wrote it up somewhere else.

### 10. The constraint whose premise died

A rule is written for a reason. The reason is a fact about the system at that
moment. Later the system moves, the fact stops holding, and the rule stays —
correctly formatted, confidently worded, and wrong. Nobody re-derives it,
because re-deriving a rule you were told is exactly what a rule is for.

A comment pinned one of our colour tokens on the grounds that nearby chrome's
contrast had been tuned against it. True when written — the chrome was
translucent then. It was made opaque weeks later, which killed the constraint,
and the note stayed. The opacity change had every reason to be correct and no
reason to go looking for a comment in another file that its own premise
invalidated. That is the whole failure: the rule and the mechanism it depended
on lived apart, and only the rule was written down.

The same blindness reaches "another check covers this". One of ours named a
namespace wider than the pattern it was vouching for — written, as it happens,
*inside the fix* for the previous instance on this list.

> **Repair:** when you change a mechanism, **grep for the rules that named it.**
> When a written constraint blocks you, check whether its premise still holds
> before obeying *or* overruling it — both are failures if the premise is gone.
> Retire a constraint in writing, where it lived; a deleted comment teaches
> nobody. And before writing "another gate covers this", open that gate and
> **paste what it actually matches**, not the namespace you remember it as.

### 11. The correction that was recorded but not routed

A correction can be durably recorded, dated, and correct — and still fail,
because the surface a reader consults *at the moment of action* was never
updated. The existence of the record is exactly what lets everyone stop
worrying about it.

Ours: a checklist told you to bounce a shared service to exercise a gate, while
the page explaining why you must not do that sat one directory away. Two people
independently had to out-think their own instructions. A contributor guide
forbade a command that had been made safe twenty-eight minutes after the guide
landed. A "here is what's missing" note outlived its fix by six weeks, and three
documents kept citing a closed gap as the blocker.

A sweep scoped to the documentation tree finds the surfaces humans read and
misses the ones agents are fed. We reported one of these as four stale surfaces
and it was six; the two missed were in `scripts/`, and they were the two an
automated reader consumes.

> **Repair:** two questions, one at each end. When you record a correction:
> **where does this fire?** — what will the person who needs it be reading at the
> moment they would otherwise make the mistake? Put it *there*. When you write
> any instruction: **what corrects this if it goes stale?** Usually nothing does,
> which is the argument for pointing at the governed source instead of restating
> it. Then grep the old phrasing across the **whole** repo before calling it done.

### 12. The measurement that spends what it measures

Some observations are destructive reads: the operation that confirms the thing
arrived is the same operation that consumes it. Then every check either *is* the
delivery or pre-empts it, and there is no read-only probe at all.

We hit this four times in twelve days on one notification path. The sharpest
instance: the experimenter was not even the one consuming the event — an
automatic hook on the receiving side drained it at the next tool boundary,
unprompted, while a dedicated poller watched for five minutes and saw nothing.

> **Repair:** name it as a destructive read before designing the experiment.
> Then either remove the boundary rather than sequencing around it (one process
> that waits and observes, with nothing in between), or **let someone who is not
> the experimenter do the consuming** and read the durable trace they leave. And
> if an automatic mechanism keeps winning the race, that *is* a measurement —
> record which path delivered, just don't record it as your probe.

## Two habits that catch most of these before they ship

**Re-introduce the defect and watch the suite fail.** Items 5, 6 and 9 all
survive every other signal and fail exactly this one. It costs a minute.

**Have someone else read the falsifier.** The rival cause is invisible to the
person who wrote the check, by construction — the check encodes the cause its
author was thinking about, and the alternative is not rejected, it is never
represented. No amount of re-reading surfaces it. Nearly every instance above was
caught by measurement or by a second reader, never by staring at the code.

## An honest note about this catalogue

These twelve are not an independent sample of a natural rate. Eight of the
aliasing instances landed in a single evening during which the team was already
primed to look for the shape, and several were found by the person who then
wrote them up.

What supports generalising anyway is the spread rather than the count: they
span a job ledger, a platform monitor, a roster projection, a documentation
gate, a site build, a CSS pipeline and a shell sweep — subsystems with no shared
code and no shared author, found by five people independently. The honest claim
is that these shapes are real and common, not that any of these counts is their
frequency.

And the stories above carry no dates, which in a skill about dating claims is
worth being explicit about rather than hoping you don't notice. They are
illustrations of a shape, not claims you can check — the dated, falsifiable
versions live in the repo they came from, where a reader can actually run the
falsifier. **A claim needs a date when someone might act on it. An anecdote
needs a date when it is being offered as evidence.** If we had written "the
pipe trap costs teams a week on average", that would need both.

Those two are checkable anywhere, though, so check them: the unquoted-glob
abort and the pipeline exiting 0 on a failed command both reproduce in four
lines of shell, and the repair (`--include='*.ts'`, `set -o pipefail`) flips
each one. Re-run on 2026-09-21 before publishing this: both still hold under
zsh 5.9.

That is the skill applied to itself: say what your evidence can carry, and say
where it runs out, on the page rather than around it.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. Everything above works on one machine with no server; what a file
cannot do is attest who made a claim — the name on it is self-declared, not
observed. musterd.io.*
