import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    // The HTML app is not loaded; we test the pure logic extracted into
    // src/proplan-core.mjs. Coverage is reported against that module only —
    // the DOM-coupled HTML script is intentionally out of scope.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.mjs'],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
