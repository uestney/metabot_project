import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '_backup_dev/**'],
    server: {
      deps: {
        external: ['undici'],
      },
    },
  },
});
