import { expect, signInAdmin, test } from "./support/fixtures";
import { gridPage, importCsv, newWorkbook } from "./support/grid";

/**
 * The Recalculate item of the formula column menu. The route and the use case have integration tests; this
 * spec proves the click reaches the route and that the grid shows the result.
 */
test.describe("formula column recalculation", () => {
  test("Recalculate from the column menu clears a #REF once the lookup source exists again", async ({ page }) => {
    await signInAdmin(page);
    const { workbookId } = await newWorkbook(page.request, "T1 recalc");
    const makeTable = async (name: string, rows: string[][]) => {
      const created = await page.request.post("/api/grid/tables", { data: { workbookId, name } });
      expect(created.status(), `create table ${name}`).toBe(201);
      const body = (await created.json()) as { table?: { id: string }; id?: string };
      const id = (body.table?.id ?? body.id) as string;
      await importCsv(page.request, id, rows);
      return id;
    };
    const companies = await makeTable("Companies", [["Domain", "Sector"], ["acme.test", "Software"]]);
    const people = await makeTable("People", [["Name", "Site"], ["Ann Lee", "acme.test"]]);

    const peopleColumns = (await gridPage(page.request, people)).columns;
    const site = peopleColumns.find((c) => c.name === "Site")!;
    const added = await page.request.post(`/api/grid/tables/${people}/columns`, {
      data: { name: "Industry", type: "formula", config: { expression: `LOOKUP("Companies", {{${site.key}}}, "Domain", "Sector", "n/a")` } },
    });
    expect(added.status(), "add LOOKUP column").toBe(201);

    // Deleting the source column makes the lookup unresolvable. The dependent cell shows #REF.
    const sector = (await gridPage(page.request, companies)).columns.find((c) => c.name === "Sector")!;
    const removed = await page.request.delete(`/api/grid/tables/${companies}/columns/${sector.id}`);
    expect(removed.status(), "delete source column").toBe(200);

    await page.goto(`/tables/${workbookId}`);
    await page.getByRole("tab", { name: "People" }).click();
    await expect(page.getByRole("gridcell", { name: "Name: Ann Lee" })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: /^Industry: #REF/ })).toBeVisible();

    // Recreating a column with the same name does not touch the dependent table, so the cell stays #REF until the click.
    const recreated = await page.request.post(`/api/grid/tables/${companies}/columns`, { data: { name: "Sector", type: "text" } });
    expect(recreated.status(), "recreate source column").toBe(201);
    await page.reload();
    await page.getByRole("tab", { name: "People" }).click();
    await expect(page.getByRole("gridcell", { name: /^Industry: #REF/ })).toBeVisible();

    const industry = (await gridPage(page.request, people)).columns.find((c) => c.name === "Industry")!;
    const call = page.waitForResponse((r) => r.url().endsWith(`/api/grid/tables/${people}/columns/${industry.id}/recalculate`) && r.request().method() === "POST");
    await page.getByRole("button", { name: "Column menu for Industry" }).click();
    await page.getByRole("menuitem", { name: "Recalculate" }).click();
    const res = await call;
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ changedCells: 1 });

    await expect(page.getByText('Recalculated "Industry". 1 cell changed.')).toBeVisible();
    await expect(page.getByRole("gridcell", { name: /^Industry: #REF/ })).toHaveCount(0);
    await expect(page.getByRole("gridcell", { name: /^Industry:/ })).toBeVisible();
    const after = await gridPage(page.request, people);
    const row = after.rows.find((r) => r.cells[after.columns.find((c) => c.name === "Name")!.key] === "Ann Lee")!;
    expect(row.cells[industry.key]).not.toBe("#REF");
    expect(row.cellMeta[industry.key]?.status).not.toBe("error");
  });
});
