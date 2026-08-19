import { defineConfig } from "@playwright/test";

// One shared fixture server (global setup): all specs run serially against it.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 45_000,
  workers: 1,
  retries: 0,
  use: { headless: true },
});
