import { expect, importLeads, signInAdmin, test, tick, unique } from "./support/fixtures";

/**
 * Mia's fit check with `AI_PROVIDER=fake`: a title with Head, VP or Chief is a fit and another title a partial, each from
 * the profile. The verdict shows in the list, filters it and explains itself on the lead page.
 */

test.describe("Mia fit", () => {
  test("a person checks the fit of ticked leads, filters by it and reads why on the lead page", async ({ page }) => {
    await signInAdmin(page);
    const tag = unique("fit");
    const icp = await page.request.post("/api/brain", { data: { kind: "icp", fields: { icpName: `Revenue leaders ${tag}`, decisionMakerTitles: ["VP Sales"] } } });
    expect(icp.status()).toBe(201);
    await importLeads(page.request, [
      { email: `vera-${tag}@fit-e2e.test`, firstName: "Vera", lastName: `Senior ${tag}`, title: "VP Sales" },
      { email: `rob-${tag}@fit-e2e.test`, firstName: "Rob", lastName: `Rep ${tag}`, title: "Sales Rep" },
    ]);

    await page.goto(`/leads?q=${tag}`);
    await page.getByRole("checkbox", { name: "Select all leads on this page" }).check();
    await page.getByRole("button", { name: "Check fit" }).click();
    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText("left today");
    await confirm.getByRole("button", { name: "Check 2 leads" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByTestId("fit-batch")).toContainText("0 of 2 leads checked");

    await tick(page.request);
    await page.reload();
    await expect(page.getByTestId("fit-batch")).toContainText("Fit check finished: 2 of 2 leads checked.");
    const vera = page.getByRole("row").filter({ hasText: `Senior ${tag}` });
    await expect(vera.getByTestId("fit-badge")).toHaveText("Fit");
    await expect(page.getByRole("row").filter({ hasText: `Rep ${tag}` }).getByTestId("fit-badge")).toHaveText("Partial");

    await page.goto(`/leads?q=${tag}&fit=fit`);
    await expect(page.getByRole("row").filter({ hasText: tag })).toHaveCount(1);
    await expect(page.getByText(`Senior ${tag}`)).toBeVisible();

    await page.getByRole("link", { name: `Vera Senior ${tag}` }).click();
    const card = page.getByTestId("lead-fit");
    await expect(card.getByTestId("fit-badge")).toHaveText("Fit");
    await expect(card.getByTestId("fit-criterion")).toContainText("From the profile: “Title: VP Sales”");
    await expect(card.getByRole("button", { name: "Check again" })).toBeVisible();
  });
});
