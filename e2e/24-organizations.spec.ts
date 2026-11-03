import { ADMIN, expect, importLeads, signInAdmin, test, unique, waitForHydrated } from "./support/fixtures";

/** The admin owns the first organization, so invite-only signup lets them create a second one. */
test.describe("organizations", () => {
  test("create a second organization, its data stays apart, switch back, and the choice survives a reload", async ({ page }) => {
    await signInAdmin(page);
    const lead = { email: `${unique("org24")}@s24-group.test`, firstName: "Odette", lastName: unique("Orgleaf"), company: "S24 Group" };
    await importLeads(page.request, [lead]);
    const secondName = unique("Second Org");

    await page.goto("/leads");
    await expect(page.getByText(lead.lastName).first()).toBeVisible();
    const switcher = page.getByTestId("org-switcher");
    await expect(switcher).toContainText(ADMIN.organization);

    // Create: sidebar -> New organization -> form.
    await waitForHydrated(switcher);
    await switcher.click();
    await page.getByRole("menuitem", { name: "New organization" }).click();
    await expect(page).toHaveURL(/\/organizations\/new$/);
    const name = page.getByLabel("Organization name");
    await waitForHydrated(name);
    await name.fill(secondName);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page).toHaveURL(/\/actions$/);
    // A new organization lands on Actions, which lists no leads. Leads is where the first one's lead would show, and the
    // switch below keeps the list page you are on.
    await page.goto("/leads");

    // The new organization is active and has none of the first one's leads.
    await expect(page.getByTestId("org-switcher")).toContainText(secondName);
    await expect(page.getByText(lead.lastName)).toHaveCount(0);

    // A reload keeps the choice.
    await page.reload();
    await expect(page.getByTestId("org-switcher")).toContainText(secondName);
    await expect(page.getByText(lead.lastName)).toHaveCount(0);

    // Switch back: the lead returns, and the choice survives a reload.
    await waitForHydrated(page.getByTestId("org-switcher"));
    await page.getByTestId("org-switcher").click();
    await page.getByRole("menuitemradio", { name: ADMIN.organization }).click();
    await expect(page.getByTestId("org-switcher")).toContainText(ADMIN.organization);
    await expect(page.getByText(lead.lastName).first()).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("org-switcher")).toContainText(ADMIN.organization);
    await expect(page.getByText(lead.lastName).first()).toBeVisible();
  });

  test("a switch loads the page again, and a tab left on the old organization cannot write into the new one", async ({ page, context }) => {
    await signInAdmin(page);
    const secondName = unique("Fence Org");
    await page.goto("/organizations/new");
    const name = page.getByLabel("Organization name");
    await waitForHydrated(name);
    await name.fill(secondName);
    await page.getByRole("button", { name: "Create organization" }).click();
    await expect(page).toHaveURL(/\/actions$/);

    // The stale tab: rendered for the new organization, then left alone.
    const stale = await context.newPage();
    await stale.goto("/settings/organization");
    await expect(stale.getByTestId("org-switcher")).toContainText(secondName);
    const nameField = stale.getByLabel("Name").first();
    await waitForHydrated(nameField);

    // A push would keep this mark, since Next keeps the page's client state.
    await page.goto("/tables");
    await page.evaluate(() => Object.assign(window, { __beforeSwitch: true }));
    const switcher = page.getByTestId("org-switcher");
    await waitForHydrated(switcher);
    await switcher.click();
    await page.getByRole("menuitemradio", { name: ADMIN.organization }).click();
    await expect(page.getByTestId("org-switcher")).toContainText(ADMIN.organization);
    expect(await page.evaluate(() => "__beforeSwitch" in window)).toBe(false);

    await nameField.fill(`${secondName} edited`);
    await stale.getByRole("button", { name: "Save" }).first().click();
    await expect(stale.getByText("You switched organization in another tab. Reload this page to continue.").first()).toBeVisible();
    await expect(page.getByTestId("org-switcher")).toContainText(ADMIN.organization);
    await stale.close();
  });
});
