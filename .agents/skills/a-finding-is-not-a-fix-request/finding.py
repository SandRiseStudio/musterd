#!/usr/bin/env python3
"""Classify a review finding -- and refuse a category claim wearing a costume.

A finding is REQUIRED only if the spec would have demanded it BEFORE anyone
opened the diff. Discovery adds information; it does not add obligation.

    ./finding.py check <finding.json>...   validate one or more findings
    ./finding.py template                  print a blank finding

Exit 0 when every finding is well formed, 1 when one is not, 2 when the input
cannot be read. Python 3.8+, stdlib only.

THE ANTI-COSTUME RULE. A REQUIRED must carry a PROBE (how the failure was
reproduced against the reviewed head) or a PIN (what already-written thing it
violates, quoted, with a file and a line). A category claim with neither --
"this is a correctness issue" -- is a note wearing a costume, and this refuses
it. The severity is the claim; the evidence is what makes it one.

A DECLINE HAS THE SAME FLOOR. An author declining a REQUIRED names which of the
four categories it fails. A decline that names no category is the same costume
from the other side, so it is refused the same way.
"""

import json
import os
import re
import sys

CATEGORIES = {
    "honesty": "a claim in the change, its docs or its provenance that is false",
    "leaked-secret": "a credential or token reaching a log, error, trace or response",
    "probe-measured-regression": "reproduced against the reviewed head -- not reasoned about",
    "named-pin": "violates something already written, quoted with file and line",
}
SEVERITIES = ("required", "note")
PIN = re.compile(r"\S+:\d+")
# A field whose CONTENTS are a negation satisfies a presence check while asserting
# the opposite. `probe: "none -- reasoned about"` passed this script's own first run,
# on its own example file: an assertion that admits its own negative case.
NEGATION = re.compile(r"^\W*(none|n/?a|tbd|todo|nothing|not (?:yet|done|reproduced)|-+)\b", re.I)


def evidence_problem(value):
    """None when the field carries evidence; else WHY it does not.

    Two different reasons, kept apart because a message that misattributes its own
    reason teaches the wrong repair.
    """
    v = (value or "").strip()
    if not v:
        return None  # absent is handled by the caller, which knows what was required
    if NEGATION.match(v):
        return "says it has none (%r). A field whose contents are a negation satisfies a " \
               "presence check while asserting the opposite -- leave it out and let the " \
               "severity be judged." % v[:40]
    if len(v) < 12:
        return "is too short to be evidence (%r). Name the command, the test, or the file " \
               "and line -- something the next reader can run or open." % v[:40]
    return None


def check_one(f, where):
    errors = []
    at = lambda m: errors.append("%s -- %s" % (where, m))

    for key in ("summary", "severity"):
        if not isinstance(f.get(key), str) or not f[key].strip():
            at("missing `%s`." % key)
    sev = (f.get("severity") or "").strip()
    if sev and sev not in SEVERITIES:
        at("`severity` must be one of %s; got %r." % (" | ".join(SEVERITIES), sev))

    if sev == "note":
        # A note worth keeping gets a home and a name, or it is buried politely.
        if not str(f.get("routed_to", "")).strip():
            at("a note needs `routed_to` -- where it lands as its own work item. "
               "A note with nowhere to go is a finding you buried politely.")
        if not str(f.get("finder", "")).strip():
            at("a note needs `finder` -- it routes to the board UNDER YOUR NAME. "
               "Routing is not burying; an unnamed note is.")
        return errors

    if sev != "required":
        return errors

    cat = (f.get("category") or "").strip()
    if cat not in CATEGORIES:
        at("a REQUIRED names `category`, one of: %s." % ", ".join(sorted(CATEGORIES)))
        return errors

    raw_probe = str(f.get("probe", "")).strip()
    raw_pin = str(f.get("pin", "")).strip()
    probe, pin = raw_probe, raw_pin
    for label in ("probe", "pin"):
        raw = raw_probe if label == "probe" else raw_pin
        why = evidence_problem(raw)
        if why:
            at("`%s` %s" % (label, why))
            if label == "probe":
                probe = ""
            else:
                pin = ""

    # Leaked secrets are self-evidencing: the finding IS the citation, and asking
    # someone to reproduce one is asking them to leak it again.
    if cat == "leaked-secret":
        if not (probe or pin):
            at("a leaked-secret REQUIRED still cites WHERE -- the file and line the value "
               "reaches. Do not reproduce it; point at it.")
        return errors

    if not probe and not pin:
        at("a REQUIRED needs a `probe` (how you reproduced it against the reviewed head) or a "
           "`pin` (what already-written thing it violates, quoted, with file:line). Neither is "
           "present, so this is a NOTE wearing the word REQUIRED. Reasoning about a failure is a "
           "note; reproducing it is a required.")
        return errors

    if cat == "probe-measured-regression" and not probe:
        at("`category: probe-measured-regression` with no `probe`. The category IS the "
           "reproduction; a pin makes it a named-pin instead.")
    if cat == "named-pin":
        if not pin:
            at("`category: named-pin` with no `pin`. 'Named' is load-bearing -- the REQUIRED must "
               "quote or cite the pin, in the finding itself.")
        elif not PIN.search(pin):
            at("`pin` should cite a file and line (`path/to/file.md:6`), the way precedent is "
               "cited. Got: %r" % pin[:60])
    return errors


def check_decline(d, where):
    """An author's decline: same floor, from the other side."""
    errors = []
    at = lambda m: errors.append("%s -- %s" % (where, m))
    cat = (d.get("fails_category") or "").strip()
    if cat not in CATEGORIES:
        at("a decline names WHICH of the four categories the finding fails: %s. A decline that "
           "names no category is the same costume from the other side."
           % ", ".join(sorted(CATEGORIES)))
    if not str(d.get("routed_to", "")).strip():
        at("a decline routes the finding to the board as a note under the FINDER's name. "
           "Declining costs the author a record the way noting costs the reviewer one.")
    return errors


TEMPLATE = {
    "summary": "one line: what is wrong",
    "severity": "required | note",
    "category": "honesty | leaked-secret | probe-measured-regression | named-pin  (required only)",
    "probe": "how you reproduced it against the reviewed head -- a command, a test, a scenario",
    "pin": "what already-written thing it violates, quoted, with file:line",
    "finder": "your name (notes route under it)",
    "routed_to": "where a note lands as its own work item",
    "decline": {"fails_category": "which category it fails", "routed_to": "where it goes instead"},
}


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if not args:
        sys.stderr.write("usage: finding.py check <finding.json>... | template\n")
        return 2
    if args[0] == "template":
        sys.stdout.write(json.dumps(TEMPLATE, indent=2) + "\n")
        return 0
    if args[0] != "check":
        sys.stderr.write("unknown command: %s\n" % args[0])
        return 2

    paths = args[1:]
    if not paths:
        sys.stderr.write("check needs at least one finding file.\n")
        return 2

    errors, n = [], 0
    for p in paths:
        try:
            with open(p) as fh:
                doc = json.load(fh)
        except (OSError, ValueError) as exc:
            sys.stderr.write("cannot read %s: %s\n" % (p, exc))
            return 2
        items = doc if isinstance(doc, list) else [doc]
        for i, f in enumerate(items):
            if not isinstance(f, dict):
                errors.append("%s[%d] -- not an object." % (p, i))
                continue
            n += 1
            where = "%s[%d]" % (p, i) if len(items) > 1 else p
            errors += check_one(f, where)
            if isinstance(f.get("decline"), dict):
                errors += check_decline(f["decline"], where + " decline")

    if errors:
        for e in errors:
            sys.stderr.write("x %s\n" % e)
        sys.stderr.write("\nA REQUIRED outside the four categories is a note. Complying with one "
                         "is the failure mode:\nan out-of-scope fix bolted on to reach green was "
                         "specified by nobody, and the reviewer\nwho demanded it is the only one "
                         "who ever judged it.\n")
        return 1

    sys.stdout.write("ok findings: %d well formed\n" % n)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
