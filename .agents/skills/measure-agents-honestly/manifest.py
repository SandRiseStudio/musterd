#!/usr/bin/env python3
"""The run manifest -- a frozen ruler must not bend to fit the result.

Everything a measurement needs pinned goes in one file, BEFORE the run. This
script refuses a manifest that is missing a pin, and detects one that changed
after it was frozen.

    ./manifest.py check  <manifest.json>    every pin present and well formed
    ./manifest.py freeze <manifest.json>    record its hash beside it
    ./manifest.py verify <manifest.json>    refuse if it changed since freezing

Exit 0 clean, 1 on a refusal, 2 when the file cannot be read.
Python 3.8+, stdlib only.

WHY A HASH. "Pre-registered" is a claim about the past, and prose cannot carry
it: a manifest edited mid-run looks exactly like one written carefully up front.
The hash is small, and it is the difference between saying the ruler was frozen
and being able to show it.

WHAT IT CANNOT DO. A freeze file is written by the same person running the
experiment, on the same machine, and can be regenerated at any time. It defeats
drift and forgetfulness, not a determined author. Publish the hash somewhere
you do not control -- in the pre-registration, an issue, a commit someone else
reviews -- and it starts meaning something to a reader.
"""

import hashlib
import json
import os
import re
import sys

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SHA = re.compile(r"^[0-9a-f]{7,40}$")

# Every pin. Each is here because leaving it out lets a result be explained after
# the fact by something nobody wrote down.
PINS = {
    "question": "the one question this run answers, stated so it can come out NO",
    "predicate_set": "the version of the scoring rules -- changing them means a NEW version",
    "declared_on": "the date this manifest was pre-registered (YYYY-MM-DD)",
    "model": "the exact model id, not a family name",
    "harness": "the harness and its version",
    "kickoff_sha": "the starting commit, identical in every arm",
    "arms": "every condition being compared, including the controls",
    "denominator": "what each reported rate is divided BY, in words",
    "headline": "the ONE number this run is about",
    "guardrail": "what must NOT get worse for the headline to count",
    "stop_rule": "when the run ends, decided before it starts",
}
LIST_PINS = ("arms",)


def load(path):
    with open(path) as fh:
        return json.load(fh)


def canonical(obj):
    """Stable bytes for hashing: key order and whitespace must not change the hash."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def freeze_path(path):
    return path + ".frozen"


def cmd_check(path):
    try:
        m = load(path)
    except (OSError, ValueError) as exc:
        sys.stderr.write("cannot read %s: %s\n" % (path, exc))
        return 2
    if not isinstance(m, dict):
        sys.stderr.write("%s must contain a JSON object.\n" % path)
        return 2

    errors = []
    for key, why in PINS.items():
        v = m.get(key)
        if key in LIST_PINS:
            if not isinstance(v, list) or len([x for x in v if str(x).strip()]) < 2:
                errors.append("`%s` needs at least two entries -- %s. A single arm is not a comparison." % (key, why))
            continue
        if not isinstance(v, str) or not v.strip():
            errors.append("missing `%s` -- %s" % (key, why))

    d = m.get("declared_on")
    if isinstance(d, str) and d.strip() and not ISO.match(d.strip()):
        errors.append("`declared_on` must be YYYY-MM-DD; got %r." % d)
    k = m.get("kickoff_sha")
    if isinstance(k, str) and k.strip() and not SHA.match(k.strip()):
        errors.append("`kickoff_sha` must be a git SHA; got %r. A branch name is not a pin -- it moves." % k)

    # A rate with no denominator is the failure this whole skill is about.
    if isinstance(m.get("denominator"), str) and len(m["denominator"].strip()) < 20:
        errors.append("`denominator` must say what the rate is divided BY, in words a stranger can check.")

    # The guardrail is what stops a headline being bought with something else.
    if isinstance(m.get("guardrail"), str) and len(m["guardrail"].strip()) < 20:
        errors.append("`guardrail` must name what must not get worse. 'none' is not a guardrail; if truly none, say why.")

    if errors:
        for e in errors:
            sys.stderr.write("x %s\n" % e)
        sys.stderr.write("\nA manifest missing a pin lets the result be explained afterwards by\nsomething nobody wrote down.\n")
        return 1
    sys.stdout.write("ok manifest: all %d pins present -- %d arms, predicate set %s, declared %s\n"
                     % (len(PINS), len(m["arms"]), m["predicate_set"], m["declared_on"]))
    return 0


def cmd_freeze(path):
    rc = cmd_check(path)
    if rc != 0:
        sys.stderr.write("\nrefusing to freeze a manifest that does not pass `check`.\n")
        return rc
    try:
        h = hashlib.sha256(canonical(load(path))).hexdigest()
        with open(freeze_path(path), "w") as fh:
            json.dump({"sha256": h, "predicate_set": load(path)["predicate_set"]}, fh, indent=2)
            fh.write("\n")
    except OSError as exc:
        sys.stderr.write("cannot write the freeze file: %s\n" % exc)
        return 2
    sys.stdout.write("frozen %s\n  sha256 %s\n\nPublish that hash where you do not control it, or it only\nproves the file has not changed on this machine.\n" % (path, h))
    return 0


def cmd_verify(path):
    fp = freeze_path(path)
    try:
        frozen = load(fp)
    except (OSError, ValueError):
        sys.stderr.write(
            "x no freeze file at %s -- this manifest was never frozen.\n\n"
            "UNFROZEN is not the same as CHANGED, and this is not an accusation:\n"
            "it means the pre-registration claim has nothing behind it yet. Run\n"
            "`freeze` before the run starts.\n" % fp
        )
        return 1
    try:
        now = hashlib.sha256(canonical(load(path))).hexdigest()
    except (OSError, ValueError) as exc:
        sys.stderr.write("cannot read %s: %s\n" % (path, exc))
        return 2

    if now == frozen.get("sha256"):
        sys.stdout.write("ok manifest unchanged since freezing (predicate set %s)\n" % frozen.get("predicate_set"))
        return 0

    sys.stderr.write(
        "x %s CHANGED after it was frozen.\n  frozen  %s\n  now     %s\n\n"
        "If the change is deliberate, it is a NEW predicate set: bump\n"
        "`predicate_set`, re-freeze, and disclose the change BEFORE the runs it\n"
        "scores. Editing a manifest mid-run and reporting the result as\n"
        "pre-registered is the failure this file exists to make visible.\n"
        % (path, frozen.get("sha256"), now)
    )
    return 1


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        sys.stderr.write("usage: manifest.py check|freeze|verify <manifest.json>\n")
        return 2
    cmd, path = args[0], args[1]
    if cmd == "check":
        return cmd_check(path)
    if cmd == "freeze":
        return cmd_freeze(path)
    if cmd == "verify":
        return cmd_verify(path)
    sys.stderr.write("unknown command: %s\n" % cmd)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
