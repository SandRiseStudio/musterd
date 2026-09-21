#!/usr/bin/env python3
"""Export a dataset for publication -- allowlist only, prose omitted, fails closed.

Storing a teammate's prose so their teammates can read it is the product.
PUBLISHING it is a separate act, and it needs its own permission.

    ./export.py <rows.jsonl> --allow FIELD... --release NAME --authorized-by WHO
                [--pseudonymise FIELD]... [--consent FILE] [--include-prose FIELD]...

Exit 0 on a clean export, 1 when the export is refused, 2 when the input cannot
be read. Python 3.8+, stdlib only.

THERE IS NO SCRUBBER, AND THAT IS THE DESIGN. This tool will not detect personal
data in free prose and remove it. Regex stripping over natural language gives a
false sense of safety: it finds the shapes you thought of, reports success, and
the reader believes the text is clean. Omission is both safer and cheaper than
detection -- so prose is excluded by default and included only against a
recorded, per-author consent.

FAILS CLOSED. An unreadable or absent consent record EXCLUDES the body. Absence
of consent is never consent.

TWO CLASSES, AND ONLY ONE IS A JUDGEMENT CALL:
  - structural fields (names, ids, types, timestamps, costs, latencies) carry no
    prose, are the coordination signal, and publish as-is -- with identifiers
    pseudonymised per release: stable inside one release, unlinkable across them.
  - prose bodies are not published by default.
"""

import hashlib
import json
import os
import sys

# Fields whose NAME advertises free prose. Allowlisting one without --include-prose
# is refused: the allowlist is for structural fields, and a prose field slipping
# through it is the single mistake this tool exists to prevent.
PROSE_HINTS = ("body", "text", "prose", "message", "content", "note", "comment",
               "summary", "detail", "description", "reason", "charter", "memory")


def looks_like_prose(field):
    f = field.lower()
    return any(h in f for h in PROSE_HINTS)


def pseudonym(value, release):
    """Stable inside one release, unlinkable across releases."""
    h = hashlib.sha256(("%s\x00%s" % (release, value)).encode()).hexdigest()
    return "anon-%s" % h[:12]


def main(argv):
    multi = {"allow": [], "pseudonymise": [], "include-prose": []}
    flags, rest, skip, args = {}, argv[1:], set(), []
    for i, a in enumerate(rest):
        if i in skip:
            continue
        if a in ("--allow", "--pseudonymise", "--include-prose") and i + 1 < len(rest):
            multi[a[2:]].append(rest[i + 1]); skip.add(i + 1)
        elif a in ("--release", "--authorized-by", "--consent", "--out") and i + 1 < len(rest):
            flags[a[2:]] = rest[i + 1]; skip.add(i + 1)
        elif not a.startswith("--"):
            args.append(a)

    if not args:
        sys.stderr.write("usage: export.py <rows.jsonl> --allow FIELD... --release NAME "
                         "--authorized-by WHO\n")
        return 2
    path = args[0]
    allow = multi["allow"]
    pseudo = set(multi["pseudonymise"])
    include_prose = set(multi["include-prose"])

    refusals = []
    if not allow:
        refusals.append("no `--allow` fields. An export with no allowlist would be a copy, and a "
                        "copy is emission, not publication.")
    if not flags.get("release"):
        refusals.append("no `--release`. Pseudonyms are stable INSIDE one release and unlinkable "
                        "across releases, so the release name is part of the mapping.")
    # A person, per release -- not a policy flag.
    if not flags.get("authorized-by"):
        refusals.append("no `--authorized-by`. A human authorises a specific release. Not a "
                        "config value, not a standing policy: a person, named, per release.")

    slipped = [f for f in allow if looks_like_prose(f) and f not in include_prose]
    if slipped:
        refusals.append(
            "allowlisted prose field(s): %s. The allowlist is for STRUCTURAL fields. If you mean "
            "to publish prose, say so with `--include-prose`, which requires a consent record -- "
            "and read the part of this tool that explains why there is no scrubber."
            % ", ".join(slipped))

    consent = None
    if include_prose:
        cpath = flags.get("consent")
        if not cpath:
            refusals.append("`--include-prose` without `--consent`. Prose publishes only against "
                            "a recorded, per-author consent. Absence of consent is never consent.")
        else:
            try:
                with open(cpath) as fh:
                    consent = json.load(fh)
                if not isinstance(consent, dict):
                    raise ValueError("consent file must be an object keyed by author")
            except (OSError, ValueError) as exc:
                # FAIL CLOSED: an unreadable consent record excludes the body.
                refusals.append("consent record at %s is unreadable (%s). Failing CLOSED: an "
                                "unreadable consent record excludes the body, it does not default "
                                "to allowed." % (cpath, exc))

    if refusals:
        for r in refusals:
            sys.stderr.write("x %s\n" % r)
        return 1

    try:
        with open(path) as fh:
            raw = fh.read()
    except OSError as exc:
        sys.stderr.write("cannot read %s: %s\n" % (path, exc))
        return 2

    rows, bad = [], None
    for n, line in enumerate(raw.split("\n"), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except ValueError as exc:
            bad = "line %d: %s" % (n, exc); break
    if bad:
        sys.stderr.write("cannot parse %s -- %s\nRefusing to publish a partial read.\n" % (path, bad))
        return 2

    release = flags["release"]
    out, dropped, prose_in, prose_out = [], {}, 0, 0
    for r in rows:
        if not isinstance(r, dict):
            continue
        rec = {}
        for f in allow:
            if f not in r:
                continue
            if f in include_prose:
                author = str(r.get("author", r.get("from", "")))
                if consent is not None and consent.get(author) is True:
                    rec[f] = r[f]; prose_in += 1
                else:
                    prose_out += 1
                continue
            rec[f] = pseudonym(str(r[f]), release) if f in pseudo else r[f]
        for f in r:
            if f not in allow:
                dropped[f] = dropped.get(f, 0) + 1
        out.append(rec)

    dest = flags.get("out")
    text = "".join(json.dumps(o, sort_keys=True) + "\n" for o in out)
    if dest:
        with open(dest, "w") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)

    sys.stderr.write(
        "\nrelease %s, authorised by %s\n  %d row(s) exported, %d field(s) allowed, "
        "%d pseudonymised\n" % (release, flags["authorized-by"], len(out), len(allow), len(pseudo)))
    if dropped:
        # Say what was dropped. A reader who cannot see the omission treats the
        # remainder as the whole.
        sys.stderr.write("  dropped (not allowlisted): %s\n"
                         % ", ".join("%s x%d" % (k, v) for k, v in sorted(dropped.items())))
    if include_prose:
        sys.stderr.write("  prose: %d included on recorded consent, %d withheld\n" % (prose_in, prose_out))
    else:
        sys.stderr.write("  prose: none requested, so none published\n")
    sys.stderr.write("  NOTE: nothing here was scrubbed. Fields were omitted, not cleaned.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
