#!/usr/bin/env python3
"""Screen a coordination log for the failure shapes a multi-agent team grows.

    ./audit.py <acts.jsonl> [--reply-field REPLY_TO] [--to-field TO]
               [--type-field ACT] [--from-field FROM] [--broadcast VALUE]...

Exit 0 when nothing screens positive, 1 when something does, 2 when the input
cannot be read. Python 3.8+, stdlib only.

THESE ARE SCREENS, NOT VERDICTS. Every number below can be high for an innocent
reason, and the tool says which one beside each. It is a way of deciding where
to READ, not a score. On a raw transcript with no structure at all this is a
human read and nothing else -- see SKILL.md.

WHAT IT LOOKS FOR, all of them shapes a real audit of our own logs found:

  - broadcast share -- announcements to everyone instead of directed exchange
  - closed-loop share -- requests that were answered, versus requests that
    merely happened
  - open loops -- a request for help with nothing referencing it afterwards
  - one-sided threads -- a thread where one participant wrote everything
  - silent participants -- present in the log, addressed, never replying
"""

import json
import sys
from collections import Counter, defaultdict

REQUEST_ACTS = ("request_help", "ask", "challenge", "handoff", "steer")
CLOSING_ACTS = ("accept", "decline", "resolve", "reply", "answer")


def load(path):
    with open(path) as fh:
        raw = fh.read()
    if raw.strip().startswith("["):
        return json.loads(raw), None
    rows = []
    for n, line in enumerate(raw.split("\n"), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except ValueError as exc:
            return None, "line %d: %s" % (n, exc)
    return rows, None


def pct(a, b):
    return 0.0 if not b else 100.0 * a / b


def main(argv):
    args, flags, bcast, rest, skip = [], {}, [], argv[1:], set()
    for i, a in enumerate(rest):
        if i in skip:
            continue
        if a == "--broadcast" and i + 1 < len(rest):
            bcast.append(rest[i + 1].lower()); skip.add(i + 1)
        elif a in ("--reply-field", "--to-field", "--type-field", "--from-field") and i + 1 < len(rest):
            flags[a[2:]] = rest[i + 1]; skip.add(i + 1)
        elif not a.startswith("--"):
            args.append(a)
    if not args:
        sys.stderr.write("usage: audit.py <acts.jsonl> [--to-field TO] [--broadcast VALUE]...\n")
        return 2

    F_TO = flags.get("to-field", "to")
    F_TYPE = flags.get("type-field", "act")
    F_FROM = flags.get("from-field", "from")
    F_REPLY = flags.get("reply-field", "reply_to")
    broadcast_values = set(bcast) | {"@team", "@broadcast", "all", "team", "*", ""}

    try:
        rows, err = load(args[0])
    except (OSError, ValueError) as exc:
        sys.stderr.write("cannot read %s: %s\n" % (args[0], exc))
        return 2
    if err:
        sys.stderr.write("cannot parse %s -- %s\nRefusing to screen a partial read.\n" % (args[0], err))
        return 2
    rows = [r for r in rows if isinstance(r, dict)]
    if not rows:
        sys.stderr.write("%s has no usable rows. Nothing was screened, which is not a pass.\n" % args[0])
        return 2

    total = len(rows)
    types = Counter(str(r.get(F_TYPE, "?")) for r in rows)
    directed = sum(1 for r in rows if str(r.get(F_TO, "")).lower() not in broadcast_values)
    replied_to = {str(r[F_REPLY]) for r in rows if r.get(F_REPLY)}
    requests = [r for r in rows if str(r.get(F_TYPE, "")) in REQUEST_ACTS]
    open_loops = [r for r in requests if str(r.get("id", "")) not in replied_to]
    closing = sum(types.get(a, 0) for a in CLOSING_ACTS)

    threads = defaultdict(list)
    for r in rows:
        key = r.get("thread") or r.get(F_REPLY)
        if key:
            threads[str(key)].append(str(r.get(F_FROM, "?")))
    one_sided = [t for t, who in threads.items() if len(who) > 1 and len(set(who)) == 1]

    senders = {str(r.get(F_FROM, "?")) for r in rows}
    addressed = {str(r.get(F_TO, "")) for r in rows if str(r.get(F_TO, "")).lower() not in broadcast_values}
    silent = sorted(a for a in addressed if a and a not in senders)

    sys.stdout.write("%d act(s)\n\n" % total)
    for t, n in types.most_common():
        sys.stdout.write("  %-16s %4d  %5.1f%%\n" % (t, n, pct(n, total)))
    sys.stdout.write("\n  directed       %4d  %5.1f%%   (broadcast %.1f%%)\n"
                     % (directed, pct(directed, total), 100 - pct(directed, total)))
    sys.stdout.write("  closing acts   %4d  %5.1f%%\n" % (closing, pct(closing, total)))
    sys.stdout.write("  requests       %4d   of which %d unanswered\n" % (len(requests), len(open_loops)))
    sys.stdout.write("  one-sided threads %d\n" % len(one_sided))
    sys.stdout.write("  addressed but never sent: %s\n\n" % (", ".join(silent) if silent else "none"))
    sys.stdout.flush()

    # Each screen carries the innocent reading beside it. A screen that only
    # reports the guilty reading is an accusation with a percentage on it.
    findings = []
    if pct(directed, total) < 40:
        findings.append("broadcast-heavy: %.0f%% of acts went to everyone. INNOCENT READING: a "
                        "team that genuinely works in the open, or one person narrating a solo "
                        "run. WORTH READING IF: nobody answers the announcements."
                        % (100 - pct(directed, total)))
    if requests and pct(closing, total) < 5:
        findings.append("few closing acts (%.0f%%): things are asked and not visibly answered. "
                        "INNOCENT READING: answers happen out of band -- in a call, in person. "
                        "WORTH READING IF: the log is meant to be the record." % pct(closing, total))
    if open_loops:
        findings.append("%d request(s) with nothing referencing them: %s. INNOCENT READING: "
                        "answered by doing rather than by replying. WORTH READING IF: the asker "
                        "was blocked."
                        % (len(open_loops), ", ".join(str(r.get("id", "?")) for r in open_loops[:5])))
    if one_sided:
        findings.append("%d thread(s) where one participant wrote every message. INNOCENT "
                        "READING: a journal kept deliberately. WORTH READING IF: it was addressed "
                        "to someone." % len(one_sided))
    if silent:
        findings.append("addressed but never sent anything: %s. INNOCENT READING: not "
                        "participating in this window. WORTH READING IF: they were asked "
                        "something." % ", ".join(silent))

    if findings:
        for f in findings:
            sys.stderr.write("! %s\n\n" % f)
        sys.stderr.write("These are SCREENS. Each names where to read, not what is true.\n")
        return 1
    sys.stdout.write("ok nothing screened positive over this window.\n"
                     "   That is not 'the team is healthy' -- it is 'these five shapes did not\n"
                     "   appear in these %d acts'. The window is yours to justify.\n" % total)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
