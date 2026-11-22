import { defineConfig, devices } from '@playwright/test';
import type { WatchdogReporterOptions } from './src/report-types';
import type { WatchdogFixtures } from './src/fixture';

const port = Number(process.env.DEMO_PORT ?? 4319);
const baseURL = `http://localhost:${port}`;
const browsers = [
  ['chromium', 'Desktop Chrome'],
  ['firefox', 'Desktop Firefox'],
  ['webkit', 'Desktop Safari'],
] as const;

const watchdogReporter: WatchdogReporterOptions = {
  outputDir: 'watchdog-report',
  baselineFile: 'watchdog-baseline.json',
  failOnNew: 'medium',
  ai: { enabled: false, model: 'claude-opus-5-5' },
};

export default defineConfig<WatchdogFixtures>({
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['./src/reporter.ts', watchdogReporter]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    watchdogOptions: {
      ignore: [{ category: 'console-warning', message: '[deprecated]', reason: 'Old analytics script, removal planned' }],
    },
  },
  webServer: {
    command: 'node demo/server.mjs',
    url: `${baseURL}/health`,
    reuseExistingServer: false,
    env: { DEMO_PORT: String(port) },
  },
  projects: [
    { name: 'unit', testDir: './tests/unit' },
    ...browsers.flatMap(([browser, device]) => [
      { name: `integration-${browser}`, testDir: './tests/integration', use: { ...devices[device] } },
      { name: `demo-${browser}`, testDir: './tests/e2e', use: { ...devices[device] } },
    ]),
  ],
});
