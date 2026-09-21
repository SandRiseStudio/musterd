#!/usr/bin/env python3
"""The hook canary -- does what your hook prints actually reach the model?

Two questions that look like one and are not:

  1. Did the hook RUN?             (the harness executed your command)
  2. Did its output REACH THE MODEL? (the text entered the model's context)

Most harnesses answer 1 loudly and 2 not at all, and a hook that runs into a
debug log is indistinguishable from one that works -- from the outside.

    ./canary.py emit  [--event NAME] [--state DIR]    run this FROM the hook
    ./canary.py check [--state DIR] <transcript>...   then run this

`emit` mints a sentinel, records on disk that the hook ran, and prints that
sentinel in every shape a harness might read: bare stdout, and JSON under both
the `hookSpecificOutput.additionalContext` and `additional_context` keys.

`check` looks for the sentinel in the session transcripts you name and reports
WHERE it found it -- because a sentinel sitting under a debug or hook-output key
is the failure this tool exists to catch, not the success.

Exit codes for `check`: 0 reached, 1 ran and did NOT reach, 2 never ran,
3 cannot tell. Python 3.8+, stdlib only.

REFUSES ON POSITIVE EVIDENCE ONLY. Exit 1 -- the only verdict that accuses --
is returned when the sentinel is absent from a readable transcript, or sits
under a key known to be a log. A sentinel under a key this tool does not
recognise is exit 3, "cannot tell", never a failure: an unfamiliar key is a gap
in this tool's vocabulary, not a fact about your harness. Collapsing those two
is the aliasing the parent skill is about.
"""

import json
import os
import sys
import time
import uuid

# Keys whose contents a harness feeds back to the MODEL. A sentinel here is a pass.
REACHING_KEYS = ("additionalcontext", "additional_context", "content", "text", "message", "agent_message")
# Keys that hold a transcript of what the HARNESS did. A sentinel here is the trap:
# the hook ran, its output was recorded, and the model never saw it.
LOGGING_KEYS = ("hookoutput", "hook_output", "stdout", "debug", "toolusereresult", "tool_use_result", "output")


def state_path(state_dir, event):
    return os.path.join(state_dir, "canary-%s.json" % event)


def cmd_emit(event, state_dir):
    sentinel = "MUSTERD-CANARY-%s-%s" % (event, uuid.uuid4().hex[:12])
    try:
        os.makedirs(state_dir, exist_ok=True)
        with open(state_path(state_dir, event), "w") as fh:
            json.dump({"sentinel": sentinel, "event": event, "at": time.time()}, fh)
    except OSError as exc:
        # FAIL OPEN. A canary that breaks a turn is worse than one that cannot measure.
        sys.stderr.write("canary: could not record state: %s\n" % exc)
        return 0

    # Every shape at once, because which one a harness reads is the question.
    sys.stdout.write(sentinel + "\n")
    sys.stdout.write(json.dumps({
        "additional_context": sentinel,
        "hookSpecificOutput": {"hookEventName": event, "additionalContext": sentinel},
    }) + "\n")
    return 0


def walk(node, path, sentinel, hits):
    """Find the sentinel anywhere in a decoded JSON tree, recording its key path."""
    if isinstance(node, dict):
        for k, v in node.items():
            walk(v, path + [str(k)], sentinel, hits)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            walk(v, path + ["[%d]" % i], sentinel, hits)
    elif isinstance(node, str) and sentinel in node:
        hits.append(".".join(path) if path else "(root)")


def classify(keypath):
    """reaching | logging | unknown, from the deepest recognised key in the path."""
    parts = [p.lower() for p in keypath.split(".")]
    for p in reversed(parts):
        if p in REACHING_KEYS:
            return "reaching"
        if p in LOGGING_KEYS:
            return "logging"
    return "unknown"


def scan(path, sentinel):
    """Return a list of (keypath, verdict). Handles JSONL, JSON and plain text."""
    hits = []
    try:
        with open(path, errors="replace") as fh:
            raw = fh.read()
    except OSError:
        return None
    if sentinel not in raw:
        return []

    decoded_any = False
    for line in raw.split("\n"):
        line = line.strip()
        if not line or sentinel not in line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        decoded_any = True
        walk(obj, [], sentinel, hits)
    if not decoded_any:
        try:
            walk(json.loads(raw), [], sentinel, hits)
            decoded_any = True
        except ValueError:
            pass
    if not decoded_any:
        # Plain text: present, but nothing says which channel it is.
        hits.append("(plain text -- no structure to read a channel from)")
    return [(h, classify(h)) for h in hits]


def cmd_check(state_dir, paths):
    events = []
    try:
        names = sorted(os.listdir(state_dir))
    except OSError:
        names = []
    for name in names:
        if name.startswith("canary-") and name.endswith(".json"):
            try:
                with open(os.path.join(state_dir, name)) as fh:
                    events.append(json.load(fh))
            except (OSError, ValueError):
                continue

    if not events:
        sys.stdout.write(
            "NEVER RAN -- no canary state in %s.\n"
            "The hook did not execute at all: wrong file, wrong event name, or the\n"
            "harness never dispatched it. Check that first; reach is a later question.\n" % state_dir
        )
        return 2

    readable = False
    reached = False
    saw_unclassifiable = False
    saw_absent = False
    saw_logging = False
    for ev in events:
        sentinel, event = ev["sentinel"], ev.get("event", "?")
        sys.stdout.write("\nevent %s -- hook RAN (sentinel %s)\n" % (event, sentinel))
        found_any = False
        for p in paths:
            hits = scan(p, sentinel)
            if hits is None:
                sys.stdout.write("  ?  %s -- unreadable\n" % p)
                continue
            readable = True
            for keypath, verdict in hits:
                found_any = True
                mark = {"reaching": "OK ", "logging": "XX ", "unknown": "?? "}[verdict]
                sys.stdout.write("  %s %s\n     at %s  [%s]\n" % (mark, p, keypath, verdict))
                if verdict == "reaching":
                    reached = True
                elif verdict == "logging":
                    saw_logging = True
                else:
                    saw_unclassifiable = True
        if not found_any:
            saw_absent = True
            sys.stdout.write(
                "  XX absent from every transcript named.\n"
                "     The hook ran and its output did not reach the model.\n"
            )

    if not readable:
        sys.stdout.write("\nCANNOT TELL -- no transcript was readable. Not a pass.\n")
        return 3
    if reached:
        sys.stdout.write(
            "\nREACHED -- the sentinel appears under a key the harness feeds to the model.\n"
            "Confirm by reading the surrounding record: a key NAME is evidence, not proof.\n"
        )
        return 0
    if saw_unclassifiable and not (saw_logging or saw_absent):
        sys.stdout.write(
            "\nCANNOT TELL -- the sentinel IS in the transcript, under a key this tool\n"
            "does not recognise. That is a gap in its vocabulary, not a verdict about\n"
            "your harness. Read the surrounding record yourself, then add the key to\n"
            "REACHING_KEYS or LOGGING_KEYS so the next run can answer.\n"
        )
        return 3
    sys.stdout.write(
        "\nDID NOT REACH -- the hook ran and the model never saw it.\n"
        "This is the failure mode a green hook hides. Try the other injection\n"
        "shape, or another event; on some harnesses one event reaches and its\n"
        "neighbour does not.\n"
    )
    return 1


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    flags, rest = {}, argv[1:]
    for i, a in enumerate(rest):
        if a in ("--event", "--state") and i + 1 < len(rest):
            flags[a[2:]] = rest[i + 1]
            if rest[i + 1] in args:
                args.remove(rest[i + 1])

    state_dir = flags.get("state", os.path.join(os.getcwd(), ".hook-canary"))
    if not args:
        sys.stderr.write(__doc__.split("\n\n")[0] + "\n\nusage: canary.py emit|check ...\n")
        return 2
    if args[0] == "emit":
        return cmd_emit(flags.get("event", "hook"), state_dir)
    if args[0] == "check":
        if len(args) < 2:
            sys.stderr.write("check needs at least one transcript path.\n")
            return 3
        return cmd_check(state_dir, args[1:])
    sys.stderr.write("unknown command: %s\n" % args[0])
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
