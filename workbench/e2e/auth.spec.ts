import { expect, test } from "@playwright/test";
import { E2E_TOKEN, E2E_URL, signIn } from "./helpers";

test("token gate: wrong token rejected, right token shows the task list", async ({ page }) => {
  await page.goto(`${E2E_URL()}/`);
  await expect(page.getByText("Enter the gateway access token")).toBeVisible();
  await page.getByPlaceholder("gateway token").fill("wrong-token");
  await page.getByRole("button", { name: "Connect" }).click();
  // 401 clears the token: the gate stays up.
  await expect(page.getByText("Enter the gateway access token")).toBeVisible();
  await page.getByPlaceholder("gateway token").fill(E2E_TOKEN());
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("button", { name: "AgentDock" })).toBeVisible();
  await expect(page.getByRole("button", { name: /e2e/ })).toBeVisible(); // the fixture project
});
