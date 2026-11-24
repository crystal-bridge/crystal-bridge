/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const hub = 'http://127.0.0.1:7700';
const page = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

/** In dev, answers the address the hub serves Mermaid's frame at, as the built hub does. */
function mermaidFrameInDev(): Plugin {
  return {
    name: 'mermaid-frame-in-dev',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url?.split('?', 1)[0] === '/sandbox/mermaid-frame.html') request.url = '/mermaid-frame.html';
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mermaidFrameInDev()],
  build: {
    rolldownOptions: {
      // The app, and the sandboxed page Mermaid draws in: Mermaid's code is only in the second.
      input: { main: page('index.html'), mermaidFrame: page('mermaid-frame.html') },
    },
  },
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
