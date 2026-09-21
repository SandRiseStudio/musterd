#!/usr/bin/env python3
"""Decision records -- take a number safely, and keep an accepted Decision frozen.

    ./adr.py next  [--dir DIR]                 the next free number
    ./adr.py check [--dir DIR] [--base REF]    refuse a rewritten Decision

`next` reads three places and takes one past the highest number ANY of them
claims: the working tree, the trunk, and the files changed by every open pull
request. Reading the trunk alone is what produces collisions -- the number you
need is claimed by work that has not landed yet.

`check` reads a DIFF, not the tree: for every record that was already accepted
before this branch, the `## Decision` section must be unchanged, or changed only
by adding a dated amendment marker. Every other section stays editable.

Exit 0 clean, 1 on a refusal, 2 when the inputs cannot be read.
Python 3.8+, stdlib only. `git` required for `check`; `gh` optional for `next`.

GAPS ARE NEVER FILLED. The next number is one past the highest claimed, never
the lowest unused. A gap usually means a number was referenced somewhere before
being abandoned or renumbered, and reusing it silently repoints an old reference
at a new decision -- a worse failure than a wasted integer, and harder to see.

IT REPORTS, IT DOES NOT RESERVE. No registry, no lock file. A reservation scheme
needs releasing on abandoned branches and becomes a second source of truth able
to disagree with git. The set of in-flight numbers already exists -- it is the
open pull requests -- so the fix is to LOOK at it, not to mirror it.
"""

import os
import re
import subprocess
import sys

NUM = re.compile(r"(?:^|/)(\d{3,4})-(?!\d{2}-\d{2}-)")
ACCEPTED = re.compile(r"^[-*]?\s*(?:\*\*)?status(?:\*\*)?\s*[:=]\s*accepted\b", re.I | re.M)
DECISION_H = re.compile(r"^##\s+Decision\s*$", re.I)
ANY_H = re.compile(r"^##\s+")
# A dated marker, as a SPAN not a line -- the useful place for one is mid-sentence.
# The date is not decoration: it is what makes the marker a record rather than a note,
# so an undated marker does not match and is refused like any other new prose.
MARKERS = [
    re.compile(r"_\(Amended\s+\d{4}-\d{2}-\d{2}[:.][\s\S]*?\)_"),
    re.compile(r"^[ \t]*>[ \t]*\*\*Amended\s+\d{4}-\d{2}-\d{2}\.?\*\*(?:.*(?:\n[ \t]*>.*)*)", re.M),
]


def git(args, cwd=".", check=True):
    r = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or "git failed")
    return r.stdout


def numbers_in(paths, within=None):
    """Numbers claimed by `NNN-slug.md` filenames.

    Two guards, and BOTH are needed -- the first alone passes by coincidence on a
    repo whose records directory happens to hold no dated files.

    `within` scopes the scan to the records directory, because a pull request
    touches every kind of file and a DATED name like `2026-09-21-a-thing.md` has
    the same shape as a record number. Unscoped, one dated file in one open PR
    pushed the next number to 2027 instead of 433 on a real repository.

    `NUM` then refuses a date even INSIDE that directory: `2026-` followed by
    `MM-DD-` is a date, not a record. Scoping alone left that hole, and the first
    fix looked correct only because the repository under test had no such file.
    """
    out = set()
    for p in paths:
        if not p or not p.endswith(".md"):
            continue
        if within is not None:
            norm = p.replace(os.sep, "/").lstrip("./")
            w = within.replace(os.sep, "/").lstrip("./").rstrip("/")
            if not norm.startswith(w + "/"):
                continue
        m = NUM.search(p.replace(os.sep, "/"))
        if m and len(m.group(1)) <= 4:
            out.add(int(m.group(1)))
    return out


def decision_section(text):
    """The body of `## Decision`, or None when there is no such heading."""
    lines = text.split("\n")
    start = None
    for i, l in enumerate(lines):
        if DECISION_H.match(l):
            start = i
            break
    if start is None:
        return None
    rest = lines[start + 1:]
    for j, l in enumerate(rest):
        if ANY_H.match(l):
            return "\n".join(rest[:j]).strip()
    return "\n".join(rest).strip()


def words(text):
    """Words, not layout: markdown re-wraps freely and a line break is not a decision."""
    return text.split()


def is_append_only_amendment(before, after):
    """True when `after` is `before` plus one or more DATED amendment markers, and nothing else."""
    stripped = after
    for rx in MARKERS:
        stripped = rx.sub(" ", stripped)
    return words(stripped) == words(before)


def cmd_next(d, root):
    claimed, degraded = set(), None
    try:
        claimed |= numbers_in(["%s/%s" % (d, n) for n in os.listdir(d)], within=d)
    except OSError as exc:
        sys.stderr.write("cannot read %s: %s\n" % (d, exc))
        return 2

    try:
        tracked = git(["ls-tree", "-r", "--name-only", "origin/HEAD", "--", d], cwd=root).split("\n")
        claimed |= numbers_in(tracked, within=d)
    except RuntimeError:
        try:
            claimed |= numbers_in(
                git(["ls-tree", "-r", "--name-only", "HEAD", "--", d], cwd=root).split("\n"), within=d
            )
        except RuntimeError:
            pass

    # The open-PR rung is BEST EFFORT and degrades LOUDLY. Authoring must not require
    # the network; a silent degrade would reinstate the exact blind spot this removes.
    try:
        r = subprocess.run(
            ["gh", "pr", "list", "--state", "open", "--limit", "200", "--json", "files"],
            cwd=root, capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            degraded = (r.stderr.strip().split("\n") or ["gh failed"])[-1]
        else:
            import json
            for pr in json.loads(r.stdout or "[]"):
                claimed |= numbers_in([f.get("path", "") for f in pr.get("files") or []], within=d)
    except FileNotFoundError:
        degraded = "gh is not installed"
    except Exception as exc:
        degraded = str(exc)

    nxt = (max(claimed) + 1) if claimed else 1
    sys.stdout.write("%d\n" % nxt)
    if degraded:
        sys.stderr.write(
            "! open pull requests were NOT consulted (%s).\n"
            "  This number is one past the highest LANDED record. Someone may already\n"
            "  hold it on an open branch. Check by hand, or publish yours immediately.\n" % degraded
        )
    sys.stderr.write(
        "\nPublish this number NOW, before you write the record: push the branch as a\n"
        "draft pull request whose title names it. The number is contested from the\n"
        "moment you take it, and this tool can only see what has been published.\n"
    )
    return 0


def cmd_check(d, root, base):
    try:
        merge_base = git(["merge-base", base, "HEAD"], cwd=root).strip()
    except RuntimeError as exc:
        sys.stderr.write("cannot resolve a merge base against '%s': %s\n" % (base, exc))
        return 2

    # -M so a RENAME is reported as a rename. Without it git reports an unrelated
    # delete plus add, the added side has no `before` to compare against, and renaming
    # a record while rewriting its Decision is never judged at all. One `git mv` took
    # this whole rule off until a real-git test pinned it.
    raw = git(["diff", "-M", "--name-status", "%s...HEAD" % merge_base, "--", d], cwd=root)

    errors = []
    for line in raw.split("\n"):
        if not line.strip():
            continue
        parts = line.split("\t")
        status = parts[0]
        if status.startswith("R") and len(parts) >= 3:
            before_path, after_path = parts[1], parts[2]
        elif status.startswith("M") and len(parts) >= 2:
            before_path = after_path = parts[1]
        else:
            continue  # a true add has no before side; a delete has no after

        try:
            before_text = git(["show", "%s:%s" % (merge_base, before_path)], cwd=root)
        except RuntimeError:
            continue
        try:
            with open(os.path.join(root, after_path)) as fh:
                after_text = fh.read()
        except OSError:
            continue

        # Only records ALREADY accepted before this branch are frozen. A record that
        # becomes accepted in this very change is being authored, not amended.
        if not ACCEPTED.search(before_text):
            continue

        before_d, after_d = decision_section(before_text), decision_section(after_text)
        if before_d is None or after_d is None or before_d == after_d:
            continue
        if is_append_only_amendment(before_d, after_d):
            continue
        errors.append(after_path)

    if errors:
        for p in errors:
            sys.stderr.write("x %s -- `## Decision` rewritten on an accepted record.\n" % p)
        sys.stderr.write(
            "\nAn accepted Decision is a historical record of what was chosen and why.\n"
            "Two sanctioned moves, and no third:\n"
            "  - ANNOTATING what happened next -> a dated note in Consequences, or a\n"
            "    dated `_(Amended YYYY-MM-DD: ...)_` marker inside Decision. Append only.\n"
            "  - REVERSING the decision -> write a NEW record that supersedes this one.\n"
            "Every other section stays editable; only Decision is frozen.\n"
        )
        return 1

    sys.stdout.write("ok decision records: no accepted Decision was rewritten\n")
    return 0


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags, rest = {}, argv[1:]
    for i, a in enumerate(rest):
        if a in ("--dir", "--base", "--root") and i + 1 < len(rest):
            flags[a[2:]] = rest[i + 1]
            if rest[i + 1] in args:
                args.remove(rest[i + 1])

    root = flags.get("root", ".")
    d = flags.get("dir", "decisions")
    if not args:
        sys.stderr.write("usage: adr.py next|check [--dir DIR] [--base REF] [--root DIR]\n")
        return 2
    if args[0] == "next":
        return cmd_next(os.path.join(root, d) if root != "." else d, root)
    if args[0] == "check":
        return cmd_check(d, root, flags.get("base", "origin/main"))
    sys.stderr.write("unknown command: %s\n" % args[0])
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
