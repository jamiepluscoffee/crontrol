import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: { outDir: resolve(__dirname, '../server/public'), emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:4100' } }
});
