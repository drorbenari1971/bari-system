import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev (dev.bat) the UI runs on :5173 and proxies API + media to the backend on :4000.
// `--mode pages` builds the in-browser demo for GitHub Pages into its own folder,
// so it never replaces frontend/dist, which start.bat serves.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'pages' ? '/bari-system/' : '/',
  build: { outDir: mode === 'pages' ? 'dist-pages' : 'dist' },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4000',
      '/media': 'http://127.0.0.1:4000',
    },
  },
}));
