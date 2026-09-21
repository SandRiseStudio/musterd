#!/usr/bin/env python3
"""The claims ledger -- a false claim is recorded by its correction.

One file per entry: who claimed it, who caught it, through which channel, how
long it stood, and what it cost. Minted by the CORRECTOR at the moment of
correction, riding an act they are already performing. Never a sweep, never a
patrol, never a background job.

    ./claims.py [entries_dir]           validate every entry
    ./claims.py [entries_dir] --cut     validate, then print the aggregate

Exit 0 when every entry is well formed, 1 when one is not, 2 when the directory
cannot be read. Python 3.8+, standard library only.

NO BARE RATES, EVER. `--cut` prints COUNTS and never a percentage, and it prints
the detection-channel breakdown and the denominator caveat every time, because
they are not optional context -- they are the finding. This ledger measures
CAUGHT wrongness, and catching is proportional to scrutiny. A rate without its
detection story is a falsifier that cannot fail, wearing a new costume.

SELF-CORRECTION SCORES BEST. The published badness ordering of channels is
self < peer < acceptance < challenge < human < collision. If this ledger ever
makes someone regret posting a retraction, it has failed at its one job.
"""

import os
import re
import sys
from datetime import datetime

REQUIRED = (
    "claim", "claimant", "claimant_model", "claim_ref", "claim_class",
    "claim_confidence", "claimed_at", "falsified_at", "detection_channel",
    "detection_latency", "corrector", "corrector_model", "correction_ref",
    "cost", "status", "falsifier",
)
CLASSES = ("measurement", "causal", "defect", "absence", "record")
# By process stage, in increasing order of badness. `self` is the BEST way to have been wrong.
CHANNELS = ("self", "peer", "acceptance", "challenge", "human", "collision")
STATUSES = ("falsified", "amended", "overturned")

FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n?(.*)\Z", re.S)
KV = re.compile(r"^([a-z_]+):\s*(.*)$")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def unquote(v):
    v = v.strip()
    for q in ('"', "'"):
        if len(v) >= 2 and v[0] == q and v[-1] == q:
            return v[1:-1]
    return v


def parse(path, text):
    m = FRONTMATTER.match(text)
    if not m:
        return None
    fields = {}
    for raw in m.group(1).split("\n"):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        kv = KV.match(raw)
        if kv:
            fields[kv.group(1)] = unquote(kv.group(2))
    return {"path": path, "fields": fields, "body": m.group(2)}


def is_real_date(v):
    if not isinstance(v, str) or not ISO.match(v):
        return False
    try:
        datetime.strptime(v, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def validate(e):
    errors = []
    f = e["fields"]
    at = lambda msg: errors.append("%s -- %s" % (e["path"], msg))

    for key in REQUIRED:
        if not f.get(key, "").strip():
            at("missing required field `%s`." % key)

    for key, allowed in (("claim_class", CLASSES), ("detection_channel", CHANNELS), ("status", STATUSES)):
        v = f.get(key, "").strip()
        if v and v not in allowed:
            at("`%s` must be one of %s; found `%s`." % (key, " | ".join(allowed), v))

    for key in ("claimed_at", "falsified_at"):
        v = f.get(key, "").strip()
        if v and not is_real_date(v):
            at("`%s` must be a real ISO date (YYYY-MM-DD); found `%s`." % (key, v))

    a, b = f.get("claimed_at", "").strip(), f.get("falsified_at", "").strip()
    if is_real_date(a) and is_real_date(b) and b < a:
        at("`falsified_at` (%s) is before `claimed_at` (%s) -- a claim cannot be caught before it is made." % (b, a))

    # Stated confidence, or an explicit `unstated`. NEVER infer one: an absent
    # confidence is absent, not 1.0. Scoring an inferred certainty punishes
    # someone for a number they did not give.
    c = f.get("claim_confidence", "").strip()
    if c and c != "unstated":
        try:
            v = float(c)
            if not (0.0 < v <= 1.0):
                raise ValueError
        except ValueError:
            at("`claim_confidence` must be a probability in (0, 1] or the word `unstated`; found `%s`. "
               "Never infer one -- an absent confidence is absent, not 1.0." % c)

    # An entry is itself a claim (wiki rule 3), so it carries a falsifier that can fail.
    if len(f.get("falsifier", "").strip()) < 40:
        at("`falsifier` must name an observation that would show THIS ENTRY is wrong. "
           "An entry is itself a claim and is not exempt from the discipline it records.")

    if not e["body"].strip():
        at("no body. The frontmatter is the index; the body is what was claimed and what showed it wrong.")
    return errors


def cut(entries):
    """Counts only -- never a percentage. See the module docstring."""
    def tally(key, order):
        counts = {k: 0 for k in order}
        for e in entries:
            v = e["fields"].get(key, "").strip()
            if v in counts:
                counts[v] += 1
        return counts

    out = ["", "cut over %d entries -- COUNTS, not rates." % len(entries), ""]
    out.append("by detection channel (self is the BEST way to have been wrong):")
    for k, n in tally("detection_channel", CHANNELS).items():
        out.append("  %-12s %s" % (k, "#" * n + (" %d" % n if n else " 0")))
    out.append("")
    out.append("by claim class:")
    for k, n in tally("claim_class", CLASSES).items():
        out.append("  %-12s %s" % (k, "#" * n + (" %d" % n if n else " 0")))
    out.append("")
    out.append("DENOMINATOR: these are CAUGHT claims. The denominator -- claims made --")
    out.append("is unknown and unknowable from this ledger. Catching is proportional to")
    out.append("scrutiny, so a channel with a high count may be the one doing its job.")
    out.append("Do not divide these by anything. Do not rank people by them.")
    return "\n".join(out)


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    want_cut = "--cut" in argv[1:]
    d = args[0] if args else "entries"

    if not os.path.isdir(d):
        sys.stderr.write("no such directory: %s\n" % d)
        return 2

    entries, errors = [], []
    for name in sorted(os.listdir(d)):
        if not name.endswith(".md") or name == "README.md":
            continue
        path = os.path.join(d, name)
        with open(path) as fh:
            e = parse(path, fh.read())
        if e is None:
            errors.append("%s -- no frontmatter. An entry is structured data plus prose." % path)
            continue
        entries.append(e)
        errors += validate(e)

    if errors:
        for e in errors:
            sys.stderr.write("x %s\n" % e)
        return 1

    overturned = sum(1 for e in entries if e["fields"].get("status") == "overturned")
    sys.stdout.write(
        "ok claims: %d entries well formed -- %d overturned (entries err too, and stay visible)\n"
        % (len(entries), overturned)
    )
    if want_cut:
        sys.stdout.write(cut(entries) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
