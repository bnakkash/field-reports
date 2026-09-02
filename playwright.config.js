import { defineConfig, devices } from '@playwright/test';

/**
 * One browser, one viewport: the phone this app is actually used on.
 *
 * The suite starts its own dev server and mocks the structuring endpoint, so
 * `npm test` needs neither a running server nor a network — which matters,
 * because the real endpoint has no API key and answers 500.
 */
const PORT = 5178;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'list' : [['list']],

  use: {
    baseURL: `http://localhost:${PORT}/`,
    // 414×896 — iPhone 11/XR, the size the UI was designed against.
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
    permissions: ['clipboard-read', 'clipboard-write', 'microphone'],
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'phone',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 414, height: 896 },
        // A fake capture device, so the recording path is exercisable without a
        // microphone and without a permission prompt. Speech recognition is
        // stubbed per-test; this only satisfies getUserMedia and MediaRecorder.
        launchOptions: {
          args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
        },
      },
    },
  ],

  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
