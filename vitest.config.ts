import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // Games must run headless in Node: no DOM, no canvas, no camera.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/engine/testing/setup.ts'],
    testTimeout: 20_000,
  },
});
