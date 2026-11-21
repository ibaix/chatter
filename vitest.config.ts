import { defineConfig } from 'vitest/config';

// One run of every test suite with coverage: `npm run coverage`.
// Each project keeps its own config (for example the forks pool of the server and jsdom of the web app).
// `npm test` does not use this file. It runs each workspace on its own.
export default defineConfig({
  test: {
    projects: ['packages/shared', 'apps/web', 'apps/server', 'tools/fake-machines', 'tools/fake-notify', 'tools/quality', 'tools/guardrails'],
    coverage: {
      provider: 'v8',
      include: [
        'packages/shared/src/**/*.ts',
        'apps/web/src/**/*.{ts,tsx}',
        'apps/server/src/**/*.ts',
        'tools/fake-machines/**/*.ts',
        'tools/fake-notify/**/*.ts',
        'tools/quality/**/*.ts',
        'tools/guardrails/**/*.ts',
      ],
      exclude: ['**/*.test.{ts,tsx}', '**/*.d.ts', '**/node_modules/**', 'apps/web/src/test/**'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // Coverage is a signal that we watch, not a gate. There are no thresholds on purpose.
    },
  },
});
