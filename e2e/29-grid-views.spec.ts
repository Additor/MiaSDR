import { MOBILE_DARK, expect, expectNoHorizontalOverflow, signInAdmin, test } from "./support/fixtures";
import { gridPage, importCsv, newWorkbook, settle, writeCell, type GridColumnJson } from "./support/grid";
import { seedGrid } from "./support/grid-seed";
import type { Locator, Page } from "@playwright/test";

/**
 * G3: the filter and sort panel and the partial run controls (first N rows, one cell). GRID_PROVIDER=fake and
 * AI_PROVIDER=fake come from e2e/run.mjs. Specs 27 and 28 belong to G1 and G2.
 */

async function choose(page: Page, scope: Locator, label: string, option: string | RegExp) {
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

const openPanel = async (page: Page) => {
  await page.getByRole("button", { name: /^Filter and sort/ }).click();
  const panel = page.getByRole("dialog", { name: "Filter and sort" });
  await expect(panel).toBeVisible();
  return panel;
};

test.describe("filter and sort panel", () => {
  test("filters with a condition, a muted condition and a nested group, and sorts by two columns", async ({ page }) => {
    await signInAdmin(page);
    const seeded = await seedGrid(page.request, { rows: 120, name: "G3 filter panel" });
    // The seed puts the top Score (Person 120) in company 0 as well, so both sort orders would start with the same row.
    // Move Person 120 to company 9, which sorts last. Now "company, then Score high to low" starts with Person 113 (the top
    // Score of company 0) and "Score high to low" alone starts with Person 120.
    const everyRow = (await gridPage(page.request, seeded.tableId)).rows;
    const top = everyRow.find((r) => r.cells[seeded.keys.Name] === "Person 120");
    expect(top).toBeDefined();
    await writeCell(page.request, seeded.tableId, top!.id, seeded.keys["회사"], "회사 9");

    await page.goto(`/tables/${seeded.workbookId}`);
    await expect(page.getByText("120 rows", { exact: true })).toBeVisible();

    // One condition: Score greater than 100 leaves rows 101 to 120.
    let panel = await openPanel(page);
    await panel.getByRole("button", { name: "Add condition", exact: true }).click();
    await choose(page, panel, "Condition 1 column", "Score (Number)");
    await choose(page, panel, "Condition 1 operator", "greater than");
    await panel.getByLabel("Condition 1 value").fill("100");
    await panel.getByRole("button", { name: "Apply" }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByText("20 rows of 120", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Filter and sort (1 filter)" })).toBeVisible();

    // Muting keeps the condition and stops it filtering. The toolbar no longer counts it.
    panel = await openPanel(page);
    await panel.getByRole("button", { name: "Mute condition 1" }).click();
    await panel.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("120 rows", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Filter and sort", exact: true })).toBeVisible();
    await expect(page.getByLabel("Active filters and sorts").getByText(/\(muted\)/)).toBeVisible();
    const stored = (await gridPage(page.request, seeded.tableId)).view as { filters?: { conditions: Array<{ disabled?: boolean }> } };
    expect(stored.filters?.conditions[0].disabled).toBe(true);

    // Unmute, then build: Score at most 2, or a group of (Score at least 100 and Name contains "Person 11").
    panel = await openPanel(page);
    await panel.getByRole("button", { name: "Unmute condition 1" }).click();
    await choose(page, panel, "Condition 1 operator", "at most");
    await panel.getByLabel("Condition 1 value").fill("2");
    await panel.getByRole("button", { name: "Add group", exact: true }).first().click();
    const group = panel.getByRole("group", { name: "Group 2", exact: true });
    await group.getByRole("button", { name: "Add condition to group" }).click();
    await choose(page, group, "Condition 2.1 column", "Score (Number)");
    await choose(page, group, "Condition 2.1 operator", "at least");
    await group.getByLabel("Condition 2.1 value").fill("100");
    await choose(page, group, "Condition 2.2 operator", "contains");
    await group.getByLabel("Condition 2.2 value").fill("Person 11");
    await group.getByRole("button", { name: "all", exact: true }).click();
    await panel.getByRole("group", { name: "Conditions", exact: true }).getByRole("button", { name: "any", exact: true }).first().click();
    await panel.getByRole("button", { name: "Apply" }).click();
    // Rows 1 and 2, plus 110 to 119 (Score at least 100 and a name starting "Person 11").
    await expect(page.getByText("12 rows of 120", { exact: true })).toBeVisible();

    panel = await openPanel(page);
    await panel.getByRole("button", { name: "Clear all" }).click();
    await panel.getByRole("button", { name: "Add sort" }).click();
    await choose(page, panel, "Sort 1 column", "회사");
    await panel.getByRole("button", { name: "Add sort" }).click();
    await choose(page, panel, "Sort 2 column", "Score");
    await choose(page, panel, "Sort 2 direction", /Z to A/);
    await panel.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("120 rows", { exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Name: Person 113", exact: true })).toBeVisible();
    const first = (await gridPage(page.request, seeded.tableId)).rows[0].cells;
    expect(first[seeded.keys.Name]).toBe("Person 113");

    // Move the Score sort to the top: the highest score overall comes first, which is another row than before.
    panel = await openPanel(page);
    await panel.getByRole("button", { name: "Move sort 2 up" }).click();
    await panel.getByRole("button", { name: "Apply" }).click();
    await expect.poll(async () => ((await gridPage(page.request, seeded.tableId)).view as { sorts?: Array<{ columnKey: string }> }).sorts?.[0].columnKey).toBe(seeded.keys.Score);
    await expect.poll(async () => (await gridPage(page.request, seeded.tableId)).rows[0].cells[seeded.keys.Name]).toBe("Person 120");
    await expect(page.getByRole("gridcell", { name: "Name: Person 120", exact: true })).toBeVisible();

    // The panel keeps its place after a reload: the member's own view is stored.
    await page.reload();
    await expect(page.getByRole("button", { name: "Filter and sort (2 sorts)" })).toBeVisible();
  });

  test("a validation message keeps the panel open", async ({ page }) => {
    await signInAdmin(page);
    const seeded = await seedGrid(page.request, { rows: 5, name: "G3 filter validation" });
    await page.goto(`/tables/${seeded.workbookId}`);
    const panel = await openPanel(page);
    await panel.getByRole("button", { name: "Add condition", exact: true }).click();
    await choose(page, panel, "Condition 1 column", "Score (Number)");
    await panel.getByLabel("Condition 1 value").fill("abc");
    await panel.getByRole("button", { name: "Apply" }).click();
    await expect(panel.getByRole("alert")).toContainText("is not a number");
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Cancel" }).click();
    await expect(panel).toBeHidden();
  });

  test.describe("at 390x844", () => {
    test.use(MOBILE_DARK);

    test("the panel fits the phone and applies", async ({ page }) => {
      await signInAdmin(page);
      const seeded = await seedGrid(page.request, { rows: 30, name: "G3 filter phone" });
      await page.goto(`/tables/${seeded.workbookId}`);
      await expect(page.getByText("30 rows", { exact: true })).toBeVisible();
      const panel = await openPanel(page);
      await panel.getByRole("button", { name: "Add condition", exact: true }).click();
      await choose(page, panel, "Condition 1 column", "Score (Number)");
      await choose(page, panel, "Condition 1 operator", "greater than");
      await panel.getByLabel("Condition 1 value").fill("25");
      await expectNoHorizontalOverflow(page);
      await panel.getByRole("button", { name: "Apply" }).scrollIntoViewIfNeeded();
      await panel.getByRole("button", { name: "Apply" }).click();
      await expect(page.getByText("5 rows of 30", { exact: true })).toBeVisible();
    });
  });
});

const PEOPLE = [["Full name", "Domain"], ...Array.from({ length: 12 }, (_, i) => [`Pat${i + 1} Lee`, `d${i + 1}.test`])];

/** A 12-row table with a fake-provider find-email column. Returns the page ready to use. */
async function runnableTable(page: Page, name: string) {
  const { workbookId, tableId } = await newWorkbook(page.request, name);
  await importCsv(page.request, tableId, PEOPLE);
  const providerKey = `g3-${Math.random().toString(36).slice(2, 7)}`;
  const provider = await page.request.post("/api/grid/providers", { data: { adapter: "fake", key: providerKey, name: "G3 fake finder", credentials: { apiKey: "g3-key" } } });
  expect(provider.status(), "connect fake provider").toBe(201);
  const { columns } = await gridPage(page.request, tableId);
  const keyOf = (n: string) => columns.find((c) => c.name === n)!.key;
  const added = await page.request.post(`/api/grid/tables/${tableId}/enrichments`, {
    data: { kind: "enrichment", providerKey, actionKey: "find-email", inputs: { fullName: keyOf("Full name"), companyDomain: keyOf("Domain") }, selectedOutputs: ["email"], afterColumnId: columns[columns.length - 1].id },
  });
  expect(added.status(), "add enrichment column").toBe(201);
  // Auto-run would queue every row on its own; the scenarios press Run themselves.
  const off = await page.request.patch(`/api/grid/tables/${tableId}`, { data: { autoRun: false } });
  expect(off.status(), "turn auto-run off").toBe(200);
  const after = (await gridPage(page.request, tableId)).columns;
  const emailKey = after.find((c: GridColumnJson) => c.name === "Email")!.key;
  const source = after.find((c: GridColumnJson) => c.type === "enrichment")!;
  const filled = async () => {
    const rows = (await gridPage(page.request, tableId)).rows;
    return rows.map((r, i) => (r.cells[emailKey] ? i + 1 : 0)).filter(Boolean);
  };
  await page.goto(`/tables/${workbookId}`);
  await expect(page.getByRole("gridcell", { name: "Full name: Pat12 Lee" })).toBeVisible();
  return { workbookId, tableId, emailKey, source, filled };
}

test.describe("partial runs", () => {
  test("runs the first N rows in table order, then the next N after the empty-cells filter", async ({ page }) => {
    await signInAdmin(page);
    const t = await runnableTable(page, "G3 first N");

    await page.getByRole("button", { name: `Column menu for ${t.source.name}` }).click();
    await page.getByRole("menuitem", { name: "Run first 10 rows" }).click();
    const dialog = page.getByRole("dialog", { name: `Run ${t.source.name}` });
    await expect(dialog.getByLabel("Number of first rows")).toHaveValue("10");
    await expect(dialog.getByRole("radio", { name: /^First/ })).toBeChecked();

    // A bad count is refused in the dialog, before any request.
    await dialog.getByLabel("Number of first rows").fill("0");
    await dialog.getByRole("button", { name: /^Run( [\d,]+ rows?)?$/ }).click();
    await expect(dialog.getByRole("alert")).toContainText("whole number");
    await dialog.getByLabel("Number of first rows").fill("3");
    await dialog.getByRole("button", { name: /^Run( [\d,]+ rows?)?$/ }).click();
    await expect(page.getByText(/Queued 3 cells across 3 rows/)).toBeVisible();
    await settle(page.request, t.tableId);
    expect(await t.filled()).toEqual([1, 2, 3]);

    // Again with the same count: rows 1 to 3 are filled and skipped, so rows 4 to 6 run.
    await page.getByRole("button", { name: `Column menu for ${t.source.name}` }).click();
    await page.getByRole("menuitem", { name: "Run first 10 rows" }).click();
    const again = page.getByRole("dialog", { name: `Run ${t.source.name}` });
    await again.getByLabel("Number of first rows").fill("3");
    await again.getByRole("button", { name: /^Run( [\d,]+ rows?)?$/ }).click();
    await expect(page.getByText(/Queued 3 cells across 3 rows/)).toBeVisible();
    await settle(page.request, t.tableId);
    expect(await t.filled()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("runs one output cell from the keyboard and from the cell's run button", async ({ page }) => {
    await signInAdmin(page);
    const t = await runnableTable(page, "G3 run cell");

    // Keyboard only: focus the grid by clicking a name cell, then arrow to the Email cell of row 8 and press Ctrl or Cmd+Enter.
    await page.getByRole("gridcell", { name: "Full name: Pat8 Lee", exact: true }).click();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.mouse.move(0, 0);
    await expect(page.getByRole("button", { name: "Run this cell" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByText(/Running .* for this row/)).toBeVisible();
    await settle(page.request, t.tableId);
    expect(await t.filled()).toEqual([8]);

    // The button of the active cell, without a keyboard: click the Email cell of row 11, then its run button.
    await page.getByRole("gridcell", { name: "Full name: Pat11 Lee", exact: true }).click();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: "Run this cell" }).click();
    await settle(page.request, t.tableId);
    expect(await t.filled()).toEqual([8, 11]);

    // A typed cell has no run: Ctrl or Cmd+Enter does not start one, and the button is absent.
    await page.getByRole("gridcell", { name: "Full name: Pat2 Lee", exact: true }).click();
    await expect(page.getByRole("button", { name: "Run this cell" })).toHaveCount(0);
  });

  test.describe("at 390x844", () => {
    test.use(MOBILE_DARK);

    test("the run dialog and the cell run button fit the phone", async ({ page }) => {
      await signInAdmin(page);
      const t = await runnableTable(page, "G3 run phone");
      await page.getByRole("button", { name: "Run", exact: true }).first().click();
      const dialog = page.getByRole("dialog", { name: "Run enrichments" });
      await dialog.getByLabel("Number of first rows").fill("2");
      await expectNoHorizontalOverflow(page);
      await dialog.getByRole("button", { name: /^Run( [\d,]+ rows?)?$/ }).click();
      await expect(page.getByText(/Queued 2 cells across 2 rows/)).toBeVisible();
      await settle(page.request, t.tableId);
      expect(await t.filled()).toEqual([1, 2]);
    });
  });
});

test.describe("AI column output types and editing", () => {
  test("an email field is filled and checked, a field is added by editing, and retyping a filled field is refused", async ({ page, watch }) => {
    // The refused retype answers 422 on purpose.
    watch.tolerate(/response 422: PATCH .*\/ai/, /status of 422/);
    await signInAdmin(page);
    const { workbookId, tableId } = await newWorkbook(page.request, "G3 AI types");
    await importCsv(page.request, tableId, [["Full name"], ["Ann Lee"], ["Bob Ray"]]);
    const key = (await gridPage(page.request, tableId)).columns.find((c) => c.name === "Full name")!.key;
    await page.goto(`/tables/${workbookId}`);
    await expect(page.getByRole("gridcell", { name: "Full name: Bob Ray" })).toBeVisible();

    await page.getByRole("button", { name: "Add column" }).click();
    await page.getByRole("menuitem", { name: "AI column" }).click();
    const add = page.getByRole("dialog", { name: "Add AI column" });
    await add.getByLabel("Column name").fill("Contact");
    await add.getByLabel("Prompt").fill(`Find the work email of {{${key}}}.`);
    await add.getByLabel("Field key").fill("mail");
    await choose(page, add, "Field type", "Email");
    await add.getByRole("button", { name: "Add without running" }).click();
    await expect(page.getByRole("columnheader", { name: /mail/ })).toBeVisible();

    await page.getByRole("button", { name: "Run", exact: true }).first().click();
    await page.getByRole("dialog", { name: "Run enrichments" }).getByRole("button", { name: /^Run( [\d,]+ rows?)?$/ }).click();
    await expect(page.getByText(/Queued 2 cells across 2 rows/)).toBeVisible();
    await settle(page.request, tableId);
    await expect(page.getByRole("gridcell", { name: "mail: fake@example.test" }).first()).toBeVisible({ timeout: 20_000 });
    const mailType = (await gridPage(page.request, tableId)).columns.find((c) => c.name === "mail")!;
    expect(mailType.type).toBe("ai_output");

    // Edit the column: add a URL field. The email field keeps its column and values.
    await page.getByRole("button", { name: "Column menu for Contact" }).click();
    await page.getByRole("menuitem", { name: "Edit settings" }).click();
    const edit = page.getByRole("dialog", { name: "Edit Contact" });
    await edit.getByRole("button", { name: "Add field" }).click();
    await edit.getByLabel("Field key").nth(1).fill("site");
    // The second output field, the one just added.
    await edit.getByRole("combobox", { name: "Field type", exact: true }).nth(1).click();
    await page.getByRole("option", { name: "URL", exact: true }).click();
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toBeHidden();
    await expect(page.getByRole("columnheader", { name: /site/ })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "mail: fake@example.test" }).first()).toBeVisible();

    // Retyping the filled email field is refused and nothing changes.
    await page.getByRole("button", { name: "Column menu for Contact" }).click();
    await page.getByRole("menuitem", { name: "Edit settings" }).click();
    const again = page.getByRole("dialog", { name: "Edit Contact" });
    await again.getByRole("combobox", { name: "Field type", exact: true }).first().click();
    await page.getByRole("option", { name: "Text", exact: true }).click();
    await again.getByRole("button", { name: "Save" }).click();
    await expect(again.getByRole("alert")).toContainText("already has values");
    await again.getByRole("button", { name: "Cancel" }).click();
    const stored = (await gridPage(page.request, tableId)).columns.find((c) => c.name === "mail")!;
    expect(stored.type).toBe("ai_output");
  });
});
