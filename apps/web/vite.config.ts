/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const hub = 'http://127.0.0.1:7700';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __CB_RELEASE__: JSON.stringify(process.env.CB_RELEASE || 'dev') },
  server: {
    proxy: {
      '/api': hub,
      '/client': { target: hub, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
