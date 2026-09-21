#!/usr/bin/env python3
"""Control liveness check — a registry of guards that cannot silently rot.

`controls.json` is a curated *declaration* that certain guards are in force. This
script checks the declaration against the one thing that makes it more than a
list: whether anyone has recently watched each control work.

    ./controls.py [controls.json]

Exit 0 when every control's evidence is current, 1 when one is not, 2 when the
file itself cannot be read. Python 3.8+, standard library only.

The rules, and why each is an error rather than a warning:

  1. exercised XOR never   A control states either a `last_exercised` date or a
     stated reason nobody has ever exercised it. An absent field would mean both
     "never" and "nobody said", and no check can tell those apart. A
     `never_exercised` reason carries `never_exercised_since`, or the declared
     absence is a permanent staleness exemption -- this registry's own thesis
     turned on itself.
  2. dates are real        ISO YYYY-MM-DD, a real calendar date, not in the
     future. A future date pushes a control permanently out of staleness.
  3. tripped <=> dated     `ever_tripped` true needs `last_tripped`. "It has
     caught things" without a date is the exact unfalsifiable shape this exists
     to stop.
  4. counterfactual answered  "Would this have caught the incident that
     motivated it?" is present and substantive. "No" passes; a stub does not.
     The question is the point.
  5. not stale             `last_exercised` -- and equally
     `never_exercised_since` -- within the control's own `stale_after_days`.

Rule 5 is deliberately allowed to break the build on a date rollover with no
code change. That is uncomfortable and it is the design: a liveness check that
cannot fail on its own is precisely the disease. The pressure valve is honest,
not silent -- re-exercise the control and move the date, or widen
`stale_after_days` with a reason in the commit. Both leave a record.
"""

import json
import re
import sys
from datetime import date, datetime, timezone

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")

DATE_FIELDS = ("last_exercised", "last_tripped", "never_exercised_since")
REQUIRED_TEXT = ("id", "claim", "where", "exercise", "motivated_by", "counterfactual")


def is_real_date(s):
    """True iff s is a real calendar date in YYYY-MM-DD (rejects 2026-02-31)."""
    if not isinstance(s, str) or not ISO.match(s):
        return False
    try:
        datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def days_between(iso, today):
    return (today - date.fromisoformat(iso)).days


def check(controls, today):
    """Validate a list of controls. Returns a list of error strings.

    Separated from the entrypoint on purpose: a check whose failure path is
    never executed is itself an unexercised control, and shipping one from
    this file would be absurd. See the falsifiers in SKILL.md.
    """
    errors = []
    seen = set()

    for i, c in enumerate(controls):
        if not isinstance(c, dict):
            errors.append("entry %d: not an object." % i)
            continue

        cid = c.get("id") or "entry %d" % i
        at = lambda msg, cid=cid: errors.append('"%s": %s' % (cid, msg))

        for field in REQUIRED_TEXT:
            v = c.get(field)
            if not isinstance(v, str) or not v.strip():
                at("missing required field `%s`." % field)

        if cid in seen:
            at("duplicate id -- control ids must be unique.")
        seen.add(cid)

        # (1) exercised XOR never
        has_date = "last_exercised" in c
        has_reason = "never_exercised" in c
        if has_date == has_reason:
            at(
                "must declare exactly one of `last_exercised` (a date someone watched it "
                "work) or `never_exercised` (a stated reason nobody has). An absent value "
                "would mean both."
            )
            continue
        if has_reason and len(str(c["never_exercised"]).strip()) < 20:
            at("`never_exercised` must state a real reason, not a placeholder.")
        if has_reason and "never_exercised_since" not in c:
            at(
                "`never_exercised` needs `never_exercised_since` (when the absence started) "
                "-- an undated absence never expires, and a permanent exemption is the exact "
                "rot this registry exists to stop."
            )
        if not has_reason and "never_exercised_since" in c:
            at("has `never_exercised_since` but no `never_exercised` reason -- they travel together.")

        # (2) dates are real, and not in the future
        today_iso = today.isoformat()
        for field in DATE_FIELDS:
            v = c.get(field)
            if v is None:
                continue
            if not is_real_date(v):
                at('`%s` must be a real ISO date (YYYY-MM-DD); got "%s".' % (field, v))
            elif v > today_iso:
                at('`%s` is in the future ("%s") -- a control cannot have been exercised yet.' % (field, v))

        # (3) tripped <=> dated
        tripped = bool(c.get("ever_tripped"))
        if tripped and "last_tripped" not in c:
            at("`ever_tripped` is true but no `last_tripped` date -- an undated catch is unverifiable.")
        if not tripped and "last_tripped" in c:
            at("has a `last_tripped` date but `ever_tripped` is false -- they disagree.")

        # (4) the counterfactual is answered
        if len(str(c.get("counterfactual", "")).strip()) < 40:
            at(
                "must answer `counterfactual` -- would this control have caught the incident "
                'that motivated it? "No" is a valid and useful answer; a stub is not.'
            )

        # (5) not stale -- an exercise date ages, and so does a declared absence.
        bound = c.get("stale_after_days")
        if not isinstance(bound, int) or isinstance(bound, bool) or bound <= 0:
            at("`stale_after_days` must be a positive integer.")
        elif is_real_date(c.get("last_exercised", "")):
            age = days_between(c["last_exercised"], today)
            if age > bound:
                at(
                    "last exercised %dd ago, past its own %dd staleness bound. Exercise it and "
                    "move the date, or widen the bound with a reason -- but do not leave the "
                    "claim standing on evidence this old." % (age, bound)
                )
        elif is_real_date(c.get("never_exercised_since", "")):
            age = days_between(c["never_exercised_since"], today)
            if age > bound:
                at(
                    "never exercised in the %dd since it shipped -- past its own %dd bound. The "
                    "declared absence has expired: fire the control deliberately and record what "
                    "you saw, or retire the entry. It does not get older quietly." % (age, bound)
                )

    return errors


def main(argv):
    path = argv[1] if len(argv) > 1 else "controls.json"
    try:
        with open(path) as fh:
            controls = json.load(fh)
    except (OSError, ValueError) as exc:
        sys.stderr.write("cannot read %s: %s\n" % (path, exc))
        return 2
    if not isinstance(controls, list):
        sys.stderr.write("%s must contain a JSON array of controls.\n" % path)
        return 2

    today = datetime.now(timezone.utc).date()
    errors = check(controls, today)

    if errors:
        for e in errors:
            sys.stderr.write("x %s\n" % e)
        sys.stderr.write(
            "\nA control in the registry is making a claim its evidence no longer supports.\n"
        )
        return 1

    never = [c for c in controls if "never_exercised" in c]
    untripped = [c for c in controls if not c.get("ever_tripped")]
    sys.stdout.write(
        "ok controls: %d registered, all exercise evidence current -- %d never exercised, "
        "%d never tripped\n" % (len(controls), len(never), len(untripped))
    )
    # Never-exercised controls are legal but must not go quiet: they are the whole point.
    # The countdown prints so the expiry is visible before it fails the build.
    for c in never:
        left = ""
        if is_real_date(c.get("never_exercised_since", "")):
            left = " (%dd until this expires)" % (
                c["stale_after_days"] - days_between(c["never_exercised_since"], today)
            )
        sys.stdout.write("  ! %s -- never exercised%s: %s\n" % (c["id"], left, c["never_exercised"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
