import { ADMIN, expect, signInAdmin, test } from "./support/fixtures";
import { cellValue, gridPage, importCsv, newWorkbook, secondBrowser, writeCell } from "./support/grid";

const COMPANIES = [
  ["Email", "Company"],
  ["ann@c2-collab.test", "Acme"],
  ["bo@c2-collab.test", "Beta"],
];

test.describe("grid collaboration", () => {
  test("two browsers on one table see each other's edits through the changes feed", async ({ page, browser }) => {
    await signInAdmin(page);
    const { workbookId, tableId } = await newWorkbook(page.request, "C2 collaboration");
    await importCsv(page.request, tableId, COMPANIES);
    await page.goto(`/tables/${workbookId}`);
    await expect(page.getByRole("gridcell", { name: "Company: Acme" })).toBeVisible();

    const other = await secondBrowser(browser, ADMIN.email, ADMIN.password);
    await other.page.goto(`/tables/${workbookId}`);
    await expect(other.page.getByRole("gridcell", { name: "Company: Acme" })).toBeVisible();

    // An edit in the first browser reaches the second one without a reload.
    await page.getByRole("gridcell", { name: "Company: Acme" }).click();
    await page.keyboard.type("Acme Inc");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("gridcell", { name: "Company: Acme Inc" })).toBeVisible();
    await expect(other.page.getByRole("gridcell", { name: "Company: Acme Inc" })).toBeVisible({ timeout: 20_000 });

    // And the other way round.
    await other.page.getByRole("gridcell", { name: "Company: Beta" }).click();
    await other.page.keyboard.type("Beta Labs");
    await other.page.keyboard.press("Enter");
    await expect(other.page.getByRole("gridcell", { name: "Company: Beta Labs" })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Company: Beta Labs" })).toBeVisible({ timeout: 20_000 });

    // A row added in one browser appears in the other.
    await other.page.getByRole("button", { name: "Add row", exact: true }).click();
    await expect(other.page.getByText("3 rows", { exact: true })).toBeVisible();
    await expect(page.getByText("3 rows", { exact: true })).toBeVisible({ timeout: 20_000 });

    await other.done();
  });

  test("a stale edit opens the conflict dialog; retry writes it, keep current drops it", async ({ page, watch }) => {
    watch.tolerate(/409/);
    await signInAdmin(page);
    const { workbookId, tableId } = await newWorkbook(page.request, "C2 conflicts");
    await importCsv(page.request, tableId, COMPANIES);
    await page.goto(`/tables/${workbookId}`);
    await expect(page.getByRole("gridcell", { name: "Company: Acme" })).toBeVisible();

    // Freeze this browser's changes feed so it cannot learn about the other edit before it saves its own.
    await page.route("**/api/grid/tables/*/changes*", (route) => route.fulfill({ json: { rows: [], cursor: "0", hasMore: false, total: 2, activeJobs: 0 } }));

    const before = await gridPage(page.request, tableId);
    const company = before.columns.find((c) => c.name === "Company")!.key;
    const rowId = before.rows.find((r) => r.cells[company] === "Acme")!.id;

    // Someone else changes the row. This browser still shows "Acme" and edits it.
    await writeCell(page.request, tableId, rowId, company, "Acme from them");
    await page.getByRole("gridcell", { name: "Company: Acme" }).click();
    await page.keyboard.type("Acme from me");
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", { name: "Some rows changed while you edited" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Nothing was saved.")).toBeVisible();
    await expect(dialog.getByText("Row 1 · Company")).toBeVisible();
    await expect(dialog.getByText("Acme from them")).toBeVisible();
    await expect(dialog.getByText("Acme from me")).toBeVisible();
    expect(await cellValue(page.request, tableId, "Email", "ann@c2-collab.test", "Company")).toBe("Acme from them");

    await dialog.getByRole("button", { name: "Retry my edits" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("gridcell", { name: "Company: Acme from me" })).toBeVisible();
    await expect.poll(() => cellValue(page.request, tableId, "Email", "ann@c2-collab.test", "Company")).toBe("Acme from me");

    // A second collision, resolved the other way.
    await writeCell(page.request, tableId, rowId, company, "Acme again from them");
    await page.getByRole("gridcell", { name: "Company: Acme from me" }).click();
    await page.keyboard.type("Acme again from me");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep current values" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("gridcell", { name: "Company: Acme again from them" })).toBeVisible();
    expect(await cellValue(page.request, tableId, "Email", "ann@c2-collab.test", "Company")).toBe("Acme again from them");
  });
});
