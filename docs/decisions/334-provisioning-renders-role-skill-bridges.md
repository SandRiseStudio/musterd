# 334 — Provisioning renders role-skill bridges; a seat loads the role the roster says it holds

- **Status:** proposed
- **Date:** 2026-08-28
- **Owner:** big-body (security seat), with nick in session
- **Relates to:** ADR 299 (committed skill home — this decides the auto-distribution it deferred),
  ADR 272 (roles route work, toolkits configure workspaces — the boundary this keeps),
  ADR 085 (the generated guidance pipeline these bridges ride), ADR 227 (roles as the durable
  aptitude layer), ADR 058 (the file-backed roster this reads), ADR 171 (established-vs-configured:
  why the doctor and the repair must agree by construction)

## Context

ADR 299 gave committed skills a home at `.agents/skills/<name>/` and settled that a seat which
should load one gets a **thin bridge** in its own workspace rather than a copy of the body. It then
named what it was not deciding:

> Not decided here: any registry/marketplace of skills, **auto-distribution of bridges by
> `musterd init`**, or additional `.agents/` residents beyond `skills/`. Each needs its own
> decision when wanted.

So bridges were placed by hand. That worked while exactly one seat had exactly one committed skill
(sloane / `product-communications`, whose three bridges ADR 299 lists as a consequence). It stopped
working the moment a second role skill landed.

**The measurement, 2026-08-28.** The `big-body` seat carries `role = "security"` in the roster
(`.musterd/seats/big-body.toml`), and the repo carries `.agents/skills/security/SKILL.md` (landed
#1062, 2026-08-25). The seat's workspace had **no `.claude/skills/` directory at all** — so no
bridge, and the harness never listed the skill. The session ran the seat's whole opening stretch
without its role: it did not know its findings were private by default, that audit work is separated
from remediation, or that offensive testing needs a fresh authorization. It then took the public
security-posture lane and started planning that work — which the role skill forbids until a baseline
audit is fixed, accepted, or deferred, and which the pre-authorized audit lane's own detail forbids
in the same words. The wrong lane was caught by a human asking whether the seat had its special
capabilities, not by anything in the system.

That is the failure worth naming: **a seat holding a role it cannot load is worse than a seat with
no role at all**, because the roster asserts a duty that nothing on the seat's side enforces. The
roster said `security`; the harness saw a generalist. Every party was individually consistent and
the composition was silently wrong.

Two properties made it invisible. The bridge is gitignored (correctly — ADR 085's line is
*generated guidance is gitignored, reviewed content is committed*), so no diff ever showed it
missing. And `musterd init --check` reports on harness fragments it knows about, so a bridge nothing
declared could not be observed absent. There was no surface on which "this seat is missing its
role skill" could appear.

## Decision

**1. Provisioning renders role-skill bridges.** When a workspace's seat holds a roster role, and the
repo carries `.agents/skills/<role>/SKILL.md`, provisioning writes that role's bridge for every
harness that catalogs a native skill shell. This is the auto-distribution ADR 299 deferred, decided
now because the trigger it was waiting on has fired with a measured cost.

**2. The bridge stays a thin pointer (ADR 299 §2 unchanged).** It carries frontmatter and a sentence
telling the reader to read `.agents/skills/<role>/SKILL.md`. The canonical body is never copied. The
bridge reuses the canonical skill's own `description:` verbatim, so the harness gates the skill on
the same sentence its author wrote — one description, no drift, no second place to edit.

**3. The role is read, never written (ADR 272 §1/§2).** A role is a team fact; a bridge is a
workspace fact. Provisioning *consumes* the role to decide what to render and creates no team fact:
nothing here grants a role, removes one, or routes on one. This is exactly ADR 272's split: what a
session can do here is a workspace fact, rendered by a toolkit and observed as health, never
authority. Resolution runs one direction only, roster → workspace.

**4. Bridges are managed fragments, like every other guidance file.** They are content-stamped, so
they are observed, drift-detected, released on harness deselect, and removed by `uninstall` through
the machinery that already exists. A stampless file at a bridge path is user-authored and is never
clobbered — the same rail that protects a hand-edited guidance file protects a hand-edited bridge.

**5. Every missing link degrades to "no bridge", never to an error.** Unbound folder, db-only team,
seat with no role, role with no committed skill, harness with no native catalog — each renders
nothing and provisioning proceeds. A role is an *optional* attachment (ADR 272 §1); provisioning a
workspace must not fail over an absent one.

**6. Harnesses without a native skill catalog are out of scope here.** Codex and OpenCode declare no
bridge pattern and reach a committed role skill through the AGENTS.md primer, the same way they
reach the orient ritual (ADR 333). Extending the primer to name the seat's role skill is a
separate, smaller decision.

## Consequences

- A newly provisioned seat workspace gets its role skill without anyone remembering to place it.
  The `big-body` case is the regression test: role `security` resolves from the live roster, and
  both the Claude Code and Cursor bridges render pointing at the canonical body.
- Sloane's three hand-placed `product-communications` bridges become machine-written on the next
  refresh. They already match the rendered shape, so this is a takeover, not a rewrite.
- `HarnessGuidance` gains one optional field, `roleSkillPattern` — a path with a `<role>`
  placeholder (`.claude/skills/<role>/SKILL.md`, `.cursor/rules/<role>.mdc`). Declaring it is what
  opts a harness in, mirroring how `orientSkillPath` opts a harness into the orient catalog.
- The CLI now reads the roster during provisioning. That is a new read edge from workspace setup to
  team state; it is wrapped so an unreadable roster renders no bridge rather than failing the run.
- **Not decided here:** a seat holding more than one role (today's roster is one role per seat, and
  the renderer takes a single role); primer-based bridges for Codex/OpenCode; and any registry of
  skills. ADR 299's other deferrals stand.

## Observability & Evaluation

- **Traces:** none added. Bridges are stamped guidance files, so they are already observable through
  the existing fragment machinery: `musterd harness status` reports each managed fragment's state
  and ownership, and a hand-edited bridge shows as drift with evidence retained. The falsifier is
  direct — on a seat with a role and a committed skill, the bridge path is present and stamped after
  provisioning; on a seat with neither, no bridge path exists.
- **Eval:** n/a as an automated agent eval — this is a provisioning path, not a runtime agent
  behavior. Its effect is judged by the unit tests (role resolution degrading to null on every
  broken link; the bridge pointing at the canonical path and *not* containing the canonical body;
  stamping; Codex rendering nothing) plus the live check above.
- **Experiment:** n/a — additive and reversible. The change writes gitignored pointer files and is
  undone by `git revert` plus the existing removal path.

### Falsifiers

- **2026-08-28:** `seatRoleFor` on `/Users/nick/agents-big-body` returns `security`, and
  `roleBridgesFor` renders `.claude/skills/security/SKILL.md` and `.cursor/rules/security.mdc`,
  both stamped, both pointing at `.agents/skills/security/SKILL.md`, neither containing the
  canonical body. Re-run to check.
- **Invalidated if:** the roster ever gains multi-role seats without this renderer being widened —
  a seat would then load one role's skill and silently miss the rest, reproducing the original
  failure one level up.
