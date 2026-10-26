import type { Page } from "@playwright/test";
import { expect, signInAdmin, test } from "./support/fixtures";
import { gridPage } from "./support/grid";
import { SEED_HEADERS, seedGrid, type SeededGrid } from "./support/grid-seed";

/**
 * Edit gestures: undo and redo by key and by toolbar button, one undo
 * step for a pasted block, another person's edit surviving an undo, copy of a formula-looking cell.
 * Logic is unit tested; these steps cover what only a browser can: key events, the clipboard and the toolbar.
 */
const MOD = "ControlOrMeta";

async function open(page: Page, name: string, rows = 30): Promise<SeededGrid> {
  await signInAdmin(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const seeded = await seedGrid(page.request, { rows, name });
  await page.goto(`/tables/${seeded.workbookId}`);
  await expect(page.getByRole("gridcell", { name: "Name: Person 1", exact: true })).toBeVisible();
  return seeded;
}

const nameOf = async (page: Page, seeded: SeededGrid, row = 0) => (await gridPage(page.request, seeded.tableId)).rows[row].cells[seeded.keys.Name];

/**
 * Specs 27, 28 and 29 share the seed helper. This check runs first, so a broken helper fails under its own name
 * and not inside a gesture test.
 */
test.describe("grid seed helper", () => {
  test("seeds typed columns, a Korean header and a formula, and the grid shows them", async ({ page }) => {
    await signInAdmin(page);
    const seeded = await seedGrid(page.request, { rows: 120, name: "T7b seed smoke" });

    const data = await gridPage(page.request, seeded.tableId);
    expect(data.total).toBe(120);
    const typeOf = (name: string) => data.columns.find((c) => c.name === name)?.type;
    expect([...SEED_HEADERS].map(typeOf)).toEqual(["text", "email", "number", "date", "boolean", "url", "text"]);
    expect(typeOf("Score x2")).toBe("formula");
    const first = data.rows[0].cells;
    expect(first[seeded.keys.Name]).toBe(seeded.expected(0).Name);
    expect(first[seeded.keys["회사"]]).toBe("회사 0");
    expect(Number(first[seeded.keys["Score x2"]])).toBe(2);

    await page.goto(`/tables/${seeded.workbookId}`);
    await expect(page.getByText("120 rows", { exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Name: Person 1", exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "회사: 회사 0", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Score x2: 2", exact: true })).toBeVisible();
  });
});

test.describe("grid undo and redo", () => {
  test("Ctrl/Cmd+Z, Shift+Z and Y step through a typed edit, and the formula follows", async ({ page }) => {
    const seeded = await open(page, "S27 undo keys");
    const score = page.getByRole("gridcell", { name: /^Score: 1$/ });
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();

    await page.getByRole("gridcell", { name: "Name: Person 1", exact: true }).click();
    await page.keyboard.type("Edited");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("gridcell", { name: "Name: Edited", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();

    await page.getByRole("gridcell", { name: "Name: Edited", exact: true }).click();
    await page.keyboard.press(`${MOD}+z`);
    await expect(page.getByRole("gridcell", { name: "Name: Person 1", exact: true })).toBeVisible();
    expect(await nameOf(page, seeded)).toBe("Person 1");
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();

    await page.keyboard.press(`${MOD}+Shift+z`);
    await expect(page.getByRole("gridcell", { name: "Name: Edited", exact: true })).toBeVisible();
    expect(await nameOf(page, seeded)).toBe("Edited");

    await page.keyboard.press(`${MOD}+z`);
    await expect(page.getByRole("gridcell", { name: "Name: Person 1", exact: true })).toBeVisible();
    await page.keyboard.press(`${MOD}+y`);
    await expect(page.getByRole("gridcell", { name: "Name: Edited", exact: true })).toBeVisible();

    // A number edit moves the formula column, and undo moves it back.
    await expect(score).toBeVisible();
    await score.click();
    await page.keyboard.type("50");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("gridcell", { name: "Score x2: 100", exact: true })).toBeVisible();
    await page.getByRole("gridcell", { name: "Score: 50", exact: true }).click();
    await page.keyboard.press(`${MOD}+z`);
    await expect(page.getByRole("gridcell", { name: "Score x2: 2", exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Score: 1", exact: true })).toBeVisible();
  });

  test("the toolbar buttons undo and redo, and disable at the ends", async ({ page }) => {
    const seeded = await open(page, "S27 undo buttons");
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const redo = page.getByRole("button", { name: "Redo", exact: true });
    await page.getByRole("gridcell", { name: "Name: Person 2", exact: true }).click();
    await page.keyboard.press("Delete");
    await expect(page.getByRole("gridcell", { name: "Name: empty", exact: true })).toBeVisible();

    await undo.click();
    await expect(page.getByRole("gridcell", { name: "Name: Person 2", exact: true })).toBeVisible();
    await expect(undo).toBeDisabled();
    await expect(redo).toBeEnabled();
    expect(await nameOf(page, seeded, 1)).toBe("Person 2");

    await redo.click();
    await expect(page.getByRole("gridcell", { name: "Name: empty", exact: true })).toBeVisible();
    await expect(redo).toBeDisabled();
    expect(await nameOf(page, seeded, 1)).toBeNull();
  });

  test("a pasted block is one undo step and one redo step", async ({ page }) => {
    const seeded = await open(page, "S27 undo paste");
    await page.evaluate((text) => navigator.clipboard.writeText(text), "Ann\tann@x.test\nBob\tbob@x.test\nCy\tcy@x.test");
    await page.getByRole("gridcell", { name: "Name: Person 1", exact: true }).click();
    await page.keyboard.press(`${MOD}+v`);
    await expect(page.getByRole("gridcell", { name: "Name: Cy", exact: true })).toBeVisible();
    const pasted = await gridPage(page.request, seeded.tableId);
    expect(pasted.rows.slice(0, 3).map((r) => [r.cells[seeded.keys.Name], r.cells[seeded.keys.Email]])).toEqual([["Ann", "ann@x.test"], ["Bob", "bob@x.test"], ["Cy", "cy@x.test"]]);

    await page.keyboard.press(`${MOD}+z`);
    await expect(page.getByRole("gridcell", { name: "Name: Person 3", exact: true })).toBeVisible();
    const undone = await gridPage(page.request, seeded.tableId);
    expect(undone.rows.slice(0, 3).map((r) => [r.cells[seeded.keys.Name], r.cells[seeded.keys.Email]])).toEqual([["Person 1", "person1@seed.test"], ["Person 2", "person2@seed.test"], ["Person 3", "person3@seed.test"]]);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();

    await page.keyboard.press(`${MOD}+Shift+z`);
    await expect(page.getByRole("gridcell", { name: "Name: Cy", exact: true })).toBeVisible();
    expect((await gridPage(page.request, seeded.tableId)).rows[2].cells[seeded.keys.Email]).toBe("cy@x.test");
  });

  test("an undo leaves a cell someone else changed afterwards", async ({ page }) => {
    const seeded = await open(page, "S27 undo conflict");
    await page.getByRole("gridcell", { name: "Name: Person 1", exact: true }).click();
    await page.keyboard.type("Mine");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("gridcell", { name: "Name: Mine", exact: true })).toBeVisible();
    await expect(page.getByText("Saving")).toHaveCount(0);

    const rowId = (await gridPage(page.request, seeded.tableId)).rows[0].id;
    const theirs = await page.request.patch(`/api/grid/tables/${seeded.tableId}/cells`, { data: { updates: [{ rowId, columnKey: seeded.keys.Name, value: "Theirs" }] } });
    expect(theirs.status()).toBe(200);

    await page.getByRole("gridcell", { name: "Name: Mine", exact: true }).click();
    await page.keyboard.press(`${MOD}+z`);
    await expect(page.getByText(/left as it is/)).toBeVisible();
    expect(await nameOf(page, seeded)).toBe("Theirs");
  });

  test("deleting a column clears the history", async ({ page }) => {
    await open(page, "S27 undo columns");
    await page.getByRole("gridcell", { name: "Name: Person 1", exact: true }).click();
    await page.keyboard.type("Typed");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();

    await page.getByRole("button", { name: "Column menu for Site" }).click();
    await page.getByRole("menuitem", { name: "Delete column" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete column" }).click();
    await expect(page.getByRole("columnheader", { name: /^Site/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  });
});

test.describe("grid copy", () => {
  test("copy prefixes a formula-looking text cell, keeps numbers plain, and paste restores the text", async ({ page }) => {
    const seeded = await open(page, "S27 copy");
    const first = (await gridPage(page.request, seeded.tableId)).rows;
    const write = await page.request.patch(`/api/grid/tables/${seeded.tableId}/cells`, {
      data: { updates: [{ rowId: first[0].id, columnKey: seeded.keys.Name, value: "=1+1" }, { rowId: first[1].id, columnKey: seeded.keys.Name, value: "-5" }, { rowId: first[0].id, columnKey: seeded.keys.Score, value: -5 }] },
    });
    expect(write.status()).toBe(200);
    await page.reload();
    await expect(page.getByRole("gridcell", { name: "Name: =1+1", exact: true })).toBeVisible();

    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
    await page.getByRole("gridcell", { name: "Name: =1+1", exact: true }).click();
    await page.keyboard.press(`${MOD}+c`);
    expect(await clipboard()).toBe("'=1+1");

    await page.getByRole("gridcell", { name: "Name: -5", exact: true }).click();
    await page.keyboard.press(`${MOD}+c`);
    expect(await clipboard()).toBe("'-5");

    await page.getByRole("gridcell", { name: "Score: -5", exact: true }).click();
    await page.keyboard.press(`${MOD}+c`);
    expect(await clipboard()).toBe("-5");

    // Copy the formula-looking text, paste it into another row: the apostrophe is not stored.
    await page.getByRole("gridcell", { name: "Name: =1+1", exact: true }).click();
    await page.keyboard.press(`${MOD}+c`);
    await page.getByRole("gridcell", { name: "Name: Person 3", exact: true }).click();
    await page.keyboard.press(`${MOD}+v`);
    await expect(page.getByRole("gridcell", { name: "Name: =1+1", exact: true })).toHaveCount(2);
    // The grid shows the edit before the save returns, so poll the stored value.
    await expect.poll(async () => (await gridPage(page.request, seeded.tableId)).rows[2].cells[seeded.keys.Name]).toBe("=1+1");
  });
});

test.describe("grid paste past the end", () => {
  test("a block past the last row and column adds rows and a column, and one undo restores the values", async ({ page }) => {
    const seeded = await open(page, "S27 paste grow");
    const site = (n: number) => seeded.expected(n - 1).Site;
    await page.evaluate((text) => navigator.clipboard.writeText(text), "a1\tb1\tc1\td1\na2\tb2\tc2\td2\na3\tb3\tc3\td3");
    await page.getByRole("gridcell", { name: `Site: ${site(1)}`, exact: true }).click();
    await page.keyboard.press(`${MOD}+ArrowDown`);
    await page.keyboard.press(`${MOD}+v`);
    await expect(page.getByText(/added 2 rows and 1 column/)).toBeVisible();
    await expect(page.getByText("Skipped 3 cells in formula columns (they recalculate).")).toBeVisible();
    // The grid keeps its scroll position at the paste instead of jumping back toward the first page of rows.
    await expect(page.getByRole("gridcell", { name: "Site: a1", exact: true })).toBeVisible();

    const grown = await gridPage(page.request, seeded.tableId);
    expect(grown.unfilteredTotal).toBe(32);
    expect(grown.columns).toHaveLength(9);
    const extra = grown.columns[8];
    expect(extra.name).toBe("Column 9");
    const cell = (row: number, key: string) => grown.rows[row].cells[key];
    expect([29, 30, 31].map((i) => cell(i, seeded.keys.Site))).toEqual(["a1", "a2", "a3"]);
    expect([29, 30, 31].map((i) => cell(i, seeded.keys["회사"]))).toEqual(["b1", "b2", "b3"]);
    expect([29, 30, 31].map((i) => cell(i, extra.key))).toEqual(["d1", "d2", "d3"]);
    // The formula column was skipped, not overwritten.
    expect(cell(29, seeded.keys["Score x2"])).toBe(60);

    // Undo restores the values. The rows and the column the paste created stay.
    await page.getByRole("gridcell", { name: "Site: a1", exact: true }).click();
    await page.keyboard.press(`${MOD}+z`);
    await expect(page.getByRole("gridcell", { name: `Site: ${site(30)}`, exact: true })).toBeVisible();
    const undone = await gridPage(page.request, seeded.tableId);
    expect(undone.unfilteredTotal).toBe(32);
    expect(undone.columns).toHaveLength(9);
    expect(undone.rows[29].cells[seeded.keys.Site]).toBe(site(30));
    expect(undone.rows[30].cells[seeded.keys.Site] ?? null).toBeNull();
    expect(undone.rows[31].cells[extra.key] ?? null).toBeNull();
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();

    await page.keyboard.press(`${MOD}+Shift+z`);
    await expect.poll(async () => (await gridPage(page.request, seeded.tableId)).rows[31].cells[seeded.keys.Site]).toBe("a3");
  });

  test("a filtered view refuses a paste that would add rows", async ({ page }) => {
    const seeded = await open(page, "S27 paste filtered");
    const view = { filters: { conjunction: "and", conditions: [{ columnKey: seeded.keys.Name, operator: "contains", value: "Person 1" }] } };
    const saved = await page.request.patch(`/api/grid/tables/${seeded.tableId}`, { data: { view } });
    expect(saved.status()).toBe(200);
    await page.reload();
    await expect(page.getByRole("gridcell", { name: "Name: Person 19", exact: true })).toBeVisible();

    await page.evaluate((text) => navigator.clipboard.writeText(text), "x\ny\nz");
    await page.getByRole("gridcell", { name: "Name: Person 1", exact: true }).click();
    await page.keyboard.press(`${MOD}+ArrowDown`);
    await page.keyboard.press(`${MOD}+v`);
    await expect(page.getByText(/filtered, sorted or searched, so a paste cannot add rows/)).toBeVisible();
    expect((await gridPage(page.request, seeded.tableId)).unfilteredTotal).toBe(30);
  });
});

test.describe("grid pinned columns", () => {
  test("pinned columns lead the grid, stay in view while it scrolls sideways, and phone width ignores them", async ({ page }) => {
    const seeded = await open(page, "S27 pin");
    const headers = () => page.getByRole("columnheader").evaluateAll((els) => els.map((el) => (el.querySelector("span")?.textContent ?? "").trim()));

    await page.getByRole("button", { name: "Column menu for Score", exact: true }).click();
    await page.getByRole("menuitem", { name: "Pin column" }).click();
    await expect.poll(headers).toEqual(expect.arrayContaining(["Score"]));
    await expect.poll(async () => (await headers())[1]).toBe("Score");
    await page.getByRole("button", { name: "Column menu for Site" }).click();
    await page.getByRole("menuitem", { name: "Pin column" }).click();
    await expect.poll(async () => (await headers()).slice(1, 3)).toEqual(["Score", "Site"]);

    // The pin reached storage as this member's own view.
    const stored = await (await page.request.get(`/api/grid/tables/${seeded.tableId}`)).json();
    expect(stored.view.pinnedColumns).toEqual([seeded.keys.Score, seeded.keys.Site]);

    const grid = page.getByRole("grid");
    const left = (name: string) => page.getByRole("columnheader", { name: new RegExp(`^${name}(?! x2)`) }).evaluate((el) => el.getBoundingClientRect().left);
    const gridLeft = await grid.evaluate((el) => el.getBoundingClientRect().left);
    const pinnedBefore = await left("Score");
    const nameBefore = await left("Name");
    await grid.evaluate((el) => {
      el.scrollLeft = 400;
    });
    await expect.poll(() => grid.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    expect(await left("Score")).toBeCloseTo(pinnedBefore, 0);
    expect(await left("Site")).toBeGreaterThanOrEqual(gridLeft + 72);
    expect(await left("Name")).toBeLessThan(nameBefore);

    // Keyboard order follows the shown order: Right from the first pinned cell reaches the second pinned column.
    await grid.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await page.getByRole("gridcell", { name: "Score: 1", exact: true }).click();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveAttribute("aria-label", /^Site:/);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole("gridcell", { name: "Name: Person 1", exact: true })).toBeVisible();
    expect((await headers())[1]).toBe("Name");

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await page.getByRole("button", { name: "Column menu for Score", exact: true }).click();
    await page.getByRole("menuitem", { name: "Unpin column" }).click();
    await expect.poll(async () => (await headers())[1]).toBe("Site");
    expect((await headers()).slice(1, 3)).toEqual(["Site", "Name"]);
  });
});

test.describe("grid fill handle", () => {
  test("dragging the corner copies the selection down, skips a formula column, and undoes as one step", async ({ page }) => {
    const seeded = await open(page, "S27 fill");
    const row1 = seeded.expected(0);
    await page.getByRole("gridcell", { name: `Site: ${row1.Site}`, exact: true }).click();
    await page.getByRole("gridcell", { name: "Score x2: 2", exact: true }).click({ modifiers: ["Shift"] });

    const handle = page.locator("[data-fill-handle]");
    await expect(handle).toHaveCount(1);
    const from = (await handle.boundingBox())!;
    const target = (await page.getByRole("gridcell", { name: `Site: ${seeded.expected(2).Site}`, exact: true }).boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 20, target.y + target.height / 2, { steps: 6 });
    await page.mouse.up();

    await expect.poll(async () => (await gridPage(page.request, seeded.tableId)).rows.slice(0, 3).map((r) => r.cells[seeded.keys.Site])).toEqual([row1.Site, row1.Site, row1.Site]);
    const filled = (await gridPage(page.request, seeded.tableId)).rows;
    expect(filled.slice(0, 3).map((r) => r.cells[seeded.keys["회사"]])).toEqual([row1["회사"], row1["회사"], row1["회사"]]);
    // The formula column is not a fill target: its rows still follow their own Score.
    expect(filled.slice(0, 3).map((r) => Number(r.cells[seeded.keys["Score x2"]]))).toEqual([2, 4, 6]);

    await page.getByRole("gridcell", { name: `Site: ${row1.Site}`, exact: true }).first().click();
    await page.keyboard.press(`${MOD}+z`);
    await expect.poll(async () => (await gridPage(page.request, seeded.tableId)).rows[2].cells[seeded.keys.Site]).toBe(seeded.expected(2).Site);
    expect((await gridPage(page.request, seeded.tableId)).rows[1].cells[seeded.keys.Site]).toBe(seeded.expected(1).Site);
  });
});
