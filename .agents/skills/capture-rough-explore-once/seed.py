#!/usr/bin/env python3
"""Capture an idea without judging it, then check it stayed uninterpreted.

    ./seed.py title <body.txt>       the deterministic title, and only that
    ./seed.py check <seed.json>...   refuse a seed that arrived pre-judged

Exit 0 clean, 1 on a refusal, 2 when the input cannot be read.
Python 3.8+, stdlib only.

WHY CAPTURE MUST NOT INTERPRET. A seed that arrives pre-judged is a work item
someone has to ARGUE WITH instead of edit. Tag it, rank it, summarise it or
mark it a duplicate at capture time and you have inserted an opinion nobody
asked for, attached to someone else's idea, before they finished having it.

So capture does exactly two things: it keeps the body VERBATIM, and it derives
a title DETERMINISTICALLY. Same input, same title, every time, with no model in
the loop -- which is what makes the absence of judgement checkable rather than
promised.

THE FIELDS THIS REFUSES are not a style preference. Each was considered at
design time and cut: no reasoning, no auto-tagging, no stakes or goal
suggestion, no duplicate detection.
"""

import json
import re
import sys

TITLE_MAX = 80
# Interpretation, by any name. Each of these is a judgement about the idea that
# capture is not entitled to make.
JUDGEMENT_FIELDS = (
    "tags", "labels", "topics", "category", "stakes", "priority", "severity",
    "goal", "goal_id", "duplicate_of", "dedupe", "similar_to", "summary",
    "reasoning", "analysis", "score", "rank", "sentiment", "intent", "estimate",
)
LIFECYCLE = ("open", "exploring", "needs_clarification", "clarified", "completed", "promoted")


def derive_title(body):
    """First non-empty line, whitespace collapsed, cut at a word boundary at 80.

    Deterministic on purpose: no model, no cleverness, no truncation marker that
    varies. A title you cannot re-derive from the body is a title somebody chose.
    """
    first = ""
    for line in body.split("\n"):
        if line.strip():
            first = line
            break
    t = re.sub(r"\s+", " ", first).strip()
    if len(t) <= TITLE_MAX:
        return t
    cut = t[:TITLE_MAX]
    sp = cut.rfind(" ")
    return (cut[:sp] if sp > 0 else cut).rstrip()


def check_seed(s, where):
    errors = []
    at = lambda m: errors.append("%s -- %s" % (where, m))

    body = s.get("body")
    if not isinstance(body, str) or not body.strip():
        at("no `body`. The raw text IS the seed; everything else is derived from it.")
        return errors

    for f in ("captured_at", "source", "submitter"):
        if not str(s.get(f, "")).strip():
            at("missing `%s`. Provenance is not interpretation -- it is what makes the "
               "capture checkable later." % f)

    present = [f for f in JUDGEMENT_FIELDS if f in s and s[f] not in (None, "", [], {})]
    if present:
        at("carries judgement field(s) at capture: %s. A seed that arrives pre-judged is a work "
           "item someone has to ARGUE WITH instead of edit. Each of these was considered at "
           "design time and cut: no reasoning, no auto-tagging, no stakes or goal suggestion, no "
           "duplicate detection. Add them later, as an edit, under a name."
           % ", ".join(present))

    title = s.get("title")
    if title is not None:
        want = derive_title(body)
        if title != want:
            at("`title` is not the deterministic derivation of `body`.\n      got  %r\n      "
               "want %r\n      A title somebody CHOSE is the first interpretation, and it is the "
               "one that sticks." % (title, want))

    state = str(s.get("state", "open")).strip()
    if state not in LIFECYCLE:
        at("`state` must be one of %s; got %r." % (" | ".join(LIFECYCLE), state))

    explorers = s.get("explorers")
    if isinstance(explorers, list) and len(explorers) > 1:
        at("%d explorers at once (%s). One agent explores a seed at a time -- parallel explorers "
           "produce two briefs that have to be reconciled by whoever reads them, which is the "
           "work the brief was supposed to do." % (len(explorers), ", ".join(map(str, explorers))))
    if state == "exploring" and not explorers:
        at("`state: exploring` with no explorer named. An exploration nobody claimed is one "
           "nobody finishes.")

    # Only the submitter may answer a clarification -- others may read, and may
    # not supply an authoritative answer on someone else's idea.
    for i, c in enumerate(s.get("clarifications") or []):
        if not isinstance(c, dict):
            continue
        q, a, who = c.get("question"), c.get("answer"), c.get("answered_by")
        if a and who and str(who) != str(s.get("submitter")):
            at("clarification %d was answered by %r, not the submitter %r. Only the submitter "
               "may answer -- a clarification answered by someone else replaces their intent "
               "with a guess that now looks authoritative." % (i, who, s.get("submitter")))
        if q and not str(q).strip():
            at("clarification %d has an empty question." % i)
    open_qs = [c for c in (s.get("clarifications") or [])
               if isinstance(c, dict) and c.get("question") and not c.get("answer")]
    if len(open_qs) > 1:
        at("%d unanswered clarifications at once. ONE decision-blocking question at a time: a "
           "list of questions is a form, and a form is answered badly or not at all."
           % len(open_qs))
    return errors


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        sys.stderr.write("usage: seed.py title <body.txt> | check <seed.json>...\n")
        return 2

    if args[0] == "title":
        try:
            with open(args[1]) as fh:
                sys.stdout.write(derive_title(fh.read()) + "\n")
        except OSError as exc:
            sys.stderr.write("cannot read %s: %s\n" % (args[1], exc))
            return 2
        return 0

    if args[0] != "check":
        sys.stderr.write("unknown command: %s\n" % args[0])
        return 2

    errors, n = [], 0
    for p in args[1:]:
        try:
            with open(p) as fh:
                doc = json.load(fh)
        except (OSError, ValueError) as exc:
            sys.stderr.write("cannot read %s: %s\n" % (p, exc))
            return 2
        items = doc if isinstance(doc, list) else [doc]
        for i, s in enumerate(items):
            if not isinstance(s, dict):
                errors.append("%s[%d] -- not an object." % (p, i))
                continue
            n += 1
            errors += check_seed(s, "%s[%d]" % (p, i) if len(items) > 1 else p)

    if errors:
        for e in errors:
            sys.stderr.write("x %s\n" % e)
        return 1
    sys.stdout.write("ok seeds: %d captured without judgement\n" % n)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
