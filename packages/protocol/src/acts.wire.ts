/**
 * The act/surface/presence vocabularies as plain TypeScript — no zod.
 *
 * These tuples ARE the wire contract's closed sets; `acts.ts` builds the zod enums from them and
 * re-exports every name here, so there is exactly one list per vocabulary and nothing to drift.
 * They live in a validator-free module so a consumer that only needs to *read* the vocabulary (the
 * browser, above all — see `guards.ts`) can import it without pulling zod into its bundle.
 */

/**
 * The collaboration acts (Co-Gym-grounded). Order is stable; new acts append.
 * `resolve` (musterd/0.3, ADR 025) is the terminal act — it closes a thread (the proto-work-item),
 * supplying the open-vs-done axis the prior seven lacked (`accept` ≠ finished).
 *
 * The steering trio (musterd/0.3, ADR 103 — increment 2 of the interrupt line, ADR 088) gives a
 * "change of direction" first-class semantics on the existing interrupt line: `steer` (a directive —
 * always interrupt-class, and the newest steer supersedes prior direction per ADR 017), `challenge`
 * (epistemic — "justify this or reconsider", warn-never-block, interrupts only when flagged urgent),
 * and `defer` (plan mutation on the Goal spine — names `meta.goal_id`, optional `meta.wave` target).
 *
 * `ask` (musterd/0.3, ADR 147 — item 2 of the human-role re-founding, ADR 145 §3.1) is the to-human
 * stream act: directed-to-human traffic in three species (`meta.species`: consult/escalate/approve),
 * each carrying a tier (`meta.tier`) that derives a timeout + no-answer policy the *agent* runs (top
 * tier holds; below-top proceeds with a recorded risk-acceptance). The no-answer resolution rides
 * `status_update` (`meta.ask_outcome`) and the human "deciding — check back" reply rides `wait`
 * (`meta.until`), so `ask` is the only new verb — "surfaces before more acts" (ADR 145 §4).
 *
 * `insight` (ADR 327) is the team-memory act: a reusable finding saved so the whole team can find
 * it. Required `meta.headline` (≤120 chars); optional `meta.tags` / `meta.repo`; the text rides the
 * envelope body (server-enforced ≤2048 bytes). Team-visible by intent — there is no private variant,
 * so ADR 093's seat-memory privacy line stays untouched. Retrieved through a derived FTS index over
 * the log (a declared cache, rebuildable — never a source of truth); durable findings promote into
 * `docs/wiki/` per ADR 259.
 */
export const ACTS = [
  'message',
  'status_update',
  'request_help',
  'handoff',
  'accept',
  'decline',
  'wait',
  'resolve',
  'steer',
  'challenge',
  'defer',
  'ask',
  'insight',
] as const;
export type Act = (typeof ACTS)[number];

/** Surfaces a Member can be present on. v0.1 implements cli/claude-code/codex; the rest are
 *  reserved. `musterd` (ADR 131 §7) is the native harness — the agent loop hosted in `musterd host`.
 *  `opencode` (ADR 321) and `grok` (ADR 352) are first-class CLI harnesses — enumeration, wake, and
 *  provisioning all speak their names. */
export const SURFACES = [
  'cli',
  'claude-code',
  'codex',
  'opencode',
  'grok',
  'cursor',
  'web',
  'ios',
  'slack',
  'other',
  'musterd',
] as const;
export type Surface = (typeof SURFACES)[number];

/** Member lifecycle. `until` requires a timestamp. */
export const LIFECYCLES = ['forever', 'session', 'until'] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

/** Member kind. Humans are first-class members, not approvers. `service` is a *ledger seat*
 *  (ADR 232): an unattended actor — a cron, a LaunchAgent — with identity, roles, attribution and
 *  audit, but structurally excluded from the peer verbs: it never holds lanes, never accepts,
 *  never wakes, and is never an admin. An accountable actor, never a negotiator. */
export const MEMBER_KINDS = ['agent', 'human', 'service'] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];

/** Presence status. `away` is only ever set explicitly by a client. */
export const PRESENCE_STATUSES = ['online', 'away', 'offline'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

/**
 * Roster activity (musterd/0.2, renamed ADR 140). A coarser, demo-facing read of a member than raw
 * presence: `offline` (no live attachment), `active` (present, no self-reported task), `working`
 * (present + a self-reported task). Resolved server-side from presence + the latest `status_update`
 * (two-clocks rule).
 *
 * `active` was renamed from `idle` (presence-honesty §2.1): connected, between claims. A legacy
 * `idle` from an old daemon is accepted on read and normalized — {@link normalizeActivity} is that
 * normalization, and the zod schema in `acts.ts` transforms through the same function so the two
 * readers cannot disagree.
 */
export const ACTIVITIES = ['offline', 'active', 'working'] as const;
export type Activity = (typeof ACTIVITIES)[number];

/** The wire-accepted activity spellings, including the legacy `idle`. */
export const ACTIVITIES_ON_WIRE = [...ACTIVITIES, 'idle'] as const;

/** Normalize an accepted wire spelling to its canonical {@link Activity}. */
export function normalizeActivity(a: (typeof ACTIVITIES_ON_WIRE)[number]): Activity {
  return a === 'idle' ? 'active' : a;
}

/**
 * Provenance (musterd/0.2): *why* a presence exists, captured as a fact at attach time — never
 * guessed (human-agent-dynamics §2). `session` = a human opened a harness session; `asked` = a
 * member was asked to do something; `hook` = a harness hook/function fired; `scheduled` = a timer
 * started it; `daemon` = an always-on process. It dissolves the driving-posture confusion without
 * modelling humans: `(session)` says "someone is behind this", `(scheduled)` says "nobody need be".
 * `wake` (ADR 131 §6) = musterd resurrected this session because a directed act was waiting —
 * machine-initiated, roster/stream/office-distinguishable, and the ping-pong bound's join key:
 * acts sent from a `wake` occupancy only qualify for other seats' *batched* wake lane.
 */
export const PROVENANCES = ['session', 'asked', 'hook', 'scheduled', 'daemon', 'wake'] as const;
export type Provenance = (typeof PROVENANCES)[number];
