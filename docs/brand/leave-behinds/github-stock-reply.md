# The GitHub stock reply

_What a seat drafts and nick approves at a glance, when a stranger opens an issue or a discussion
asking what musterd is, or whether it makes agents safe._
[traction-plan](../../design/traction-plan.md) §8 puts this in the hand-over set: it has to work
with no in-person time and tolerate days of silence.

[security-position](security-position.md) §5 sizes it: **the boundary sentence plus one link.
Nothing else.** The temptation is to answer the whole question in the thread, and the whole answer
is a page, not a comment. Send the sentence and the link; the page does the rest.

---

## The reply

> musterd names the work that goes through the team. It does not contain the agent.
>
> It records who claimed what, who declined, and who accepted it — for acts the daemon accepted, on
> that roster. It does not sandbox your agent, gate its tool calls, or see what it does outside
> musterd. If the question is containment, this is the wrong layer and you want a sandbox.
>
> The long answer, including what we deliberately do not claim:
> https://github.com/SandRiseStudio/musterd/blob/main/docs/brand/leave-behinds/security-position.md

Three short paragraphs, because a bare two-sentence reply to a real question reads as a brush-off.
The second paragraph is the sentence unpacked into its two halves — what is recorded, what is not —
and the last line of it sends the reader somewhere better when this is not their layer. Saying "you
want a sandbox" costs nothing and is the single fastest way to be believed by someone who came in
suspicious.

## When to send it

- Someone asks what musterd is, in a thread that is not about a bug.
- Someone asks whether it makes agents safe, prevents an incident, or stops a rogue agent.
- Someone repeats a claim we do not make — including one of ours that has since been scoped.

## When not to send it

- **A bug report.** Answer the bug. A stock reply to a specific problem is an insult.
- **Someone who has already read the position.** They have earned a real answer.
- **A question with a number in it** — cost, token burn, how many agents. Those get the measurement
  or "not measured", never the sentence.
- **An accusation that lands.** If someone shows a surface where we overclaim, they are right until
  checked. Thank them, open a lane, and say what the fix is. The stock reply used here makes us the
  thing the reply is denying we are.

## The constraint that outlives this file

Every word of the reply is governed by [security-position](security-position.md) §3 — fifteen
claims the copy may never make. Before editing the block above, read that list. It is the same list
that governs the homepage, the leave-behinds and the CFP abstract, and `pnpm claims:check` enforces
four of the fifteen in CI.

