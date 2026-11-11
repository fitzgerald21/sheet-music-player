import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// COI=1 serves the app cross-origin isolated, which lets on-device scanning use several CPU threads
const coi = process.env.COI ? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } : undefined;

export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH ?? '/',
  server: {
    host: true,
    headers: coi,
    proxy: { '/api': 'http://localhost:8787' },
  },
  preview: { headers: coi },
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 3000 },
});
