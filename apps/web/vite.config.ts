/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const hub = 'http://127.0.0.1:7700';
const page = (name: string): string => fileURLToPath(new URL(name, import.meta.url));

/** The hub's `MERMAID_FRAME_CSP` (apps/airship/src/server.ts): keep the two the same. */
const MERMAID_FRAME_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'";

/**
 * In dev, serves Mermaid's frame as the built hub does: at the address the app frames, under the frame's CSP, and with
 * its module scripts loadable from the frame's opaque origin (they come with `Origin: null`, which Vite's CORS refuses).
 * Like the hub, which allows only `/assets/`, CORS covers just the code the frame loads, all of it public: Vite's
 * client, the frame's script and the pre-bundled packages. Anything else Vite serves (other files under the repository,
 * `?raw` imports) stays closed to another site's sandboxed frames.
 */
function mermaidFrameInDev(): Plugin {
  return {
    name: 'mermaid-frame-in-dev',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?', 1)[0] ?? '';
        if (path === '/sandbox/mermaid-frame.html' || path === '/mermaid-frame.html') {
          request.url = '/mermaid-frame.html';
          response.setHeader('content-security-policy', MERMAID_FRAME_CSP);
          response.setHeader('x-content-type-options', 'nosniff');
        } else if (request.headers.origin === 'null' && FRAME_CODE.some((allowed) => allowed.test(path))) {
          response.setHeader('access-control-allow-origin', '*');
        }
        next();
      });
    },
    // React's refresh preamble is inline script, which the frame's CSP refuses; nothing in the frame uses React.
    transformIndexHtml: {
      order: 'post',
      handler: (html, context) =>
        context.path === '/mermaid-frame.html'
          ? html.replace(/<script type="module">[^<]*\/@react-refresh[^<]*<\/script>\s*/, '')
          : html,
    },
  };
}

/** The paths of the code Mermaid's frame loads under `pnpm dev`. */
const FRAME_CODE = [
  /^\/@vite\/client$/,
  /^\/src\/mermaidFrame\.ts$/,
  /^\/node_modules\/\.vite\/deps\/[^/]+\.js$/,
  /^\/@fs\/.*\/node_modules\/vite\/dist\/client\/[^/]+\.mjs$/,
];

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
