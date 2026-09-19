# The one-slider

`one-slide.html` is **the source**. `musterd-one-slide.pdf` is a build artifact — never hand-edit
it, and never send a PDF whose copy you have not changed here first.

This is the single page for a demo-night or accelerator application, or for anyone who will read
exactly one thing about musterd.

## Rebuild it

Needs Chrome, which is the only dependency and is not added to the repo:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="docs/brand/one-slide/musterd-one-slide.pdf" \
  --virtual-time-budget=2000 \
  "file://$PWD/docs/brand/one-slide/one-slide.html"
```

The `CVDisplayLinkCreateWithCGDisplay failed` lines on stderr are headless Chrome noise on macOS;
the render still succeeds. Check the `written to file` line instead, then open the PDF and look at
it — one page, 16:9, legible on a laptop.

## Where the copy comes from

Nothing on this slide is invented. Change the sources first, then the slide.

| On the slide | Comes from |
| --- | --- |
| Headline | `docs/design/brand.md` §1 — the canonical tagline, verbatim |
| "The second agent is where it breaks" | The problem as [ADR 320](../../decisions/320-positioning-the-value-prop-decided.md) frames it: coordination between actors nobody centrally owns |
| "you take part in the work instead of approving all of it" | ADR 320 §2 — the human is a member, never an approver |
| "nobody can say which agent did it" / "Every act on the roster has a name on it" | [ADR 320](../../decisions/320-positioning-the-value-prop-decided.md) §5 (2026-09-16) — answer the fear of agents nobody owns with names and an observed record, never with a containment claim |
| Roll call and act chips | Real members of the `revive` team; real acts from `SPEC.md` §3 |
| "Runs on your own machine" | Local-first; `PRIVACY.md` |
| Harness list | `SPEC.md` §1's Surfaces |
| MIT | `LICENSE` |

## Rules this slide has to keep

- **No invented product output.** Every name, surface, lane and act in the board mockup is real.
  Mocking output the CLI does not produce is forbidden by the product-communications skill, and a
  reviewer who has seen the real thing will notice.
- **No "coordination layer" bare.** ADR 320 §4: the term is contested, and musterd wins on the
  qualifier. This slide currently avoids the phrase; if you add it, qualify it.
- **No protocol vocabulary.** "Typed acts", "typed handoffs", "lanes", "seats", "presence" mean
  nothing to a stranger reading one page. The previous version of this slide sold "typed
  handoffs"; nick cut exactly that phrase from the demo-night application on 2026-09-14. Verbs the
  reader already owns — hand off, ask, decline, close — carry it instead.
- **No hype vocabulary.** `docs/design/brand.md` §4 has the banned list.

## History

Before 2026-09-14 this slide existed only as a PDF in a downloads folder with no source anywhere.
It sat three weeks behind the positioning decision and nobody could edit it. That is the reason
this directory exists: the artifact people send to strangers has to be rebuildable.
