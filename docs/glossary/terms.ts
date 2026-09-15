/*
 * Machine-readable glossary (ADR 296). brand.md §5 and the vocab:check terminology
 * table are both derived from this file — prose cannot drift silently.
 *
 * status:
 *   canonical     — use this word
 *   legacy-alias  — still accepted on read (tier 2 wire/file keys)
 *   banned        — a Not-column synonym; new gated prose may not use it
 */
export type TermStatus = 'canonical' | 'legacy-alias' | 'banned';

export interface GlossaryTerm {
  /** Lowercase dictionary form. */
  term: string;
  status: TermStatus;
  definition: string;
  /** Banned synonyms and banned second meanings (the Not column). */
  not: string[];
  /** Original SPEC five. */
  core?: boolean;
}

export const GLOSSARY: GlossaryTerm[] = [
  {
    term: 'team',
    status: 'canonical',
    core: true,
    definition:
      'A named, persistent group of Members with shared messaging — a standing roster, not a project. It outlives any task, session, or repository.',
    not: ['room', 'channel', 'swarm', 'project'],
  },
  {
    term: 'member',
    status: 'canonical',
    core: true,
    definition:
      'Anyone on the roster — the canonical noun. kind is agent, human, or service. Carries name, roles[], lifecycle, availability. A Member is not a session.',
    not: ['agent (as the generic noun)', 'seat', 'user', 'participant'],
  },
  {
    term: 'presence',
    status: 'canonical',
    core: true,
    definition:
      'Where a Member is currently attached (a harness session, the CLI, later an app). One Member can have multiple Presences.',
    not: ['session', 'connection', 'status'],
  },
  {
    term: 'surface',
    status: 'canonical',
    core: true,
    definition:
      "Where a Member touches the team: an agent's harness; a human's musterd CLI or web. Glossary meaning only.",
    not: ['client', 'adapter'],
  },
  {
    term: 'act',
    status: 'canonical',
    core: true,
    definition:
      'The typed intent of a message: message, status_update, request_help, handoff, accept, decline, wait, resolve, steer, challenge, defer, ask.',
    not: ['type', 'kind', 'event', 'verb'],
  },
  {
    term: 'agent',
    status: 'canonical',
    definition:
      'The industry hook, and a kind of member (agent · human · service). Marketing copy leads with it. Not the generic noun for team participants.',
    not: [],
  },
  {
    term: 'seat',
    status: 'canonical',
    definition:
      'The durable position a member keeps — exists while they are away; claimed, adopted, handed off, woken. Used only where durability or occupancy is the subject.',
    not: [],
  },
  {
    term: 'role',
    status: 'canonical',
    definition:
      'A responsibility the team grants a member: charter + ceiling. Team-side, reviewed, harness-independent. May name a default_toolkit.',
    not: [],
  },
  {
    term: 'toolkit',
    status: 'canonical',
    definition:
      'What a workspace is equipped with: MCP servers, tools, allow-entries. No authority — installing one grants nothing. Replaces "profile".',
    not: ['profile', 'kit', 'template'],
  },
  {
    term: 'workspace',
    status: 'canonical',
    definition: 'The folder a seat is bound to.',
    not: ['worktree'],
  },
  {
    term: 'harness',
    status: 'canonical',
    definition: 'The agent runtime family: Claude Code, Cursor, Codex.',
    not: [],
  },
  {
    term: 'driver',
    status: 'canonical',
    definition:
      'How a harness session runs: desktop, terminal, IDE, headless. Already the wire field (presence.driver).',
    not: [],
  },
  {
    term: 'scope',
    status: 'canonical',
    definition:
      'The paths a lane may touch. The wire token since 2026-08-24 (epoch 14); legacy surface_globs accepted on read.',
    not: [],
  },
  {
    term: 'permissions',
    status: 'canonical',
    definition:
      'The harness-native allow/ask/deny rules musterd compiles into the workspace (ADR 261).',
    not: [],
  },
  {
    term: 'capability',
    status: 'canonical',
    definition:
      'Team-granted authority on a member, enforced by musterd itself (is_admin, MCP tool scoping). Internal/protocol vocabulary; user-facing prose says what it means instead.',
    not: [],
  },
  {
    term: 'profile',
    status: 'banned',
    definition: 'Legacy name for toolkit (workspace equipment).',
    not: [],
  },
  {
    term: 'kit',
    status: 'banned',
    definition: 'Banned synonym for toolkit. Collides with the marketing asset kit deliverable.',
    not: [],
  },
  {
    term: 'template',
    status: 'banned',
    definition: 'Banned synonym for toolkit.',
    not: [],
  },
  {
    term: 'worktree',
    status: 'banned',
    definition: 'Git implementation detail — say workspace. Mentioned once in docs, not used.',
    not: [],
  },
];

/**
 * Word-bans for vocab:check. Only `status: banned` rows — harvesting every Not column would
 * ban ordinary English ("project", "session", "status") that the original five already
 * disprefer in prose but never linted (ADR 098's feature/task lesson).
 */
export function terminologyBans(): { re: RegExp; word: string }[] {
  return GLOSSARY.filter((t) => t.status === 'banned').map((t) => {
    const word = t.term.toLowerCase();
    return {
      word,
      re: word === 'kit' ? /\bkit\b/i : new RegExp(`\\b${word}s?\\b`, 'i'),
    };
  });
}
