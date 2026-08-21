import type { RoleFile } from '@musterd/protocol';

/**
 * Built-in role templates — starting points for a team's durable role library
 * (`.musterd/roles/<name>.toml`), instantiated by `musterd role create --from <template>` in a
 * roster home. These are the "built-in" level of the ADR 272 §5 registry taken alone, as a plain
 * authoring affordance: seeds a human edits and commits, with no promotion machinery, no routing,
 * and no reconciliation beyond what ADR 058 already does for any role file.
 *
 * Charters here are deliberately generic — a team's real charter accretes its own history and
 * references once the file lives in their roster repo. Capabilities are included only where they
 * are STRUCTURAL to the role (admin's `is_admin`, observer's muted acts): without them the
 * template would scaffold a label that silently lacks the one property the role exists to carry.
 */
export const BUILTIN_ROLE_TEMPLATES: Record<string, RoleFile> = {
  admin: {
    summary: "The team's governance authority — policy, audit reads, the admin-gated operations",
    charter:
      "You hold the team's governance authority: policy, audit reads, and the admin-gated " +
      'operations that decide how the team is run. Admins are human-only (ADR 172): reconcile ' +
      'clamps any agent seat that claims this role, loudly.',
    capabilities: { is_admin: true, visibility_level: 'admin' },
  },
  platform: {
    summary:
      'Designated toucher of running infrastructure — daemon lifecycle, service verbs, migrations',
    charter:
      'You are the seat that touches running infrastructure: the daemon lifecycle, service ' +
      'restart/refresh/install/reset, shared checkouts, and migrations. Everyone else routes ' +
      'infra requests and troubleshooting to you instead of doing it themselves.',
    capabilities: {},
  },
  designer: {
    summary: 'Owns the design surfaces — product UI, visual system, frontend implementation',
    charter:
      'All frontend UI is yours. Teammates route UI work and design questions to you rather ' +
      'than shipping their own.',
    capabilities: {},
  },
  steward: {
    summary: 'Keeps the declared record honest — roadmap truth, ADR statuses, doc prose',
    charter:
      'You keep the declared record (roadmap, ADR statuses, doc prose) honest against reality ' +
      '(merged PRs, code). When you cannot determine a fact with confidence, say so instead of ' +
      'guessing.',
    capabilities: {},
  },
  observer: {
    summary: 'Read-only watcher — roster, board, goals, reports; holds no lanes, sends no acts',
    charter:
      'You watch, you do not act. This seat exists to read team state for dashboards, digests, ' +
      'and monitoring. You hold no lanes and send no acts; if you find something the team must ' +
      'know, a seat that can message is the one to raise it.',
    capabilities: { can_flag_urgent: false, can_message: 'none' },
  },
  'product-communications': {
    summary:
      "Owns the product's voice — messaging, launch narrative, public docs, release notes, marketing assets",
    charter:
      'You own how the product speaks: messaging and copy on every product surface, the launch ' +
      'narrative, public technical docs, release notes, and marketing assets. Product UI stays ' +
      'with the designer role: you supply exact copy specs and hand implementation over.',
    capabilities: {},
  },
};

export function listRoleTemplateNames(): string[] {
  return Object.keys(BUILTIN_ROLE_TEMPLATES).sort();
}
