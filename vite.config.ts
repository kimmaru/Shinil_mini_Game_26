import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  worker: { format: 'es' },
  server: { port: 5173, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Games are deliberately absent here: each src/games/*/index.ts must stay
        // its own natural dynamic chunk so the lobby ships zero game code.
        manualChunks(id) {
          if (id.includes('@mediapipe')) return 'vision';
          if (id.includes('/src/engine/')) return 'engine';
          if (id.includes('/node_modules/react')) return 'react';
          return undefined;
        },
      },
    },
  },
});
