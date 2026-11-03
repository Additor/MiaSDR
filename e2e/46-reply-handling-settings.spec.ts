import { expect, signInAdmin, test } from "./support/fixtures";

/** Settings > Reply handling: the fixed reply types by group, each with what it does, and nothing to edit. */
test.describe("reply handling settings", () => {
  test("lists the reply types by group with what each one does, read-only", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/settings/replies");
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "Reply types", level: 2 })).toBeVisible();
    await expect(main.getByRole("heading", { level: 3 })).toHaveText(["Interested", "Existing customer", "Not interested", "Other"]);
    await expect(main.getByText(/subcategor|reply categor/i)).toHaveCount(0);
    await expect(main.getByText(/Position/)).toHaveCount(0);
    await expect(main.getByTestId("ai-pick-rule")).toContainText("under 85% confident");

    const row = (name: string) => main.getByTestId("reply-type-row").filter({ has: page.getByText(name, { exact: true }) });
    const stop = row("Asked to stop");
    await expect(stop.getByTestId("reply-type-rules")).toHaveText("No draft · Follow-ups stop");
    await expect(stop).toContainText("Use Stop contacting to stop all outreach to the person.");
    await expect(row("Customer question")).toContainText("Locked");
    await expect(row("Not now").getByTestId("reply-type-rules")).toHaveText("No draft · Follow-ups stop");

    // Nothing to edit: no add, edit, archive or delete, and no confidence floor field.
    await expect(main.getByTestId("reply-type-row").getByRole("button")).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Add reply type" })).toHaveCount(0);
    await expect(page.getByLabel("Percent confidence")).toHaveCount(0);
  });

  test("the API to edit reply types and the floor is gone", async ({ page }) => {
    await signInAdmin(page);
    expect((await page.request.post("/api/reply-types", { data: { groupKey: "other", name: "Nope" } })).status()).toBe(404);
    expect((await page.request.patch("/api/settings/replies", { data: { autoApplyConfidence: 0.5 } })).status()).toBe(404);
  });
});
