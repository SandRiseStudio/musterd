#!/usr/bin/env python3
"""Is this workspace's git identity actually its own?

One workspace per agent, each committing under its own name. This checks that
the identity is scoped to THIS work tree rather than shared with every sibling.

    ./identity.py check [--root DIR] [--expect-name N] [--expect-email E]

Exit 0 when the identity is this work tree's own, 1 when it is shared or
missing, 2 when git cannot answer. Python 3.8+, stdlib only.

THE TRAP THIS EXISTS FOR. Repo-local git config is SHARED across every work
tree of one repository. So `git config user.name X` in one workspace silently
renames every other workspace's commits -- and the other workspaces never
touched anything, so nothing there looks wrong.

WHAT IS AND IS NOT SILENT, measured rather than assumed (git 2.51):

  - `git config --worktree ...` REFUSES loudly when `extensions.worktreeConfig`
    is off: "fatal: --worktree cannot be used with multiple working trees
    unless the config extension worktreeConfig is enabled."
  - The silent damage comes from the FALLBACK. A provisioning script that runs
    `git config --worktree ... || git config ...` turns that loud refusal into
    a shared write, and now the last workspace provisioned owns everyone's
    commits.

So the dangerous line is not the one that fails. It is the `||` after it.
"""

import os
import subprocess
import sys


def git(args, root, ok=(0,)):
    r = subprocess.run(["git", "-C", root] + args, capture_output=True, text=True)
    return (r.stdout.strip() if r.returncode in ok else None), r.returncode


def scope_of(key, root):
    """Which config file supplies this key: worktree, local, global, or None."""
    for scope in ("worktree", "local", "global", "system"):
        v, rc = git(["config", "--%s" % scope, "--get", key], root)
        if rc == 0 and v:
            return scope, v
    return None, None


def main(argv):
    args, flags, rest = [], {}, argv[1:]
    skip = set()
    for i, a in enumerate(rest):
        if i in skip:
            continue
        if a in ("--root", "--expect-name", "--expect-email") and i + 1 < len(rest):
            flags[a[2:]] = rest[i + 1]; skip.add(i + 1)
        elif not a.startswith("--"):
            args.append(a)
    root = flags.get("root", ".")

    toplevel, rc = git(["rev-parse", "--show-toplevel"], root)
    if rc != 0 or not toplevel:
        sys.stderr.write("not a git work tree: %s\n" % root)
        return 2
    common, _ = git(["rev-parse", "--git-common-dir"], root)
    gitdir, _ = git(["rev-parse", "--git-dir"], root)
    is_linked = bool(common and gitdir and os.path.abspath(
        os.path.join(root, common)) != os.path.abspath(os.path.join(root, gitdir)))

    ext, _ = git(["config", "--get", "extensions.worktreeConfig"], root)
    ext_on = (ext or "").lower() == "true"

    name_scope, name = scope_of("user.name", root)
    email_scope, email = scope_of("user.email", root)

    sys.stdout.write("work tree   %s\n" % toplevel)
    sys.stdout.write("linked      %s\n" % ("yes" if is_linked else "no (this is the main work tree)"))
    sys.stdout.write("extension   extensions.worktreeConfig = %s\n" % (ext or "unset"))
    sys.stdout.write("user.name   %s  [%s]\n" % (name or "UNSET", name_scope or "nowhere"))
    sys.stdout.write("user.email  %s  [%s]\n\n" % (email or "UNSET", email_scope or "nowhere"))

    errors = []
    if not name or not email:
        errors.append("no git identity here at all. Commits will be attributed to whatever "
                      "global config happens to say, which is one name for every agent.")

    shared = [s for s in (name_scope, email_scope) if s in ("local", "global", "system")]
    if shared and is_linked:
        errors.append(
            "the identity comes from %s config, which is SHARED with every sibling work tree. "
            "Whoever writes it last owns everyone's commits, and the others never touched "
            "anything -- so nothing looks wrong on their side. Set it with `git config "
            "--worktree` instead." % "/".join(sorted(set(shared))))
    if is_linked and not ext_on:
        errors.append(
            "`extensions.worktreeConfig` is not enabled, so `git config --worktree` will REFUSE "
            "here. That refusal is the safe outcome -- the danger is a provisioning script that "
            "falls back to a shared write when it sees the error. Enable it at the repo: "
            "`git config extensions.worktreeConfig true`.")

    for key, want, got in (("user.name", flags.get("expect-name"), name),
                           ("user.email", flags.get("expect-email"), email)):
        if want and got != want:
            errors.append("`%s` is %r, expected %r." % (key, got, want))

    if errors:
        for e in errors:
            sys.stderr.write("x %s\n" % e)
        return 1

    if not is_linked:
        sys.stdout.write("ok identity present. NOTE: this is the main work tree, so a shared "
                         "write here is\n   indistinguishable from a scoped one -- this check "
                         "cannot tell them apart.\n   Run it in a linked work tree to get a real "
                         "answer.\n")
        return 0
    sys.stdout.write("ok identity is this work tree's own (worktree-scoped)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
