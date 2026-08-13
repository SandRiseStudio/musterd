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

Related: with **Socket Mode on**, the Request URL is never called no matter how many times the console says `Verified ✓`. The checkmark describes a past handshake, not the live delivery path.

## `gh pr edit` is broken on this repo (2026-08-06; falsify: run `gh pr edit <n> --body x`)

It fails inside a `projectCards` GraphQL query — a repo/permission-shaped failure, not a flag error, so the message does not point at the cause. Use the REST path instead:

```
gh api -X PATCH repos/SandRiseStudio/musterd/pulls/<n> -f body=@file
```

## Test fixtures are synthetic by construction (2026-08-06; falsify: paste a live credential into a fixture and push)

GitHub push protection caught a live credential pasted into a test fixture during that session. It worked as designed, and the lesson is upstream of it: a fixture that resembles a real secret closely enough to be useful is close enough to be one. Generate fixture credentials; never copy them.
