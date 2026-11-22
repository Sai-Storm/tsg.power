// Browser tests (npm run test:e2e).
//   e2e/smoke.spec.js         always runs: the app loads and the sign-in page works.
//   e2e/advance-flow.spec.js  the full advance workflow; runs only when test
//                             accounts are given (see e2e/README.md). Point it at
//                             a TEST Supabase project, never the live one.
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 4173);
const baseURL = process.env.E2E_BASE_URL || `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Use an installed browser locally (E2E_CHANNEL=msedge or chrome);
    // CI installs Playwright's own Chromium.
    ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}),
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}) } },
    { name: 'phone', use: { ...devices['Pixel 7'], ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}) }, testMatch: /smoke/ },
  ],
  // Serve the production build unless a running site is given.
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: `npm run build && npx vite preview --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
