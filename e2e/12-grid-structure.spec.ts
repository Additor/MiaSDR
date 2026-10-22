import { expect, signInAdmin, test } from "./support/fixtures";
import { gridPage, importCsv, newWorkbook, xlsxFile } from "./support/grid";

test.describe("grid structure", () => {
  test("an XLSX file imports into a table through the wizard", async ({ page }) => {
    await signInAdmin(page);
    const { workbookId } = await newWorkbook(page.request, "C2 xlsx import");
    await page.goto(`/tables/${workbookId}`);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: "Import file" }).click();
    await page.getByLabel("File to import").setInputFiles(
      xlsxFile("c2-leads.xlsx", [
        ["Email", "Company", "Seats"],
        ["xia@c2-xlsx.test", "Xenon", 12],
        ["yan@c2-xlsx.test", "Yarrow", 40],
        ["zed@c2-xlsx.test", "Zephyr", 7],
      ]),
    );
    const dialog = page.getByRole("dialog", { name: "Import a file" });
    await expect(dialog.getByText("3 rows, 3 columns.")).toBeVisible();
    await expect(dialog.getByText("xia@c2-xlsx.test")).toBeVisible();
    await dialog.getByRole("button", { name: "Import 3 rows" }).click();
    await expect(page.getByText(/Imported 3 rows/)).toBeVisible();
    await expect(page.getByText("3 rows", { exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Email: yan@c2-xlsx.test" })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Company: Zephyr" })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Seats: 40" })).toBeVisible();
  });

  test("several tables are created and reordered, and the order sticks", async ({ page }) => {
    await signInAdmin(page);
    const { workbookId } = await newWorkbook(page.request, "C2 tabs");
    await page.goto(`/tables/${workbookId}`);
    const tabs = page.getByRole("tablist", { name: "Tables" }).getByRole("tab");
    await expect(tabs).toHaveText(["Custom Table"]);

    for (const name of ["Second", "Third"]) {
      // A new table opens with its tab in rename.
      await page.getByRole("button", { name: "New table" }).click();
      await page.getByRole("textbox", { name: "Table name" }).fill(name);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("tab", { name, selected: true })).toBeVisible();
    }
    await expect(tabs).toHaveText(["Custom Table", "Second", "Third"]);

    // Move through the tab menu, then with the keyboard.
    await page.getByRole("button", { name: "Actions for Third" }).click();
    await page.getByRole("menuitem", { name: "Move left" }).click();
    await expect(tabs).toHaveText(["Custom Table", "Third", "Second"]);
    await page.getByRole("tab", { name: "Second" }).focus();
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(tabs).toHaveText(["Custom Table", "Second", "Third"]);
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(tabs).toHaveText(["Second", "Custom Table", "Third"]);

    // Drag the last tab to the front.
    await page.getByRole("tab", { name: "Third" }).dragTo(page.getByRole("tab", { name: "Second" }));
    await expect(tabs).toHaveText(["Third", "Second", "Custom Table"]);

    await page.reload();
    await expect(tabs).toHaveText(["Third", "Second", "Custom Table"]);
    await page.getByRole("tab", { name: "Custom Table" }).click();
    await expect(page.getByRole("tab", { name: "Custom Table", selected: true })).toBeVisible();
    await expect(page.getByRole("grid", { name: "Custom Table" })).toBeVisible();
  });

  test("the workbook and a tab rename in place; an empty name is refused and Escape keeps the old one", async ({ page }) => {
    await signInAdmin(page);
    const { workbookId } = await newWorkbook(page.request, "C2 rename");
    await page.goto(`/tables/${workbookId}`);

    const title = page.getByRole("heading", { name: "C2 rename" }).getByRole("button");
    await title.click();
    const field = page.getByRole("textbox", { name: "Workbook name" });
    await field.fill("");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "Give it a name." })).toBeVisible();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "C2 rename" })).toBeVisible();

    await page.getByRole("heading", { name: "C2 rename" }).getByRole("button").click();
    await field.fill("C2 renamed");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "C2 renamed" }).getByRole("button")).toBeFocused();
    await expect(page).toHaveTitle("C2 renamed · MiaSDR");

    await page.getByRole("tab", { name: "Custom Table" }).focus();
    await page.keyboard.press("F2");
    await page.getByRole("textbox", { name: "Table name" }).fill("Leads");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Leads" })).toBeFocused();

    await page.reload();
    await expect(page.getByRole("heading", { name: "C2 renamed" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Leads" })).toBeVisible();
  });

  test("a column is resized by dragging and hidden from its menu, and the hidden state sticks", async ({ page }) => {
    await signInAdmin(page);
    const { workbookId, tableId } = await newWorkbook(page.request, "C2 columns");
    await importCsv(page.request, tableId, [
      ["Email", "Company", "Title"],
      ["kai@c2-cols.test", "Kestrel", "CEO"],
    ]);
    await page.goto(`/tables/${workbookId}`);
    const company = page.getByRole("columnheader", { name: /^Company/ });
    await expect(company).toBeVisible();

    // The resize handle sits at the right edge of the header.
    const handle = company.getByRole("separator", { name: "Resize Company" });
    const before = (await company.boundingBox())!;
    const edge = (await handle.boundingBox())!;
    const x = edge.x + edge.width / 2;
    const y = edge.y + edge.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 80, y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await company.boundingBox())!.width)).toBe(Math.round(before.width + 80));

    // Dragging the other way narrows it, down to a floor.
    const edge2 = (await handle.boundingBox())!;
    await page.mouse.move(edge2.x + edge2.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(edge2.x - 1000, y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await company.boundingBox())!.width)).toBe(60);

    // Hide the column from its menu.
    await page.getByRole("button", { name: "Column menu for Company" }).click();
    // The column disappears at once and the view is saved a moment later. Reloading before that save lands loses it.
    const saved = page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/grid\/tables\/[^/]+\/view$/.test(r.url()));
    await page.getByRole("menuitem", { name: "Hide column" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByRole("columnheader", { name: /^Company/ })).toHaveCount(0);
    await expect(page.getByRole("gridcell", { name: "Company: Kestrel" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Columns (1 hidden)" })).toBeVisible();

    // The choice belongs to this person and survives a reload.
    await page.reload();
    await expect(page.getByRole("gridcell", { name: "Title: CEO" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /^Company/ })).toHaveCount(0);
    expect((await gridPage(page.request, tableId)).view.hiddenColumns).toEqual(["company"]);

    // Show it again from the Columns menu.
    await page.getByRole("button", { name: "Columns (1 hidden)" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Company" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("gridcell", { name: "Company: Kestrel" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Columns", exact: true })).toBeVisible();
  });
});
