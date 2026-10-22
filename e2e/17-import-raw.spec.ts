import { csvFile, expect, signInAdmin, test, unique } from "./support/fixtures";

test.describe("import keeps source data", () => {
  test("an extra column lands in Imported fields and can be mapped to a custom field", async ({ page }) => {
    const tag = unique("s17").toLowerCase();
    const email = `ada-${tag}@s17-labs.test`;
    const region = `EMEA-${tag}`;
    await signInAdmin(page);

    await page.goto("/leads/import");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Choose a CSV or XLSX file").setInputFiles(
      csvFile(`${tag}.csv`, [
        ["email", "first_name", "linkedin", "Region", "Company Size"],
        [email, "Ada", "https://www.linkedin.com/in/Ada-Lov-17/?trk=x", region, "120"],
      ]),
    );
    await expect(page.getByText("1 row found.")).toBeVisible();
    // T4: unrecognized columns default to merge fields and show the key they produce.
    await expect(page.getByLabel("Import Region as")).toContainText("Custom field");
    await expect(page.getByText("{{region}}")).toBeVisible();
    // This scenario covers source data, so switch both extra columns to "Do not map".
    for (const header of ["Region", "Company Size"]) {
      await page.getByLabel(`Import ${header} as`).click();
      await page.getByRole("option", { name: "Keep in source data only" }).click();
      await expect(page.getByLabel(`Import ${header} as`)).toContainText("Keep in source data only");
    }
    await page.getByRole("button", { name: "Review import" }).click();
    await page.getByRole("button", { name: "Import 1 lead: 1 new" }).click();
    await expect(page.getByText("Import finished")).toBeVisible();

    await page.goto("/leads");
    await page.getByLabel("Search leads").fill(email);
    await page.getByLabel("Search leads").press("Enter");
    await page.getByRole("link", { name: /Ada/ }).first().click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}(\?list=.*)?$/);

    // The LinkedIn field shows the canonical URL.
    await expect(page.getByTestId("person-details").getByRole("link", { name: "LinkedIn profile (opens in a new tab)" })).toHaveAttribute("href", "https://www.linkedin.com/in/ada-lov-17/");

    await page.getByTestId("imported-fields").locator("summary").click();
    const source = page.getByTestId("source-data");
    await expect(source).toContainText("Region");
    await expect(source).toContainText(region);
    // No company domain in the row, so the Company column stays on the person.
    await expect(source).toContainText("Company Size");
    await expect(page.getByTestId("company-source-data")).toHaveCount(0);

    // Map the key to a custom field.
    await page.getByRole("button", { name: "Map this field: Region" }).click();
    await page.getByLabel("Custom field name").fill("Sales region");
    await page.getByRole("button", { name: "Create and fill field" }).click();
    await expect(page.getByText(/updated in "Sales region"/)).toBeVisible();
    // The Details panel reads the new field first.
    const details = page.getByTestId("person-details");
    await expect(details.getByText("Sales region", { exact: true })).toBeVisible();
    await expect(details.getByText(region, { exact: true })).toBeVisible();
    // The raw key stays.
    await expect(page.getByTestId("source-data")).toContainText(region);
  });
});
