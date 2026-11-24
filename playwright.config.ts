// The Library's sandboxes in real browsers (docs/LIBRARY.md, "Prove it first"). `pnpm test:browser`; not part of
// `pnpm test`, as it needs the browsers (`pnpm exec playwright install chromium webkit`).
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'scripts/browser',
  testMatch: '*.spec.ts',
  globalSetup: './scripts/browser/sandbox-hub.ts',
  // One at a time: every test reads the same record of what reached the elsewhere server.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  use: {
    // The app's service worker only shows notifications (it has no fetch handler), and under Playwright's WebKit an
    // installed one leaves the page unanswering; blocking it changes nothing the tests look at.
    serviceWorkers: 'block',
  },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
