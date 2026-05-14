import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // spike/ holds standalone behaviour-check scripts ("7/7 SDK checks pass"
    // harnesses) run directly during development — they are not vitest
    // suites, so exclude them from the test run.
    // _backup_dev/ is our local backup tree, also excluded.
    exclude: ['**/node_modules/**', '**/dist/**', 'spike/**', '_backup_dev/**'],
    server: {
      deps: {
        external: ['undici'],
      },
    },
  },
});
