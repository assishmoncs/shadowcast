import { defineConfig } from '@playwright/test';

const dashboard = 'http://127.0.0.1:3100';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: 'list',
  use: {
    baseURL: dashboard,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'go run .',
      cwd: './signaling',
      url: 'http://127.0.0.1:8080/ready',
      env: { PORT: '8080', ALLOWED_ORIGIN: dashboard },
      timeout: 120_000,
    },
    {
      command: 'npm run start -w demo -- --hostname 127.0.0.1 --port 3100',
      url: dashboard,
      timeout: 120_000,
    },
  ],
});
