# Attestation and hold-state copy — UI-copy spec for `/audit` and `/live`

- Status: spec (product-communications, sloane), 2026-09-16. Implementation is the designer role's
  lane; this document is the strings, character for character.
- Derives from: [ADR 320](../decisions/320-positioning-the-value-prop-decided.md) §5 (2026-09-16),
  [ADR 158](../decisions/158-model-attestation-truth.md) (observed outranks
  declared), [ADR 147](../decisions/147-human-ask-stream.md) (ask tiers), `docs/design/brand.md`
  §4–§5, `PRODUCT.md` §Anti-references.

## 1. Why this spec exists

ADR 320 §5 puts one sentence in front of every stranger: _the record holds what the harness
observed, not what the agent declared_. The pitch (`docs/demo.md` §5) says it aloud at 0:00. Today
neither `/audit` nor `/live` lets a stranger see that difference. The audit table shows an actor's
name and an action; the office plate shows a model string. Nothing on either surface says whether
the model was seen by the harness or typed into a config, and nothing on the asks rail says what
happens if the person being asked stays silent. A claim the product makes in copy has to be
readable on the product, or the copy is the only place it is true.

Two changes, both copy: an attestation label wherever a model is shown, and a consequence line on
every open ask.

## 2. The rule that governs every string

- **Plain words a stranger owns.** "seen", "said", "waiting on", "will go ahead". The protocol's
  own tokens (`observed`, `declared`, `binding`, `risk_accepted`) never appear as user-facing text;
  they may appear in a `title=` tooltip after the plain word, for members who know them.
- **Never imply enforcement musterd does not do.** "seen by the harness" is a fact about the
  record. It is not "verified", "trusted", or "safe"; those words do not appear.
- **A missing attestation is shown, not hidden.** ADR 158: a declared, visible gap beats a silent
  pretence of knowledge.
- **The human is a member, never a supervisor** (`PRODUCT.md`). An ask "waits on nick"; it is not
  "pending approval".
- brand.md §4 voice; §5 nouns (**member**, **act**, **seat**); no hype list words; no "swarm".

## 3. The attestation label

Wherever a member's model is shown (`/live` roster plate and office nameplate detail, `/audit`
actor column on hover), the model carries one of four labels. Source is the wire's
`model_source` (`packages/protocol/src/model.ts`, `WIRE_ATTESTATION_SOURCES`) plus its absence.

| `model_source` | Visible label | `title=` tooltip |
| --- | --- | --- |
| `observed` | **seen** | `The harness reported this model during the session. Observed, not declared.` |
| `environment` | **said** | `Set by the session's environment (MUSTERD_MODEL). Declared by a person or a script, not seen by the harness.` |
| `binding` | **said** | `Set in the workspace binding. Declared in config, not seen by the harness.` |
| absent / `unknown` | **unattested** | `No model was attested for this occupancy. Its review grade is unknown, and it cannot be picked as a cross-family reviewer.` |

Rendering rules:

- The label sits after the model, lower-case, muted, in the mono face: `claude-opus-5 · seen`.
  "unattested" replaces the model string entirely: `unattested`.
- **"seen" and "said" must differ by more than the word.** "seen" takes the ink colour; "said" the
  muted colour; "unattested" the warning colour from brand.md §2 semantic table. A colour-blind
  reader still gets the word.
- On `/audit`, the actor cell gains the label in its tooltip, not inline: the table is dense and
  the column is a name. Tooltip: `<name> · <model> · <label>` using the plain word, e.g.
  `miley · claude-opus-5 · seen`. For a system row (`actor` null) nothing is added.
- When observed and declared disagree for the same occupancy (ADR 158's health signal), the label
  is **seen** and the tooltip appends: `Config said <declared>. The record keeps what was seen.`

## 4. The hold-state line on the asks rail

`/live`'s asks strip (`packages/web/src/live/AsksStrip.tsx`) shows who is waiting, what they want,
the tier as a token (`blocking` / `standard` / `advisory`), and a clock. The tier token means
nothing to a stranger. Replace the visible token with a consequence line; keep the token in the
tooltip.

| State (`asks.ts`) | Visible line | `title=` tooltip |
| --- | --- | --- |
| `open`, tier `blocking` | **waiting on {name} · holds until answered** | `Blocking. The asker pauses and keeps re-notifying. It will not go ahead without an answer.` |
| `open`, tier `standard` | **waiting on {name} · goes ahead in {m}m if unanswered** | `Standard. If nobody answers in the window, the asker proceeds and records that it proceeded without an answer.` |
| `open`, tier `advisory` | **waiting on {name} · goes ahead in {m}m if unanswered** | `Advisory. Same as standard, shorter window.` |
| `held` | **{name} has not answered · {asker} is holding** | `The window ran out on a blocking ask. The asker is paused and re-notifying; nothing proceeded.` |
| `risk_accepted` | **{asker} went ahead without {name}** | `The window ran out. The asker proceeded and wrote down that it did so without an answer.` |
| `stranded` | **nobody home to answer · {asker} is holding** | `A blocking ask with no reachable answerer. Held, not proceeded (ADR 153).` |
| `lapsed` | **went unanswered · {asker} went ahead** | `Below the top tier, out of window, nobody home. Proceeded with the risk recorded.` |
| `accepted` / `declined` / `resolved` / `deferred` | unchanged: the existing verdict rendering | — |

Rules:

- `{name}` is the member being asked, `{asker}` the member asking; both are roster names, never
  "the human" or "the agent". When the ask is to `@team`, `{name}` reads `anyone`.
- `{m}m` is minutes remaining, from the same clock the strip already ticks; below one minute it
  reads `under a minute`.
- The empty state stays as shipped: `nothing waiting on a human`.
- No line ever says "approval", "pending", "escalated", or "blocked" as the human-facing word. A
  hold is a fact about the asker, not a status of the human.

## 5. What this spec does not change

- No wire change. Every string derives from fields already on the page (`model_source`, ask
  `state`, `tier`, `deadline`).
- No new glossary term. "seen", "said", "unattested" are labels, not nouns; ADR 296 gates are
  untouched.
- The office scene's plate (`office-scene/index.ts`, `plateDetailParts`) gets the same label as the
  roster; if plate width forbids it, the label goes to the plate's hover detail and the roster keeps
  it inline. The designer decides; the words do not change.

## 6. Acceptance

1. Open `/live` on a team with one observed and one declared occupancy: the two plates differ in
   word and colour; the tooltip names the source in the plain sentence above.
2. An occupancy with no attestation shows `unattested` in the warning colour, and the tooltip says
   why it matters (cannot be picked as a cross-family reviewer).
3. Raise a `blocking` ask and a `standard` ask from an agent to a human: the strip reads the two
   "waiting on" lines above; after the standard window lapses with no answer, the line flips to
   "went ahead without"; the blocking one flips to "is holding".
4. Every string is in this document character for character; a reviewer diffs the rendered text.
5. `pnpm vocab:check` and `pnpm --filter @musterd/web test` green.
