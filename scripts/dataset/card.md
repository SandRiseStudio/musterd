---
pretty_name: musterd coordination traces
tags:
  - multi-agent
  - coordination
  - traces
  - structural
size_categories:
  - 1K<n<10K
license: other
task_categories:
  - other
---

# musterd coordination traces (v1)

This is a **structural event log** from [musterd](https://github.com/SandRiseStudio/musterd), a protocol for named Teams of humans and agents. Each row is an **Act** (typed intent), not a chat turn. Message bodies are omitted on purpose ([ADR 184](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions/184-dataset-consent-and-redaction.md)): v1 publishes coordination structure, not prose. If the files look empty of text, that is the release, not a truncated dump. This is **not a chat dump**.

The software is MIT. This directory is **not yet licensed for redistribution**. The intended license at a HuggingFace upload is CC-BY-4.0; writing this card does not grant it. Confirm before any publish.

## What musterd is

Named, persistent teams of agents and humans — across any harness, framework, model, or surface — with a shared communication protocol.

A **Team** is a standing roster, not a project. A **Member** is a durable identity, not a session.

## Glossary

| Term       | Meaning in this dump                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Team**   | A named, persistent group of Members with shared messaging. It outlives any task, session, or repository.                                                           |
| **Member** | A durable identity on a Team (`kind`: agent, human, or — in these files — service). Not a session.                                                                  |
| **Act**    | The typed intent of a message: `message`, `status_update`, `request_help`, `handoff`, `accept`, `decline`, `wait`, `resolve`, `steer`, `challenge`, `defer`, `ask`. |
| **Lane**   | A unit of work on the board (state, owner, times). This dump has `lanes.jsonl`. The `title` column is omitted.                                                      |

**Presence** (where a Member is attached) and **Surface** (cli, claude-code, cursor, …) are not in this dump.

## Files in this directory

- `acts.jsonl` — one Act per line: id, team slug, HMAC from/to, act, thread, allowlisted meta, ts (epoch ms).
- `members.jsonl` — HMAC id, kind, role, team. Never the seat name.
- `lanes.jsonl` — id, state, times, HMAC owner/creator, goal_id, depends_on, project (seat-name tokens HMAC'd). Never title, detail, or branch.
- `RELEASE.json` — this cut's counts, human authorizer, salt hash (not the salt), manifest SHA.
- `manifest.v1.json` — what v1 includes and omits. The schema lives here; this card does not restate it.

`meta` keeps a structural allowlist (`model`, `in_reply_to`, `species`, `tier`, `ask_outcome`, `ask_ref`, `eligible`, `blocked_by`, `progress`, `until`, `defer_ref`, `lane_id`, `pr`, `sha`). Prose-bearing keys (`urgent_reason`, `risk`, `chosen_approach`, and any unknown key) are dropped, not scrubbed.

## This cut

- **{{acts}}** acts · **{{members}}** members · **{{lanes}}** lanes
- Time range (UTC, from `ts`): {{ts_start}} → {{ts_end}}

Act counts:

{{act_counts}}

Member kinds:

{{kind_counts}}

Recipient (`to.kind`):

{{to_kind_counts}}

These are counts for the files beside this README. They are not a published finding.

## Act vocabulary

| Act             | Meaning                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| `message`       | plain communication, no protocol semantics                                                                      |
| `status_update` | report what you are doing / have done                                                                           |
| `request_help`  | ask a Member or the Team to assist / unblock you                                                                |
| `handoff`       | transfer a unit of work                                                                                         |
| `accept`        | accept a prior `request_help` / `handoff` / `challenge`                                                         |
| `decline`       | decline a prior `request_help` / `handoff` / `challenge`                                                        |
| `wait`          | paused / blocked                                                                                                |
| `resolve`       | close a thread — mark the work it tracks done                                                                   |
| `steer`         | change direction; newest steer supersedes prior direction                                                       |
| `challenge`     | ask a Member to justify a task or assumption                                                                    |
| `defer`         | shelve a Goal                                                                                                   |
| `ask`           | directed to a human (`meta.species`: consult / escalate / approve; `meta.tier`: advisory / standard / blocking) |

Protocol: [SPEC.md](https://github.com/SandRiseStudio/musterd/blob/main/SPEC.md). `ask` is [ADR 147](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions/147-ask-the-human.md).

## Pseudonyms

`seat_` + 12 hex = HMAC-SHA256(member_id, per-release salt). Stable inside this directory. Unlinkable to another release. The mapping file is never written here.

Team slugs (`revive`, `dawn`, `lab`, `difftest`, `bench`, `bench2`) are **not** HMAC'd. They are experimental / dogfood Team names from one operator's laptop, not customer orgs.

## How it was made

A private corpus snapshot (`pnpm corpus:snapshot`, [ADR 280](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions/280-the-evidence-base-lives-on-one-laptop.md)) then `pnpm dataset:export` from that copy — never from the live daemon db. One human `--authorized-by` per cut. This script is not a HuggingFace upload.

## Limitations

- No message bodies, no lane `title`, no seat memory. You cannot read what was said or what the work was.
- Not a conversation dataset and not instruction data. Do not fine-tune a chat model on it.
- Not a benchmark and not MAST labels. Detectors, a leaderboard, and a paper are later rungs ([research README](https://github.com/SandRiseStudio/musterd/blob/main/docs/research/README.md)).
- Mixed Teams on one machine (dogfood + short-lived experiment Teams). Do not treat row counts as "the field."
- `kind: service` appears (platform daemons). Brand copy says Member is agent or human; the files are the truth for this dump.
- `meta.model` is attested occupancy when present; many acts have `meta: null`.
- Broadcast-heavy `status_update` / `message` is the dominant shape of this log. That is a property of the files, not a claim that the product failed to coordinate.
- A later prose release needs its own ADR and consent rule. This card does not promise one.

## What you can do with it

Count directed vs team Acts; act mix over time; model stamps where present; lane state lifetimes; `ask` species/tier without the ask text; thread graphs by id. Cite SPEC.md for the protocol.

## Citation

```
musterd coordination traces v1 (structural-only). SandRiseStudio/musterd.
Export: pnpm dataset:export. Gate: ADR 184.
```

- Repo: https://github.com/SandRiseStudio/musterd
- [ADR 184](https://github.com/SandRiseStudio/musterd/blob/main/docs/decisions/184-dataset-consent-and-redaction.md)
- [SPEC.md](https://github.com/SandRiseStudio/musterd/blob/main/SPEC.md)
- [docs/research/README.md](https://github.com/SandRiseStudio/musterd/blob/main/docs/research/README.md)

No HuggingFace URL until a release is uploaded.
