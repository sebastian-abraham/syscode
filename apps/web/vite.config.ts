import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The engine serves the built UI from `/` on http://localhost:4317.
// In dev, Vite runs on 5173 and proxies every /api call (including the
// chat SSE stream, which is a POST and therefore needs a live proxy).
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4317',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
