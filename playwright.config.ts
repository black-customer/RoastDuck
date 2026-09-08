import { defineConfig } from "@playwright/test";
import { getE2ePort } from "./scripts/testing/ports";

const port = getE2ePort();
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/playwright",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `node scripts/testing/e2e-server.mjs ${port}`,
    url: baseURL,
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
