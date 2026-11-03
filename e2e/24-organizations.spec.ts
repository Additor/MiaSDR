import { ADMIN, expect, signInAdmin, sql, test, unique } from "./support/fixtures";

/** One install serves one organization: nothing in the app or its API creates a second one or moves between them. */
test.describe("one organization per install", () => {
  test("the sidebar names the organization, and creating or switching is gone from the app and refused by the API", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/leads");
    await expect(page.getByText(ADMIN.organization).first()).toBeVisible();
    await expect(page.getByTestId("org-switcher")).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "New organization" })).toHaveCount(0);

    expect((await page.request.get("/organizations/new")).status()).toBe(404);
    const name = unique("Second Org");
    expect((await page.request.post("/api/organizations", { data: { name } })).status()).toBe(404);
    expect((await page.request.post("/api/organizations/active", { data: { organizationId: "00000000-0000-4000-8000-000000000000" } })).status()).toBe(404);
    const created = await page.request.post("/api/auth/organization/create", { data: { name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-") } });
    expect(created.status()).toBe(403);
    expect(await sql()`select 1 from organizations where name = ${name}`).toHaveLength(0);
  });
});
