import { expect, test } from "@playwright/test";
import { signIn, createTaskViaComposer } from "./helpers";

test("cancel a running run from the UI", async ({ page }) => {
  await signIn(page);
  await createTaskViaComposer(page, "e2e cancel task", "careful");
  await expect(page.getByText("awaiting approval")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".run-header .badge.state-cancelled")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("run.cancelled").first()).toBeVisible();
});
