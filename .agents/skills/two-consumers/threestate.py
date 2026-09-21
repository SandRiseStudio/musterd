#!/usr/bin/env python3
"""Read a field three ways, and refuse to let ABSENT become a value.

A derived read over evidence has at least three outcomes -- the fact holds, the
fact does not hold, and THE EVIDENCE SUPPORTS NEITHER -- and the third is a
first-class value, not a falsy side, not an overloaded null, and not an omitted
field the reader has to interpret.

    ./threestate.py <data.jsonl|data.json> --field NAME
                    [--abstain VALUE]... [--true VALUE]... [--false VALUE]...

Exit 0 when the field is unambiguous, 1 when a rate over it would span two
populations, 2 when the input cannot be read. Python 3.8+, stdlib only.

WHY THIS REFUSES TO PRINT A RATE. When a row is missing the field, it means one
of two different things: this row's writer OBSERVED nothing, or this row's
writer PREDATES the field. Those are different facts. Divide by the row count
and both vanish into a denominator, and the remainder reads as the whole.

So: counts always, and a rate only when nothing is absent. The absent count is
printed first, because it is the finding.
"""

import json
import os
import sys

SENTINEL_ABSTAIN = ("unknown", "unset", "n/a", "na", "abstain", "abstained", "undetermined")


def load(path):
    with open(path) as fh:
        raw = fh.read()
    rows, err = [], None
    stripped = raw.strip()
    if stripped.startswith("["):
        return json.loads(stripped), None
    for i, line in enumerate(raw.split("\n"), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except ValueError as exc:
            err = "line %d: %s" % (i, exc)
            break
    return rows, err


def classify(row, field, truthy, falsy, abstain):
    if not isinstance(row, dict) or field not in row:
        return "absent"
    v = row[field]
    if v is None:
        return "null"
    s = str(v).strip().lower()
    if s in abstain:
        return "abstained"
    if truthy and s in truthy:
        return "true"
    if falsy and s in falsy:
        return "false"
    if isinstance(v, bool):
        return "true" if v else "false"
    return "other"


def main(argv):
    args, multi, flags, rest = [], {"abstain": [], "true": [], "false": []}, {}, argv[1:]
    skip = set()
    for i, a in enumerate(rest):
        if i in skip:
            continue
        if a in ("--abstain", "--true", "--false") and i + 1 < len(rest):
            multi[a[2:]].append(rest[i + 1].strip().lower()); skip.add(i + 1)
        elif a == "--field" and i + 1 < len(rest):
            flags["field"] = rest[i + 1]; skip.add(i + 1)
        elif not a.startswith("--"):
            args.append(a)

    if not args or "field" not in flags:
        sys.stderr.write("usage: threestate.py <data.jsonl> --field NAME [--abstain V]...\n")
        return 2
    path, field = args[0], flags["field"]
    abstain = set(multi["abstain"]) | set(SENTINEL_ABSTAIN)
    truthy, falsy = set(multi["true"]), set(multi["false"])

    try:
        rows, err = load(path)
    except (OSError, ValueError) as exc:
        sys.stderr.write("cannot read %s: %s\n" % (path, exc))
        return 2
    if err:
        sys.stderr.write("cannot parse %s -- %s\nRefusing to report over a partial read.\n" % (path, err))
        return 2
    if not rows:
        sys.stderr.write("%s has no rows. Nothing was counted, which is not a result.\n" % path)
        return 2

    counts = {}
    for r in rows:
        k = classify(r, field, truthy, falsy, abstain)
        counts[k] = counts.get(k, 0) + 1

    total = len(rows)
    absent = counts.get("absent", 0)
    nulls = counts.get("null", 0)
    other = counts.get("other", 0)

    sys.stdout.write("field `%s` over %d row(s)\n\n" % (field, total))
    # Absent first: it is the finding, not a footnote.
    sys.stdout.write("  absent      %6d   <- the field is not there at all\n" % absent)
    sys.stdout.write("  null        %6d\n" % nulls)
    sys.stdout.write("  abstained   %6d   <- recorded as 'we do not know'\n" % counts.get("abstained", 0))
    sys.stdout.write("  true        %6d\n" % counts.get("true", 0))
    sys.stdout.write("  false       %6d\n" % counts.get("false", 0))
    if other:
        sys.stdout.write("  other       %6d   <- values in none of the named sets\n" % other)
    sys.stdout.write("\n")

    sys.stdout.flush()  # counts before findings, whatever the caller redirects

    problems = []
    if absent:
        problems.append(
            "%d row(s) do not carry `%s` at all. That means one of TWO things -- the writer\n"
            "  observed nothing, or the writer PREDATES the field -- and nothing here can tell\n"
            "  them apart. A rate over this field would span two populations.\n"
            "  Repair: record the distinction where it is KNOWN, not where it is needed. A read\n"
            "  cannot recover a fact the system declined to write, so the fix for a guessing\n"
            "  read is almost always an earlier write." % (absent, field))
    if nulls and counts.get("abstained", 0):
        problems.append(
            "both `null` (%d) and an explicit abstention (%d) appear. If they mean the same\n"
            "  thing, pick one; if they mean different things, NAME the second after its cause.\n"
            "  `unknown` is fine when there is one way to be uninformed -- when there are\n"
            "  several, they are different facts and collapsing them rebuilds the defect one\n"
            "  level up." % (nulls, counts.get("abstained", 0)))

    if problems:
        for p in problems:
            sys.stderr.write("x %s\n" % p)
        sys.stderr.write(
            "\nNo rate is printed. Absent is unknown -- never zero, never a guess.\n"
            "And never backfill a verdict onto history: rows recorded before a distinction\n"
            "existed keep their old label and are reported as legacy, explicitly. Backfilling\n"
            "makes the record LOOK complete while asserting things nobody observed.\n")
        return 1

    known = counts.get("true", 0) + counts.get("false", 0)
    if known and not counts.get("abstained", 0) and not other:
        sys.stdout.write("ok every row carries `%s`. true %d/%d over a complete population.\n"
                         % (field, counts.get("true", 0), known))
    else:
        sys.stdout.write("ok every row carries `%s`; %d abstained, so the denominator for any\n"
                         "   rate is the %d decided row(s), and say so wherever you print it.\n"
                         % (field, counts.get("abstained", 0), known))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
