/**
 * The built-in role library — a *seed of examples, not a catalog* (ADR 028,
 * provisioning-recipe.md §3). musterd ships a small set of archetypes to teach the template shape
 * and give a one-command start; users author their own in `.musterd/roles/*.json`.
 *
 * These are expressed in-source as raw data (validated through the same schema as user files by
 * {@link import('../role.js').parseRole}) rather than shipped as JSON assets: the package builds
 * with plain `tsc`, which does not copy non-TS files into `dist/`, so file-based built-ins would
 * need a bundler/copy step — a new build dependency we decline (ADR 029). User-authored templates
 * remain JSON. `role create` round-tripping a built-in into an editable `.musterd/roles/<name>.json`
 * is the bridge (recipe "Settled vs open").
 *
 * Charters stay lens-not-résumé and minimal. MCP entries are *referenced, not owned* — musterd
 * points at ecosystem servers (npx-launched) and never hosts or version-manages them. Secrets are
 * `${ENV}` references, never inline. `generalist` gets nothing extra.
 *
 * Exported as raw `unknown` (not yet parsed) so this module has no import cycle with `role.ts`,
 * which validates these into the typed `BUILTIN_ROLES` map at its own module-eval time.
 */
export const BUILTIN_ROLE_TEMPLATES: Record<string, unknown> = {
  generalist: {
    role: 'generalist',
    charter:
      'General contributor. Pick up work across the codebase; coordinate through the team acts.',
    // Nothing extra — only the musterd server + this bare charter (ADR 028).
  },

  reviewer: {
    role: 'reviewer',
    charter: [
      'Review teammates’ changes for correctness and clarity. Read widely; edit narrowly.',
      'status_update when you start and finish a review; resolve the thread once the change lands.',
    ],
    tools: {
      resource_scopes: ['**'],
      permissions: { allow: ['read', 'bash(git diff*)', 'bash(git log*)'], ask: ['edit', 'bash'] },
    },
  },

  backend: {
    role: 'backend',
    capacity: 2,
    charter: [
      'Own the server + data layer. Small, tested changes.',
      'status_update at task start/finish; request_help when blocked; resolve threads you finish.',
    ],
    tools: {
      resource_scopes: ['packages/server/**', 'packages/protocol/**'],
      mcp_servers: [
        {
          name: 'supabase',
          command: 'npx',
          args: ['-y', '@supabase/mcp-server-supabase@latest'],
          env: { SUPABASE_ACCESS_TOKEN: '${SUPABASE_ACCESS_TOKEN}' },
        },
      ],
      permissions: { allow: ['edit', 'read', 'bash(pnpm test*)'], ask: ['bash'] },
    },
  },

  frontend: {
    role: 'frontend',
    capacity: 2,
    charter: [
      'Own the UI layer. Keep components small and accessible; match the existing design system.',
      'status_update at task start/finish; hand off cleanly; resolve threads you finish.',
    ],
    tools: {
      resource_scopes: ['packages/web/**', 'packages/ui/**'],
      mcp_servers: [
        {
          name: 'figma',
          command: 'npx',
          args: ['-y', 'figma-developer-mcp', '--stdio'],
          env: { FIGMA_API_KEY: '${FIGMA_API_KEY}' },
        },
      ],
      permissions: { allow: ['edit', 'read', 'bash(pnpm test*)'], ask: ['bash'] },
    },
  },

  docs: {
    role: 'docs',
    charter: [
      'Own the docs. Keep them accurate and in sync with the code; one fact, one home.',
      'status_update at task start/finish; resolve threads you finish.',
    ],
    tools: {
      resource_scopes: ['docs/**', '**/*.md'],
      permissions: { allow: ['edit', 'read'], ask: ['bash'] },
    },
  },
};
