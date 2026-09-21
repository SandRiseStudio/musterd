#!/usr/bin/env python3
"""Drift-check a documented file tree against the real one.

A doc block lists the files in a directory, each with a hand-written
description. This checks that the SET of files matches reality -- no file
missing, none stale -- and refuses to write the descriptions for you.

    ./tree-check.py <doc-or-dir>... [--root DIR] [--ignore SUFFIX]...

Exit 0 clean, 1 on drift, 2 when something cannot be read or judged.
Python 3.8+, stdlib only.

THERE IS DELIBERATELY NO --fix. Each line carries a curated description that
belongs next to the prose around it, and a generator would write a blank one.
So this enforces the STRUCTURE, which is mechanical, and refuses to produce the
PROSE, which is load-bearing: a new file fails until a human says what it is.

That is the whole design rule. Where a fact is mechanical, check it. Where it
is judgement, refuse to fake it and fail until someone supplies it. A generator
in that second position produces text that looks documented and says nothing,
which is worse than an empty section because it stops anyone looking.

A block format:

    ## File tree `src/`

    ```
    index.ts      — the entry point; wires the server and exits non-zero on a bad config
    store.ts      — every read and write of the database goes through here
    ```
"""

import os
import re
import sys

HEADING = re.compile(r"^#{1,6}\s+File tree\s+`([^`]+)`\s*$")
FENCE = re.compile(r"^\s*(`{3,})")
# `name.ts  — description` / `name.ts: description` / `name.ts # description`
ENTRY = re.compile(r"^\s*([A-Za-z0-9_./-]+)\s*(?:[—–\-:#]\s*(.*))?$")

DEFAULT_IGNORES = (".test.ts", ".test.js", ".spec.ts", ".snap")


def unbalanced_fences(text):
    """None when fences pair up, else the odd count.

    An unbalanced set means this checker CANNOT tell code from prose in the file,
    and the honest answer is to say so rather than report a pass. Found the hard
    way elsewhere: one stray fence on line 1 made a sibling gate swallow the whole
    document, and every planted mutation in it reported GREEN. A gate that
    silently skips the most important surface it has is worse than no gate,
    because it is trusted.
    """
    n = sum(1 for l in text.split("\n") if FENCE.match(l))
    return None if n % 2 == 0 else n


def fence_depth(lines):
    """Per line: True when it sits INSIDE a fenced block.

    MENTIONS ARE NOT USES. A `## File tree` heading inside a fenced EXAMPLE is a
    mention -- documentation of this format, not an instance of it. Reading it as
    real made this script refuse its own SKILL.md, which is the trap that skill
    warns about, committed inside the file that warns about it.

    Fences nest by length: a ```` block may contain ``` blocks, so a fence closes
    only on one at least as long as the one that opened it.
    """
    inside, open_len, out = False, 0, []
    for l in lines:
        m = FENCE.match(l)
        if m and not inside:
            inside, open_len = True, len(m.group(1))
            out.append(True)
        elif m and inside and len(m.group(1)) >= open_len:
            inside, open_len = False, 0
            out.append(True)
        else:
            out.append(inside)
    return out


def blocks(text):
    """Yield (declared_path, [(filename, description), ...]) per File tree block."""
    lines = text.split("\n")
    masked = fence_depth(lines)
    out = []
    for start, line in enumerate(lines):
        if masked[start]:
            continue
        m = HEADING.match(line)
        if not m:
            continue
        i = start
        while i < len(lines) and not FENCE.match(lines[i]):
            if lines[i].strip() and not lines[i].startswith(("#", ">")):
                break
            i += 1
        if i >= len(lines) or not FENCE.match(lines[i]):
            continue
        entries, i = [], i + 1
        while i < len(lines) and not FENCE.match(lines[i]):
            raw = lines[i]
            if raw.strip():
                e = ENTRY.match(raw)
                if e:
                    entries.append((e.group(1), (e.group(2) or "").strip()))
            i += 1
        out.append((m.group(1), entries))
    return out


def real_files(root, rel, ignores):
    base = os.path.join(root, rel)
    if not os.path.isdir(base):
        return None
    found = set()
    for dirpath, _dirnames, filenames in os.walk(base):
        for f in filenames:
            p = os.path.relpath(os.path.join(dirpath, f), base).replace(os.sep, "/")
            if any(p.endswith(s) for s in ignores) or p.startswith("."):
                continue
            found.add(p)
    return found


def check_doc(path, root, ignores):
    errors, checked = [], 0
    try:
        with open(path) as fh:
            text = fh.read()
    except OSError as exc:
        return ["%s -- cannot read: %s" % (path, exc)], 0, True

    odd = unbalanced_fences(text)
    if odd is not None:
        return ([
            "%s -- %d code fences, an odd number. This checker cannot tell code from prose "
            "here, so it is ABSTAINING rather than reporting a pass." % (path, odd)
        ], 0, True)

    for declared, entries in blocks(text):
        checked += 1
        shown = declared.rstrip("/")
        found = real_files(root, declared, ignores)
        if found is None:
            errors.append("%s -- documents `%s`, which is not a directory. A tree for a path "
                          "that does not exist is the stalest kind." % (path, declared))
            continue

        listed = {name for name, _ in entries}
        for name, desc in entries:
            if not desc:
                errors.append("%s -- `%s` is listed with no description. The set is mechanical; "
                              "the description is not, and nothing will write it for you."
                              % (path, name))
        for missing in sorted(found - listed):
            errors.append("%s -- `%s/%s` exists and is not documented. Add a line that says what "
                          "it is." % (path, shown, missing))
        for stale in sorted(listed - found):
            errors.append("%s -- `%s/%s` is documented and does not exist. Remove the line, or "
                          "restore the file." % (path, shown, stale))
    return errors, checked, False


def walk_targets(targets):
    out = []
    for t in targets:
        if os.path.isfile(t):
            out.append(t)
        elif os.path.isdir(t):
            for dirpath, _d, files in os.walk(t):
                for f in sorted(files):
                    if f.endswith(".md"):
                        out.append(os.path.join(dirpath, f))
    return sorted(set(out))


def main(argv):
    args, flags, rest = [], {"ignore": []}, argv[1:]
    skip = set()
    for i, a in enumerate(rest):
        if i in skip:
            continue
        if a == "--root" and i + 1 < len(rest):
            flags["root"] = rest[i + 1]; skip.add(i + 1)
        elif a == "--ignore" and i + 1 < len(rest):
            flags["ignore"].append(rest[i + 1]); skip.add(i + 1)
        elif not a.startswith("--"):
            args.append(a)

    if not args:
        sys.stderr.write("usage: tree-check.py <doc-or-dir>... [--root DIR] [--ignore SUFFIX]\n")
        return 2
    root = flags.get("root", ".")
    ignores = tuple(flags["ignore"]) or DEFAULT_IGNORES

    docs = walk_targets(args)
    if not docs:
        sys.stderr.write("no markdown files under: %s\n" % ", ".join(args))
        return 2

    all_errors, total, abstained = [], 0, False
    for d in docs:
        errs, n, abst = check_doc(d, root, ignores)
        all_errors += errs
        total += n
        abstained = abstained or abst

    if all_errors:
        for e in all_errors:
            sys.stderr.write("x %s\n" % e)
        if abstained:
            sys.stderr.write("\nAt least one file was not judged. That is an ABSTENTION, not a "
                             "pass and not a finding.\n")
        sys.stderr.write("\nThere is no --fix, on purpose: a generated description reads as "
                         "documentation\nand says nothing, which stops the next reader looking.\n")
        return 2 if abstained and len(all_errors) == 1 else 1

    if total == 0:
        sys.stdout.write("no File tree blocks found in %d file(s) -- nothing was checked.\n"
                         "That is not a pass. Point this at the docs that carry one.\n" % len(docs))
        return 2
    sys.stdout.write("ok file trees: %d block(s) across %d file(s) match the real tree\n"
                     % (total, len(docs)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
