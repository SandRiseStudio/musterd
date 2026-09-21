#!/usr/bin/env python3
"""The watch gate -- a pre-registered longitudinal question cannot rot into an unread sweep.

A watch is one markdown file with frontmatter, stating -- BEFORE collection
starts -- the question, the falsifier that settles it, the population sampled,
the conditions that disqualify its own window, where samples accumulate, who is
accountable, and the date by which it must resolve.

    ./watches.py [watches_dir] [--base <git-ref>] [--root <repo-root>]

Exit 0 when every watch is well formed and none has outlived its date, 1 when
one has, 2 when the directory cannot be read. Python 3.8+, standard library
only. `--base` additionally enforces immutability against a git ref; without it
that rule is skipped and the run says so rather than implying it passed.

Three rules, deliberately scoped differently:

  A1. no watch outlives its `revisit_by`    TREE check
  A2. `revisit_by` never moves              DIFF check (needs --base)
  S.  the schema, on every file             TREE check

RULE A1 BREAKS THE BUILD ON A DATE ROLLOVER WITH NO CODE CHANGE. That is
uncomfortable and it is the design. Its pressure valve is the honest one:
resolve the watch, or mark it `void: unattended`. Voiding is not a dodge -- it
records that nobody looked, which is the datum you want and the thing an
unread sweep hides.

WHY IMMUTABILITY IS A RULE AND NOT A CONVENTION. The failure this exists to
prevent is a sweep that renews itself for free. Renewal has to cost a decision,
so `revisit_by` cannot move: continuing a question means a NEW file, with a new
question, in a diff someone reviews.

NO YAML DEPENDENCY. The frontmatter subset a watch uses is scalars and block
lists, so it is parsed here rather than pulling in an engine. An empty scalar
and the head of a block list are identical in this subset (`key:` with nothing
after it), so both become a list -- which is what lets `resolution:` sit empty
on an open watch with no sentinel value.
"""

import os
import re
import subprocess
import sys
from datetime import datetime, timezone

REQUIRED = (
    "question",
    "claim_ref",
    "falsifier",
    "population",
    "series",
    "cadence",
    "opened",
    "opened_by",
    "revisit_by",
    "status",
)
STATUSES = ("open", "resolved", "void")

FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n?(.*)\Z", re.S)
ITEM = re.compile(r"^\s+-\s+(.*)$")
KV = re.compile(r"^([a-z_]+):\s*(.*)$")
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def unquote(v):
    v = v.strip()
    for q in ('"', "'"):
        if len(v) >= 2 and v[0] == q and v[-1] == q:
            return v[1:-1]
    return v


def parse(path, text):
    """Return {'path','fields','body'} or None when there is no frontmatter."""
    m = FRONTMATTER.match(text)
    if not m:
        return None
    fields, list_key = {}, None
    for raw in m.group(1).split("\n"):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        item = ITEM.match(raw)
        if item and list_key is not None:
            fields[list_key].append(unquote(item.group(1)))
            continue
        kv = KV.match(raw)
        if not kv:
            continue
        key, value = kv.group(1), kv.group(2)
        if value.strip() == "":
            fields[key] = []
            list_key = key
        else:
            fields[key] = unquote(value)
            list_key = None
    return {"path": path, "fields": fields, "body": m.group(2)}


def scalar(w, key):
    v = w["fields"].get(key)
    return v.strip() if isinstance(v, str) and v.strip() else None


def items(w, key):
    v = w["fields"].get(key)
    return [s for s in v if s.strip()] if isinstance(v, list) else []


def is_real_date(v):
    if not isinstance(v, str) or not ISO.match(v):
        return False
    try:
        datetime.strptime(v, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def validate(w, root):
    """Every rule a watch must satisfy regardless of the calendar or the diff."""
    errors = []
    at = lambda msg: errors.append("%s -- %s" % (w["path"], msg))

    for key in REQUIRED:
        if scalar(w, key) is None:
            at("missing required field `%s`." % key)

    if not items(w, "void_if"):
        at(
            "`void_if` needs at least one condition. A watch with no way to be void is "
            "claiming its population cannot change -- the assumption that makes a long "
            "series unreadable."
        )

    status = scalar(w, "status")
    if status is not None and status not in STATUSES:
        at("`status` must be one of %s; found `%s`." % (" | ".join(STATUSES), status))

    resolution = scalar(w, "resolution")
    if status in ("resolved", "void") and resolution is None:
        at(
            "`status: %s` requires a `resolution`. A terminal watch with no verdict is the "
            "silence this primitive exists to prevent." % status
        )
    if status == "open" and resolution is not None:
        at("`resolution` is set while `status` is still `open`. Move the status, or drop the verdict.")

    for key in ("opened", "revisit_by"):
        v = scalar(w, key)
        if v is not None and not is_real_date(v):
            at("`%s` must be a real ISO date (YYYY-MM-DD); found `%s`." % (key, v))

    opened, revisit = scalar(w, "opened"), scalar(w, "revisit_by")
    if is_real_date(opened or "") and is_real_date(revisit or "") and revisit <= opened:
        at("`revisit_by` (%s) must be after `opened` (%s)." % (revisit, opened))

    ref = scalar(w, "claim_ref")
    if ref is not None and not os.path.exists(os.path.join(root, ref)):
        at(
            "`claim_ref` points at `%s`, which does not exist. It is the post-back target -- "
            "a resolution has to land somewhere a reader already goes." % ref
        )
    return errors


def rule_a1(watches, today):
    """No open watch outlives its own death date."""
    errors = []
    for w in watches:
        if scalar(w, "status") != "open":
            continue
        revisit = scalar(w, "revisit_by")
        if is_real_date(revisit or "") and revisit < today:
            errors.append(
                '%s -- open past its `revisit_by` (%s, today %s). Resolve it with a verdict, '
                'or close it honestly: `status: void` with `resolution: "unattended -- '
                'revisit_by passed with nobody reading the series. No verdict."`'
                % (w["path"], revisit, today)
            )
    return errors


def rule_a2(watches_dir, base, root):
    """`revisit_by` is immutable once a watch is on the trunk. Needs git.

    Returns (errors, ran). `ran` is False when git could not answer -- an
    abstention, never a pass, because a check that reports "clean" from its own
    outage is the failure this whole skill is about.
    """
    errors = []
    try:
        out = subprocess.run(
            ["git", "-C", root, "diff", "--name-only", "%s...HEAD" % base, "--", watches_dir],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return [], False
    if out.returncode != 0:
        return [], False

    for path in [p for p in out.stdout.split("\n") if p.strip().endswith(".md")]:
        before = subprocess.run(
            ["git", "-C", root, "show", "%s:%s" % (base, path)], capture_output=True, text=True
        )
        if before.returncode != 0:
            continue  # new file on this branch -- nothing to be immutable against
        try:
            with open(os.path.join(root, path)) as fh:
                after_text = fh.read()
        except OSError:
            continue
        b, a = parse(path, before.stdout), parse(path, after_text)
        if not b or not a:
            continue
        was, now = scalar(b, "revisit_by"), scalar(a, "revisit_by")
        if was and now and was != now:
            errors.append(
                "%s -- `revisit_by` moved %s -> %s. A watch cannot be renewed in place. Open a "
                "NEW watch with a new question; free renewal is the disease." % (path, was, now)
            )
    return errors, True


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags = {}
    rest = argv[1:]
    for i, a in enumerate(rest):
        if a in ("--base", "--root") and i + 1 < len(rest):
            flags[a[2:]] = rest[i + 1]
            if rest[i + 1] in args:
                args.remove(rest[i + 1])

    watches_dir = args[0] if args else "watches"
    root = flags.get("root", ".")
    full = os.path.join(root, watches_dir)

    if not os.path.isdir(full):
        sys.stderr.write("no such directory: %s\n" % full)
        return 2

    watches, unparsed = [], []
    for name in sorted(os.listdir(full)):
        if not name.endswith(".md"):
            continue
        rel = os.path.join(watches_dir, name)
        with open(os.path.join(full, name)) as fh:
            w = parse(rel, fh.read())
        (watches.append(w) if w else unparsed.append(rel))

    today = datetime.now(timezone.utc).date().isoformat()
    errors = ["%s -- no frontmatter. A watch is its pre-registration." % p for p in unparsed]
    for w in watches:
        errors += validate(w, root)
    errors += rule_a1(watches, today)

    immutability_ran = False
    if "base" in flags:
        more, immutability_ran = rule_a2(watches_dir, flags["base"], root)
        errors += more

    if errors:
        for e in errors:
            sys.stderr.write("x %s\n" % e)
        return 1

    open_n = sum(1 for w in watches if scalar(w, "status") == "open")
    void_n = sum(1 for w in watches if scalar(w, "status") == "void")
    sys.stdout.write(
        "ok watches: %d total -- %d open, %d resolved, %d void; none past its revisit_by\n"
        % (len(watches), open_n, len(watches) - open_n - void_n, void_n)
    )
    if "base" not in flags:
        sys.stdout.write("  ! immutability NOT checked -- pass --base <ref> to enforce it\n")
    elif not immutability_ran:
        sys.stdout.write(
            "  ! immutability UNKNOWN -- git could not answer against '%s'. Not a pass.\n"
            % flags["base"]
        )
    for w in watches:
        if scalar(w, "status") == "open":
            sys.stdout.write(
                "  - %s  %s (%s, due %s)\n"
                % (scalar(w, "opened_by"), scalar(w, "question"), w["path"], scalar(w, "revisit_by"))
            )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
