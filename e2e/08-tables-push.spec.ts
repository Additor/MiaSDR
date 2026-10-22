import { csvFile, expect, signInAdmin, test } from "./support/fixtures";

test.describe("tables edit and push to campaign", () => {
  test("import into a table, edit a cell, push the rows to a new campaign", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/tables");
    await page.getByRole("button", { name: "New workbook" }).first().click();
    await page.getByLabel("Name").fill("S8 prospects");
    await page.getByRole("button", { name: "Create workbook" }).click();
    await expect(page.getByRole("heading", { name: "S8 prospects" })).toBeVisible();

    await page.getByRole("button", { name: "More" }).click();

    await page.getByRole("menuitem", { name: "Import" }).click();
    await page.getByLabel("File to import").setInputFiles(
      csvFile("s8.csv", [
        ["Email", "First name", "Last name", "Company"],
        ["tess@s8-ventures.test", "Tess", "Moreau", "S8 Ventures"],
        ["uri@s8-ventures.test", "Uri", "Sato", "S8 Ventures"],
        ["vera@s8-ventures.test", "Vera", "Lund", "S8 Ventures"],
      ]),
    );
    await page.getByRole("button", { name: "Import 3 rows" }).click();
    await expect(page.getByText("Imported 3 rows and 4 new columns.")).toBeVisible();
    await expect(page.getByText("3 rows", { exact: true })).toBeVisible();

    // Add a blank row and fill it in by typing into cells.
    await page.getByRole("button", { name: "Add row", exact: true }).click();
    await expect(page.getByText("4 rows", { exact: true })).toBeVisible();
    const email = page.getByRole("gridcell", { name: "Email: empty" });
    await email.click();
    await page.keyboard.type("wes@s8-ventures.test");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("gridcell", { name: /Email: wes@s8-ventures.test/ })).toBeVisible();
    const first = page.getByRole("gridcell", { name: "First name: empty" });
    await first.click();
    await page.keyboard.type("Wes");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("gridcell", { name: /First name: Wes/ })).toBeVisible();

    // Select every loaded row and push.
    await page.getByRole("checkbox", { name: "Select all loaded rows" }).first().check();
    await page.getByRole("button", { name: "Push to campaign" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("4 rows become leads and are enrolled.")).toBeVisible();
    await dialog.getByLabel("New campaign name").fill("S8 from tables");
    await dialog.getByRole("button", { name: "Push 4 rows" }).click();
    await expect(dialog.getByText(/Created a draft campaign\./)).toBeVisible();
    await expect(dialog.getByText(/Enrolled\s*4\s*of 4/)).toBeVisible();
    await dialog.getByRole("link", { name: "Open campaign" }).click();

    // The campaign holds the four leads, with the typed row among them. Nothing was started.
    await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Leads in this campaign" })).toBeVisible();
    await expect(page.getByTestId("tab-all")).toHaveText(/^All\s*4$/);
    for (const email of ["tess@s8-ventures.test", "uri@s8-ventures.test", "vera@s8-ventures.test", "wes@s8-ventures.test"]) {
      await expect(page.getByRole("cell", { name: email, exact: true })).toBeVisible();
    }
    // The first name column was mapped, so the lead is named, not addressed by email.
    await expect(page.getByRole("cell", { name: "Wes", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start campaign" })).toBeVisible();
  });
});
