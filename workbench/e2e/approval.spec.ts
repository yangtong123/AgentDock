import { expect, test } from "@playwright/test";
import { signIn, createTaskViaComposer } from "./helpers";

test("careful preset parks at the gate; approving twice completes the run", async ({ page }) => {
  await signIn(page);
  await createTaskViaComposer(page, "e2e careful task", "careful");

  // Parked at the first gate: badge + buttons visible.
  await expect(page.getByText("awaiting approval")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  // First gate decided; the run resumes and parks at the second gate.
  await expect(page.locator("ol.steps li", { hasText: "HUMAN_APPROVAL" }).first()).toContainText("SUCCEEDED");
  await expect(page.getByText("awaiting approval")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.locator(".run-header .badge.state-succeeded")).toBeVisible({ timeout: 30_000 });
});
