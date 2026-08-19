import { expect, test } from "@playwright/test";
import { signIn, createTaskViaComposer } from "./helpers";

test("refresh mid-run restores the same run/step view from the URL", async ({ page }) => {
  await signIn(page);
  await createTaskViaComposer(page, "e2e refresh task", "careful");
  // Parked at the gate, then reload: same run detail from the API, not memory.
  await expect(page.getByText("awaiting approval")).toBeVisible({ timeout: 30_000 });
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.getByText("awaiting approval")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("ol.steps li", { hasText: "PLAN" })).toContainText("SUCCEEDED");
});
