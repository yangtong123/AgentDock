import { expect, test } from "@playwright/test";
import { signIn, createTaskViaComposer } from "./helpers";

test("composer creates + starts a cross-review task; run completes with findings", async ({ page }) => {
  await signIn(page);
  await createTaskViaComposer(page, "e2e cross-review task", "cross-review");

  // Steps progress live via SSE: REVIEW appears, then the whole run succeeds.
  await expect(page.locator("ol.steps li", { hasText: "REVIEW" }).first()).toContainText("SUCCEEDED");
  // Structured findings from the review are rendered.
  await expect(page.getByText("Review findings")).toBeVisible();
  await expect(page.getByText("add a trailing second line")).toBeVisible();
  await expect(page.locator(".badge.severity-minor").first()).toBeVisible();
  // Verification section is separate and passed.
  await expect(page.getByText("Verification (deterministic)")).toBeVisible();
  await expect(page.getByText("verify ok").first()).toBeVisible();
  // Terminal state.
  await expect(page.locator(".run-header .badge.state-succeeded")).toBeVisible({ timeout: 30_000 });
});
