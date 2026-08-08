import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH ?? '/',
  build: {
    outDir: 'dist',
    // Geo payloads are the bulk of the bundle-adjacent assets; they live in
    // public/ and are fetched at runtime, so keep the JS chunk warning tight.
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs', 'worker/**/*.test.mjs'],
  },
});
