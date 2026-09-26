import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests of the console against a real backend, mock gateway and mock agent.
 * Uses the locally installed Google Chrome (no browser download needed); set E2E_CHANNEL to
 * another Playwright channel, or install Playwright's Chromium, if Chrome is not available.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    channel: process.env.E2E_CHANNEL ?? 'chrome',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @gmp/mock-gateway start',
      url: 'http://localhost:4101/_control/state',
      env: { PORT: '4101', MOCK_TIMINGS: 'fast', PUBLIC_URL: 'http://localhost:4101' },
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @gmp/mock-agent start',
      url: 'http://localhost:4102/_control/state',
      env: { PORT: '4102' },
      reuseExistingServer: false,
    },
    {
      command: 'node stack.mjs',
      url: 'http://localhost:3100/api/health',
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
