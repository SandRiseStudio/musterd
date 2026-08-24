# Instrument silence is not evidence

Before reading a quiet instrument as "nothing happened", make it observe a control event you cause yourself — most debugging time on this repo has gone to broken instruments, not broken systems.

## The rule, and where it came from (2026-08-06; falsify: re-read the seeds deploy session)

Deploying the ADR 248 seeds relay cost roughly six instrument failures and zero system failures. Every one presented as the system being broken, and in every case the system was fine and the thing reporting on it was wrong. A tool that reports nothing is making a claim, and it is the claim least likely to be checked.

The general form: **cause an event you know happened, and confirm the instrument sees it.** Only then does its silence mean anything. The same shape shows up outside tooling — see [Probing with a temp daemon](temp-daemon-probe.md) for why the _creating_ session of a broken config never notices.

## `wrangler tail` piped into `head` buffers silently (2026-08-06; falsify: tail a worker you are actively curling, piped to `head`)

`npx wrangler tail | head -n 20` can sit empty while the worker is serving traffic — the pipe buffers and `head` never flushes. Read the tail unpiped, and control-probe it with a request you make yourself before believing an empty tail. A dead tail and a quiet worker are indistinguishable from the outside.

`wrangler kv` has a sibling trap with a documented recipe: see `workers/seeds-relay/README.md` — without `--remote` it reads a local simulator that is always empty and never errors.

## Removing a Slack channel integration kicks the bot and revokes the webhook (2026-08-06; falsify: remove and re-add an integration, then post to the channel)

Removing a channel integration in Slack's UI does two things it does not announce: it drops the **bot's membership** of that channel, so `message.channels` goes silent, and it **revokes that webhook's URL**. Every surface in the Slack UI stays green throughout. Re-invite the bot AND re-copy the _current_ webhook URL — the old one in your secret store is dead.

Related: with **Socket Mode on**, the Request URL is never called no matter how many times the console says `Verified ✓` (2026-08-06; falsify: with Socket Mode on, post to the channel and tail the Request URL worker's logs — if a request arrives there, the checkmark was describing the live path after all). The checkmark describes a past handshake, not the live delivery path.

## `gh pr edit` is broken on this repo (2026-08-06; falsify: run `gh pr edit <n> --body x`)

It fails inside a `projectCards` GraphQL query — a repo/permission-shaped failure, not a flag error, so the message does not point at the cause. Use the REST path instead:

```
gh api -X PATCH repos/SandRiseStudio/musterd/pulls/<n> -f body=@file
```

## Test fixtures are synthetic by construction (2026-08-06; falsify: paste a live credential into a fixture and push)

GitHub push protection caught a live credential pasted into a test fixture during that session. It worked as designed, and the lesson is upstream of it: a fixture that resembles a real secret closely enough to be useful is close enough to be one. Generate fixture credentials; never copy them.

## The shell itself is an instrument, and three of its constructs fail OPEN (2026-08-21, three incidents in one hour across two seats; falsify: run each broken form beside its fixed form below — they must disagree)

The sections above are about tools that go quiet. These are worse: the command **never ran at all**, and what you read as "no matches" was the shell refusing before the program started. A negative result and an unexecuted check are the same empty terminal, and only one of them is evidence.

All three below were measured on this repo on 2026-08-21 under zsh, and each one nearly overturned a *correct* finding.

**1. An unquoted glob in a flag value is expanded by zsh, not passed through (2026-08-21; falsify: run it quoted and unquoted — 17 matches vs an abort).** `grep -rn readBindingAt packages/cli/src/ --include=*.ts` dies with `no matches found: --include=*.ts` — zsh tries to glob `--include=*.ts` against the *current directory*, finds nothing, and aborts. There are 17 real matches; grep never saw the pattern. Two ways this reads as a result rather than an error: piped (`| head`), the pipeline exits **0** with empty stdout; unpiped, zsh **aborts the whole command list**, so the `echo` you wrote to label the output never runs and you are left reading the previous command's tail. Quote it: `--include='*.ts'`. Cost on 2026-08-21: stanley concluded `readBindingAt` had been deleted, replaced a live function with an adapter during a rebase, and wrote that false claim into a code comment, a PR comment and a lane detail before review caught it (#858, corrected in `11a0c557`).

**2. A pipe discards the upstream exit code.** `false | tail -1` exits **0**, because a pipeline's status is its *last* command's. Every `pnpm <gate> | tail` in a transcript is a gate whose verdict was thrown away — `tail` succeeded at printing, which is all you measured. Either redirect and check (`pnpm lint >/tmp/o 2>&1; echo $?`) or `set -o pipefail` first, under which the same pipeline exits 1. This is the same failure as [never grep a gate's output](running-the-gates.md#never-grep-a-gates-output-2026-07-13-pr-268), one layer down: there the filter lied about the text, here the pipe lies about the verdict.

**3. `$var:A` is a modifier, so `git show $c:file` reads a path that does not exist (2026-08-21; falsify: `echo $c:AGENTS.md` beside `echo ${c}:AGENTS.md`).** zsh expands `$c:A` as the *absolute-path* modifier: with `c=077cb7a9…`, `$c:AGENTS.md` becomes `/Users/nick/agents-stanley/077cb7a9…GENTS.md` — note the eaten `A`. `git show` then fails on a nonexistent path, and with `2>/dev/null` a `grep -c` over the empty output returns `0` for **every** commit, which looks exactly like "this string was never in this file". Brace it: `${c}:AGENTS.md`. Cost on 2026-08-21: izzo nearly told sloane that a correct finding was a working-tree artifact.

**Why these belong on this page rather than in a linter (2026-08-21, measured; falsify: rerun the three lines through shellcheck).** I first wrote here that a linter would catch trap 1 and miss the others. That was a guess, and running it inverted the answer: shellcheck flags **trap 3** (`SC2086` on `$c`, suggesting `"$c":AGENTS.md`) and says nothing about traps 1 or 2. It also cannot help in principle — all three are *zsh* semantics and shellcheck checks POSIX/bash, where `--include=*.ts` and `$c:A` both behave differently. Worth stating plainly given where it is written: the sentence this replaces was an unmeasured claim about measurement, on the page about not making those. Run the linter, take the one of three it gives you, and keep the control probe: **before believing an empty result, make the command produce a non-empty one you already know the answer to.** Search for a string you are certain is there; if that comes back empty too, the instrument is broken, not the codebase.

**The pattern this is the fourth instance of.** izzo's closing note the same evening: across eight aliasing instances that day, *four* had a broken instrument about to overturn a correct report, and every time it was someone re-measuring rather than trusting a green result that caught it — while the gates were green throughout. See [correct by coincidence](correct-by-coincidence.md) and [recorded, not routed](recorded-not-routed.md) for the sibling shapes. Nothing the team owns measures how often a broken instrument reverses a right answer; that gap is real and unmeasured as of 2026-08-21.
