# Follow-ups — one conversation, one file

One file per conversation that actually happened, named
`<YYYY-MM-DD>-<company>.md`. Lowercase, hyphens, the company as they say it rather than as the
legal entity writes it: `2026-10-07-vercel.md`.

**Write it the same evening.** That is the only rule with teeth, and it is the reason this
directory exists at all — it was named in the plan for weeks before anything could be written into
it, so the first note of the Startup Grind evening would have begun with "make a directory, work
out the filename." At 9pm after four conversations, that is the friction that turns a note into a
memory, and a note written three days later records what you wish had been said.

## The form is not here, on purpose

The questions live in **[`docs/brand/leave-behinds/follow-up-notes.md`](../../brand/leave-behinds/follow-up-notes.md)** and
nowhere else. Copying them into a `TEMPLATE.md` beside this file would make two copies of one list,
which is the shape that drifts — the same defect that put fifteen forbidden claims in two places
until #1592 folded them into one module.

So there is one command, and it is short enough to type from a phone:

```bash
cp docs/brand/leave-behinds/follow-up-notes.md docs/design/follow-ups/$(date +%F)-<company>.md
```

Then delete the form's own header — the two paragraphs above its first `---`, which explain the
form to whoever is copying it and mean nothing inside a filled-in note.

Paper is also fine. The rule is the evening, not the medium.

## The two fields that carry the page

Everything else can be thin. These two cannot:

- **The objection in their words, before it is reframed.** It is the most valuable line on the
  page and the first one lost — by the next morning it has already been smoothed into the version
  that has an answer.
- **A next step with a date.** A row with no date is not a next step; it is a business card.
  [traction-plan](../traction-plan.md) §8 asks for three or more threads with a next step dated in
  Q1, and that is counted from these files.

A conversation where the answer was **no** still gets a file. A short list of yeses is worth more
than a long list of maybes, and the no tells us who this is not for — which is the same
information the scope decisions are built on.

## What travels out of here

Nothing, by default. These are nick's working notes.

Two things are lifted out deliberately: a sentence someone said about musterd goes to
[`../quotes.md`](../quotes.md) **with their permission**, and the last field — "what this
conversation changed" — is what the team reads. If an objection turns out to be on
[security-position](../../brand/leave-behinds/security-position.md) §3's list of things we do not
claim, that is a correction owed to the person by name, not a note filed here.
