import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e holds Playwright specs, not vitest.
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
