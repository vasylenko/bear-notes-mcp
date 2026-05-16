import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/system/**/*.test.ts'],
    testTimeout: 180_000,
    // afterAll cleanupTestNotes spawns one Inspector CLI per test note (~1.5s
    // each); the default 10s hook timeout fails files that accumulate 7+ notes.
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
