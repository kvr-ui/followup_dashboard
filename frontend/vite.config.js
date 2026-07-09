import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During `npm run dev` the React app runs on port 5173 and proxies API
// calls to the Express backend on port 3000. `npm run build` outputs to
// dist/, which the backend serves in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/webhook': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
