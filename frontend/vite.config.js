import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev (dev.bat) the UI runs on :5173 and proxies API + media to the backend on :4000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4000',
      '/media': 'http://127.0.0.1:4000',
    },
  },
});
