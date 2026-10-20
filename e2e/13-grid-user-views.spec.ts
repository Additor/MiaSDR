import type { Page } from "@playwright/test";
import { expect, seedMember, signInAdmin, test } from "./support/fixtures";
import { importCsv, newWorkbook, secondBrowser } from "./support/grid";

const MEMBER = { name: "Bea Views", email: "bea13@e2e-corp.test", password: "bea13-password-1" };

const ROWS = [
  ["Email", "Company"],
  ["ann@c2-views.test", "Acme"],
  ["bo@c2-views.test", "Beta"],
  ["cy@c2-views.test", "Acme Labs"],
  ["di@c2-views.test", "Delta"],
];

async function filterCompany(page: Page, value: string) {
  await page.getByRole("button", { name: "Column menu for Company" }).click();
  await page.getByRole("menuitem", { name: "Filter" }).click();
  const dialog = page.getByRole("dialog", { name: 'Filter "Company"' });
  await expect(dialog.getByText("The filter is saved for you and only changes what you see.")).toBeVisible();
  await dialog.getByLabel("Value").fill(value);
  await dialog.getByRole("button", { name: "Add filter" }).click();
  await expect(dialog).toBeHidden();
}

test.describe("per-user grid views", () => {
  test("an admin's filter is private, a member filters for themself, the admin saves a default and the member resets to it", async ({ page, browser }) => {
    await signInAdmin(page);
    await seedMember(page.request, MEMBER);
    const { workbookId, tableId } = await newWorkbook(page.request, "C2 views");
    await importCsv(page.request, tableId, ROWS);
    const member = await secondBrowser(browser, MEMBER.email, MEMBER.password);
    const bea = member.page;

    await page.goto(`/tables/${workbookId}`);
    await bea.goto(`/tables/${workbookId}`);
    await expect(page.getByText("4 rows", { exact: true })).toBeVisible();
    await expect(bea.getByText("4 rows", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Your view" })).toHaveCount(0);

    // The admin filters and sees fewer rows. The member still sees all four.
    await filterCompany(page, "Acme");
    await expect(page.getByText("2 rows of 4", { exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Company: Beta" })).toHaveCount(0);
    const adminView = page.getByRole("region", { name: "Your view" });
    await expect(adminView.getByRole("button", { name: "Reset to default view" })).toBeVisible();
    await expect(adminView.getByRole("button", { name: "Save as default for everyone" })).toBeVisible();
    await bea.reload();
    await expect(bea.getByText("4 rows", { exact: true })).toBeVisible();
    await expect(bea.getByRole("gridcell", { name: "Company: Beta" })).toBeVisible();
    await expect(bea.getByRole("region", { name: "Your view" })).toHaveCount(0);

    // The member filters for themself. Their view has no way to change the default.
    await filterCompany(bea, "Delta");
    await expect(bea.getByText("1 row of 4", { exact: true })).toBeVisible();
    await expect(bea.getByRole("gridcell", { name: "Company: Delta" })).toBeVisible();
    const memberView = bea.getByRole("region", { name: "Your view" });
    await expect(memberView.getByRole("button", { name: "Reset to default view" })).toBeVisible();
    await expect(memberView.getByRole("button", { name: "Save as default for everyone" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("2 rows of 4", { exact: true })).toBeVisible();

    // The admin makes the current view the default. Their own override is folded into it.
    await adminView.getByRole("button", { name: "Save as default for everyone" }).click();
    await expect(page.getByText("Saved as the default view for everyone.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Your view" })).toHaveCount(0);
    await expect(page.getByText("2 rows of 4", { exact: true })).toBeVisible();

    // The member keeps their own filter until they reset it, then follows the new default.
    await bea.reload();
    await expect(bea.getByText("1 row of 4", { exact: true })).toBeVisible();
    await memberView.getByRole("button", { name: "Reset to default view" }).click();
    await expect(bea.getByText("2 rows of 4", { exact: true })).toBeVisible();
    await expect(bea.getByRole("gridcell", { name: "Company: Acme Labs" })).toBeVisible();
    await expect(bea.getByRole("gridcell", { name: "Company: Delta" })).toHaveCount(0);
    await expect(bea.getByRole("region", { name: "Your view" })).toHaveCount(0);

    await member.done();
  });
});
