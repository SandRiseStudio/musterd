---
name: mast-checklist
description: Read your own multi-agent coordination log against the failure shapes that research has catalogued — broadcast-journalling, unanswered requests, one-sided threads, silent participants — with a screen that names where to read rather than scoring you. Cites the taxonomies it draws on instead of paraphrasing them. Use after running a multi-agent setup for a while, when coordination feels busy but nothing closes, or before claiming a team is working.
---

# mast-checklist

Multi-agent systems fail in patterned ways, and the patterns have been
catalogued. This is how to check whether **your** team has them, using a log you
already have, in one sitting.

## The two catalogues, cited rather than paraphrased

**MAST — the Multi-Agent System Failure Taxonomy.** Cemri, Pan, Yang, Agrawal,
Chopra, Tiwari, Keutzer, Parameswaran, Klein, Ramchandran, Zaharia, Gonzalez
and Stoica, *"Why Do Multi-Agent LLM Systems Fail?"*
([arXiv:2503.13657](https://arxiv.org/abs/2503.13657)). **14 failure modes**
clustered into three categories — *(i) system design issues, (ii) inter-agent
misalignment, (iii) task verification* — developed from **150 traces** across
**7 frameworks**, with inter-annotator agreement of **κ = 0.88**, alongside
MAST-Data, **1,600+ annotated traces**.

**Co-Gym — the human-in-the-loop side.** Shao, Samuel, Jiang, Yang and Yang,
*"Collaborative Gym"* ([arXiv:2412.15701](https://arxiv.org/abs/2412.15701)),
whose collaborative agents beat fully autonomous ones by real-user preference:
**86% travel planning, 74% tabular analysis, 66% related-work writing**.

*(Those figures are from the two abstracts, checked 2026-09-21. Deeper numbers
we quote internally — a notification ablation, per-class error rates — are from
our reading of the paper bodies and are not reproduced here as citations. If one
matters to your argument, read the paper.)*

**Go and read both.** This page is a screen, not a summary, and the taxonomies
are better than any restatement of them.

## The shapes worth screening for

These are ours — the ones a real audit of our own logs found, expressed so a
script can look for them. They sit under MAST's inter-agent-misalignment and
task-verification categories and under Co-Gym's communication and
situational-awareness classes, but they are not those taxonomies restated.

1. **Broadcast-journalling** — announcements to everyone instead of directed
   exchange.
2. **Requests that are never answered** — asked, and nothing afterwards
   references them.
3. **Loops that never close** — plenty of asking, almost no accepting,
   declining or resolving.
4. **One-sided threads** — one participant wrote every message in a thread.
5. **Silent participants** — present and addressed in the log, never
   contributing to it.

## We ran this on ourselves, and it caught us

The honest part, and the reason this page exists rather than a link to the
papers.

Fifty-three hours of our own live coordination data, 110 traced acts:

| | |
| --- | --- |
| `status_update` | **84%** |
| closed-loop coordination | **~3%** — one request for help, one handoff, one accept, in three days |
| `resolve` | **zero times** |
| broadcast | **85%** |
| directed | 15% |

A near-perfect broadcast journal. Every participant believed they were
coordinating, because everyone was diligently reporting. **Reporting is not
coordinating**, and the difference is invisible from inside — which is exactly
what makes a log worth screening rather than recalling.

## The screen

```sh
./audit.py <acts.jsonl> [--to-field TO] [--from-field FROM]
           [--type-field ACT] [--reply-field REPLY_TO] [--broadcast VALUE]...
```

Exit 0 when nothing screens positive, 1 when something does, 2 when the input
cannot be read. Field names are configurable, so it reads your log rather than
requiring ours.

### Every screen carries its innocent reading

This is the part that makes it usable more than once:

```
! broadcast-heavy: 88% of acts went to everyone.
  INNOCENT READING: a team that genuinely works in the open, or one person
  narrating a solo run.
  WORTH READING IF: nobody answers the announcements.
```

**A screen that reports only the guilty reading is an accusation with a
percentage on it.** Each of these numbers can be high for a good reason, and the
tool's job is to tell you *where to read* — not what is true.

### It will not tell you the team is healthy

A clean run says so explicitly:

```
ok nothing screened positive over this window.
   That is not 'the team is healthy' -- it is 'these five shapes did not
   appear in these N acts'. The window is yours to justify.
```

Five absent shapes over a window you chose is a much smaller claim than health,
and the difference is the whole discipline.

**On a raw transcript with no structure, this is a human read and nothing else.**
The script needs sender, recipient and act type to count anything. Without them
you still have the five shapes and your own eyes — which is how the audit above
was done the first time.

## The falsifier

Exercised on 2026-09-21:

| Log | Expected |
| --- | --- |
| a broadcast journal with an unanswered request | exit 1, **all five** screens firing |
| a healthy exchange: request → accept → resolve | exit 0, with the not-health disclaimer |
| custom `--from-field` / `--to-field` / `--type-field` | reads them correctly |
| a custom `--broadcast` value | counted as broadcast |
| a JSON array instead of JSONL | read the same way |
| one malformed line | exit 2, "refusing to screen a partial read" |
| an empty file | exit 2, "nothing was screened, which is not a pass" |
| a missing file | exit 2 |

Run the first two yourself before pointing it at real data. A screen you have
not seen fire is a screen you do not know the shape of — and this one is easy to
fire on purpose.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. Everything above works on one machine with no server; what a file
cannot do is be the structured act log this reads best — on a raw transcript the
checklist is a human read, not a metric. musterd.io.*
