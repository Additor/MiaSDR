import { expect, signInAdmin, test, waitForHydrated } from "./support/fixtures";

async function turnOnMcp(page: import("@playwright/test").Page) {
  await page.goto("/settings/mcp");
  await expect(page.getByRole("button", { name: /^Turn (on|off) MCP$/ })).toBeVisible();
  if (await page.getByText("MCP is off.").isVisible()) {
    await page.getByRole("button", { name: "Turn on MCP" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
  await expect(page.getByText("MCP is on.")).toBeVisible();
}

async function saveLimits(page: import("@playwright/test").Page, limits: { spend: string; search: string; irreversible: string }) {
  await page.goto("/settings/organization");
  const card = page.getByRole("region", { name: "Agents can spend and delete" });
  await waitForHydrated(card.getByRole("button", { name: "Save" }));
  await card.getByLabel("Enrichment spend per day, in dollars").fill(limits.spend);
  await card.getByLabel("LinkedIn search results per day").fill(limits.search);
  await card.getByLabel("Actions agents cannot undo, per day").fill(limits.irreversible);
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/settings/mcp") && r.request().method() === "PATCH");
  await card.getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save limits" }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByRole("dialog")).toBeHidden();
}

test("an owner sets the limits and ticks what a token may do, and setting a limit to 0 retires it", async ({ page }) => {
  await signInAdmin(page);
  await turnOnMcp(page);

  // Off by default: the options are not offered at all.
  await page.goto("/settings/mcp");
  const form = page.locator("form").filter({ has: page.getByLabel("Token name") });
  await waitForHydrated(form.getByRole("button", { name: "Create token" }));
  await form.getByRole("radio", { name: "Read and make changes" }).click();
  await expect(page.getByRole("checkbox", { name: "Complete campaigns and delete leads, contacts and deals" })).toHaveCount(0);

  await saveLimits(page, { spend: "5", search: "100", irreversible: "3" });
  await page.goto("/settings/organization");
  await expect(page.getByLabel("Enrichment spend per day, in dollars")).toHaveValue("5");

  await page.goto("/settings/mcp");
  await waitForHydrated(form.getByRole("button", { name: "Create token" }));
  // Read only offers nothing more, and neither option starts ticked.
  await expect(page.getByRole("checkbox", { name: "Complete campaigns and delete leads, contacts and deals" })).toHaveCount(0);
  await form.getByRole("radio", { name: "Read and make changes" }).click();
  const irreversible = page.getByRole("checkbox", { name: "Complete campaigns and delete leads, contacts and deals" });
  await expect(irreversible).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: "Spend on enrichment and LinkedIn searches" })).not.toBeChecked();
  await irreversible.click();
  await form.getByLabel("Token name").fill("Cleanup agent");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/settings/mcp/tokens") && r.request().method() === "POST");
  await form.getByRole("button", { name: "Create token" }).click();
  expect((await created).status()).toBe(201);
  const row = page.getByRole("list", { name: "Your tokens" }).getByRole("listitem").filter({ hasText: "Cleanup agent" });
  await expect(row.getByText("Deletes", { exact: true })).toBeVisible();
  await expect(row.getByText("Spends", { exact: true })).toHaveCount(0);

  await saveLimits(page, { spend: "5", search: "100", irreversible: "0" });
  await page.goto("/settings/mcp");
  await expect(row.getByText("No longer deletes", { exact: true })).toBeVisible();

  await saveLimits(page, { spend: "0", search: "0", irreversible: "0" });
  await page.goto("/settings/mcp");
  await page.getByRole("button", { name: "Turn off MCP" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("MCP is off.")).toBeVisible();
});
