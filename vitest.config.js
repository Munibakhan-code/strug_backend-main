import { defineConfig } from 'vitest/config';

// Integration / full suite share one Postgres → keep files serial (default).
// CI unit-only sets VITEST_FILE_PARALLELISM=1 for faster targeted runs.
const fileParallelism = process.env.VITEST_FILE_PARALLELISM === '1';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    setupFiles: ['test/setup.js'],
    fileParallelism,
    testTimeout: 20000,
    // truncateAll() TRUNCATEs every public table; under CI load that can exceed
    // Vitest's 10s default hookTimeout (seen on security-authz beforeEach).
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['utils/**', 'routes/**', 'services/**', 'middleware/**'],
    },
  },
});
