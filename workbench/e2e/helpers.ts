import { expect, test, type Page } from "@playwright/test";

export const E2E_URL = (): string => process.env.E2E_URL!;
export const E2E_TOKEN = (): string => process.env.E2E_TOKEN!;

/** Signs in through the token gate and lands on the task list. */
export async function signIn(page: Page): Promise<void> {
  await page.goto(`${E2E_URL()}/`);
  await page.getByPlaceholder("gateway token").fill(E2E_TOKEN());
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("button", { name: "AgentDock" })).toBeVisible();
}

/** Creates + starts a task through the composer; returns the run detail page. */
export async function createTaskViaComposer(page: Page, request: string, preset: string): Promise<void> {
  await page.getByRole("button", { name: "+ new task" }).click();
  await page.getByLabel("Requirement").fill(request);
  await page.getByLabel("Workflow preset").selectOption(preset);
  await page.getByRole("button", { name: "Create & start" }).click();
  // Lands on the run detail for the created task.
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}/);
}
