import type { Route } from "@playwright/test";
import { expect, signInAdmin, test } from "./support/fixtures";
import { cellValue, importCsv, newWorkbook } from "./support/grid";

const COMPANIES = [
  ["Email", "Company"],
  ["ann@load-merge.test", "Acme"],
  ["bo@load-merge.test", "Beta"],
];

/** A promise and the function that settles it. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

test.describe("grid load merge", () => {
  test("a table load that read a row before an edit saved keeps the saved row, so the next edit does not conflict", async ({ page }) => {
    await signInAdmin(page);
    const { workbookId, tableId } = await newWorkbook(page.request, "Load merge");
    await importCsv(page.request, tableId, COMPANIES);
    await page.goto(`/tables/${workbookId}`);
    await expect(page.getByRole("gridcell", { name: "Company: Acme" })).toBeVisible();

    // The changes feed stays silent, so only the table load and the edit response bring rows in.
    await page.route("**/api/grid/tables/*/changes*", (route) => route.fulfill({ json: { rows: [], cursor: "0", hasMore: false, total: 2, activeJobs: 0 } }));

    // The search load reads the table before the edit saves and answers only after the edit response came back.
    const loadRead = gate();
    const releaseLoad = gate();
    await page.route(
      (url) => url.pathname === `/api/grid/tables/${tableId}` && url.searchParams.has("search"),
      async (route: Route) => {
        const response = await route.fetch();
        loadRead.open();
        await releaseLoad.wait;
        await route.fulfill({ response });
      },
    );
    let held = false;
    await page.route(`**/api/grid/tables/${tableId}/cells`, async (route: Route) => {
      if (route.request().method() === "PATCH" && !held) {
        held = true;
        await loadRead.wait;
      }
      await route.continue();
    });

    const firstSave = page.waitForResponse((r) => r.url().endsWith(`/api/grid/tables/${tableId}/cells`) && r.request().method() === "PATCH");
    await page.getByRole("gridcell", { name: "Company: Acme" }).click();
    await page.keyboard.type("Acme Inc");
    await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "Search rows" }).fill("ann@");
    expect((await firstSave).status()).toBe(200);
    await expect(page.getByText("Saving", { exact: true })).toBeHidden();

    // The older page lands. The search drops Beta, which shows the page was applied.
    const searched = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/grid/tables/${tableId}` && new URL(r.url()).searchParams.has("search"));
    releaseLoad.open();
    await searched;
    await expect(page.getByRole("gridcell", { name: "Company: Beta" })).toBeHidden();

    const secondSave = page.waitForResponse((r) => r.url().endsWith(`/api/grid/tables/${tableId}/cells`) && r.request().method() === "PATCH");
    await page.getByRole("gridcell", { name: /^Company: Acme/ }).click();
    await page.keyboard.type("Acme Labs");
    await page.keyboard.press("Enter");
    expect((await secondSave).status()).toBe(200);
    await expect(page.getByRole("dialog", { name: "Some rows changed while you edited" })).toBeHidden();
    await expect(page.getByRole("gridcell", { name: "Company: Acme Labs" })).toBeVisible();
    expect(await cellValue(page.request, tableId, "Email", "ann@load-merge.test", "Company")).toBe("Acme Labs");
  });
});
