import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    env: { MUSTERD_SILENT: '1' },
  },
});
