import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@temp-chat/protocol': path.resolve(webRoot, '../../packages/protocol/src/index.ts'),
    },
  },
  server: { port: 5173, strictPort: true },
});
