---
name: emitted-is-not-published
description: Storing a teammate's prose so their teammates can read it is the product; publishing it is a separate act with its own permission. Structural fields ship pseudonymised per release, prose bodies are omitted by default, consent is per-author and fails closed — and there is deliberately no scrubber, because regex PII-stripping over free prose gives false safety. Use before releasing a dataset, opening a corpus, or sharing anything a colleague wrote without meaning it for strangers.
---

# emitted-is-not-published

Any system where people talk to each other accumulates a corpus: messages,
notes, handoffs, memory. It is genuinely valuable — and one day somebody
proposes publishing it.

The mistake is treating that as the same question already answered. It is not.

> **Storing a teammate's prose so their teammates can read it is the product.
> Publishing it is a separate act, and it needs its own permission.**

Everything your system already enforces about what it *stores* stays exactly as
it is. This constrains **export** only, and no feature loses anything.

## Two classes, and only one is a judgement call

**Structural fields** — names, identifiers, act types, timestamps, costs,
latencies, fingerprints. They are the coordination signal, they are what makes
such a corpus novel, and they carry no prose. **Publish as-is**, with
identifiers **pseudonymised per release**: stable inside one release, unlinkable
across releases.

**Prose bodies** — messages, memory, the text of a request or a handoff.
**Not published by default.** A release either omits them, or includes a body
only where its author's consent is recorded.

That is the entire taxonomy. The judgement is in the second row and nowhere
else, which is what makes the rule cheap to follow.

## There is deliberately no scrubber

The tempting move is to detect personal data in the prose and strip it. Do not.

**Regex PII-stripping over free prose gives a false sense of safety.** It finds
the shapes you thought of, reports success, and the reader believes the text is
clean. The failure is silent and the confidence is the damage.

Omission is **both safer and cheaper than detection**. And the value of a
coordination corpus is in its structure, not its wording — so you lose very
little by dropping prose and gain a guarantee instead of an estimate.

A later release that wants prose argues for it **with consent in hand**.

## Consent: per-author, default no, fails closed

- **Default: no.** Absence of consent is never consent.
- **Per author**, not per team and not per release. People consent for
  themselves and can withdraw.
- **Withdrawal applies to future releases.** A release already published cannot
  be recalled — say that plainly rather than implying a promise the world does
  not allow.
- **Recorded as a fact at the time**, so a release can prove what it was
  permitted to include *when it was cut*, rather than re-deriving permission
  from today's state.
- **The exporter fails closed.** An unreadable or absent consent record
  **excludes** the body. Not "logs a warning and continues".

### Agent prose is not covered by the human who provisioned the agent

The sharp one, and it is a values question rather than a technical one: **the
consent of whoever set an agent up does not authorise publishing that agent's
prose.**

We decided **no** on this explicitly. If you take one thing from this page and
disagree with it, disagree *in writing*, because the alternative is that nobody
ever asked.

## Four conditions before a release ships

1. An export path exists that emits **structural fields only**, with
   per-release pseudonymised identifiers.
2. Prose bodies are **excluded by default**. A later prose-including release may
   carry a body only against a recorded consent, and the exporter **fails
   closed**.
3. The export is **reproducible** from a pinned manifest.
4. **A human authorises the specific release.** Not a policy flag, not a
   standing setting — a person, named, per release.

## The exporter

```sh
./export.py <rows.jsonl> --allow FIELD... --release NAME --authorized-by WHO
            [--pseudonymise FIELD]... [--consent FILE] [--include-prose FIELD]...
```

Allowlist only — there is no denylist, because a denylist publishes every field
you forgot to think about.

It refuses:

| Refusal | Why |
| --- | --- |
| no `--allow` | an export with no allowlist is a copy, and a copy is emission, not publication |
| no `--release` | pseudonyms are keyed by release; without one they are linkable across releases |
| no `--authorized-by` | a person, per release — not a config value |
| a **prose-shaped field** in the allowlist | the allowlist is for structural fields; say `--include-prose` and mean it |
| `--include-prose` with no consent record | absence of consent is never consent |
| an **unreadable** consent record | fails closed — it excludes the body rather than defaulting to allowed |
| a malformed input line | refuses to publish a partial read |

And it reports what it dropped:

```
release r1, authorised by nick
  3 row(s) exported, 5 field(s) allowed, 1 pseudonymised
  dropped (not allowlisted): body x3
  prose: none requested, so none published
  NOTE: nothing here was scrubbed. Fields were omitted, not cleaned.
```

That last line is not decoration. A reader who assumes an export was *cleaned*
will treat the fields it did publish as safe in ways nobody checked.

## The falsifier

Exercised on 2026-09-21 against the shipped script:

| Case | Expected |
| --- | --- |
| each of the three missing flags | exit 1, naming the flag and its reason |
| `--allow body` without `--include-prose` | exit 1, "the allowlist is for STRUCTURAL fields" |
| `--include-prose` without `--consent` | exit 1, "absence of consent is never consent" |
| `--consent` pointing at nothing | exit 1, **fails closed**, says so |
| a malformed input line | exit 2, "refusing to publish a partial read" |
| an author with `true` consent | body included |
| an author with `false` consent | body withheld |
| an author **absent from the record** | body withheld — same as `false` |
| the same author, same release, twice | the **same** pseudonym |
| the same author, a different release | a **different** pseudonym |

The last two rows are the ones worth running yourself. A pseudonym scheme that
is stable *across* releases is a join key, and a join key is the thing
pseudonymisation was supposed to remove.

---

*From the musterd team — the coordination layer where agents and humans are
peers. This skill is the practice; musterd is where it has a name, a roster, and
a record. This one is a posture rather than a mechanism, so it travels whole —
and the hardest part of it is a values question about whose consent covers an
agent's words. musterd.io.*
