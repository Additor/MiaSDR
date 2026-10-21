import { expect, signInAdmin, test } from "./support/fixtures";
import { cellValue, gridPage, importCsv, jobCounts, newWorkbook, settle } from "./support/grid";

const PEOPLE = [
  ["Full name", "Domain", "Company"],
  ["Ann Lee", "acme.test", "Acme"],
  ["Boom Bob", "beta.test", "Beta"],
  ["Nohit Nan", "gamma.test", "Gamma"],
];

test.describe("grid runs", () => {
  test("a failed enrichment cell is retried after its input is fixed", async ({ page, watch }) => {
    watch.tolerate(/response 404: .*\/changes/);
    await signInAdmin(page);
    const { workbookId, tableId } = await newWorkbook(page.request, "C2 enrichment");
    await importCsv(page.request, tableId, PEOPLE);

    const provider = await page.request.post("/api/grid/providers", { data: { adapter: "fake", key: "c2-fake", name: "C2 fake finder", credentials: { apiKey: "c2-key" } } });
    expect(provider.status(), "connect fake provider").toBe(201);
    const { columns } = await gridPage(page.request, tableId);
    const keyOf = (name: string) => columns.find((c) => c.name === name)!.key;
    const added = await page.request.post(`/api/grid/tables/${tableId}/enrichments`, {
      data: {
        kind: "enrichment",
        providerKey: "c2-fake",
        actionKey: "find-email",
        inputs: { fullName: keyOf("Full name"), companyDomain: keyOf("Domain") },
        selectedOutputs: ["email"],
        afterColumnId: columns[columns.length - 1].id,
      },
    });
    expect(added.status(), "add enrichment column").toBe(201);

    await page.goto(`/tables/${workbookId}`);
    await expect(page.getByRole("gridcell", { name: "Full name: Boom Bob" })).toBeVisible();

    // Run the whole table. The jobs run on the job tick.
    await page.getByRole("button", { name: "Run", exact: true }).first().click();
    const run = page.getByRole("dialog", { name: "Run enrichments" });
    await run.getByRole("button", { name: /^Run( [\d,]+ rows?)?$/ }).click();
    await expect(page.getByText(/Queued 3 cells across 3 rows/)).toBeVisible();
    await settle(page.request, tableId);
    expect((await jobCounts(page.request, tableId)).failed).toBe(1);

    // One hit, one miss and one failure. The progress bar offers a retry of the failure.
    const progress = page.getByRole("status").filter({ hasText: "1 failed" });
    await expect(progress).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("gridcell", { name: "Email: ann.lee@acme.test", exact: true })).toBeVisible();
    await expect(page.getByLabel("The fake provider rejected this request.")).toBeVisible();

    // With auto-run on, editing an input queues the cell again by itself. Turn it off so the retry button does the work.
    await page.getByRole("button", { name: "Run settings" }).click();
    const autoRun = page.getByRole("menuitemcheckbox", { name: "Auto-run new and edited rows" });
    await expect(autoRun).toBeChecked();
    await autoRun.click();
    await page.keyboard.press("Escape");

    // Retrying without a fix fails the same way.
    await progress.getByRole("button", { name: "Retry failed" }).click();
    await expect(page.getByText("Retrying 1 failed cell.")).toBeVisible();
    await settle(page.request, tableId);
    expect((await jobCounts(page.request, tableId)).failed).toBe(1);
    await expect(progress).toBeVisible();

    // Fix the name, then retry. The run changed the row since the page loaded, so load it again before editing.
    await page.reload();
    await expect(page.getByLabel("The fake provider rejected this request.")).toBeVisible();
    await page.getByRole("gridcell", { name: "Full name: Boom Bob" }).click();
    await page.keyboard.type("Bob Ray");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("gridcell", { name: "Full name: Bob Ray" })).toBeVisible();
    await progress.getByRole("button", { name: "Retry failed" }).click();
    await expect(page.getByText("Retrying 1 failed cell.")).toBeVisible();
    await settle(page.request, tableId);
    expect(await cellValue(page.request, tableId, "Full name", "Bob Ray", "Email")).toBe("bob.ray@beta.test");
    await expect(page.getByRole("gridcell", { name: "Email: bob.ray@beta.test", exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("status").filter({ hasText: "failed" })).toHaveCount(0);
  });

  test("a verification waterfall starts from a preset that lines up every verifier", async ({ page }) => {
    await signInAdmin(page);
    const { workbookId, tableId } = await newWorkbook(page.request, "C2 verify waterfall");
    await importCsv(page.request, tableId, [["Full name", "Email"], ["Ann Lee", "ann@acme.test"]]);
    // The fake provider an earlier test connected verifies too; switch it off so the preset holds the two vendors only.
    const listed = await page.request.get("/api/grid/providers");
    for (const p of ((await listed.json()) as { providers: Array<{ id: string; adapter: string }> }).providers.filter((p) => p.adapter === "fake")) {
      expect((await page.request.patch(`/api/grid/providers/${p.id}`, { data: { enabled: false } })).ok()).toBe(true);
    }
    // In fake mode the key check makes no call, so these keys are never sent anywhere. Nothing here runs the column.
    for (const adapter of ["hunter", "zerobounce"]) {
      const res = await page.request.post("/api/grid/providers", { data: { adapter, key: `c2-${adapter}`, credentials: { apiKey: `c2-${adapter}-key` } } });
      expect(res.status(), `connect ${adapter}`).toBe(201);
    }
    await page.goto(`/tables/${workbookId}`);
    await expect(page.getByRole("gridcell", { name: "Email: ann@acme.test" })).toBeVisible();

    await page.getByRole("button", { name: "Add column" }).click();
    await page.getByRole("menuitem", { name: "Enrichment" }).click();
    const dialog = page.getByRole("dialog", { name: "Add enrichment" });
    await dialog.getByRole("tab", { name: "Waterfall" }).click();
    await dialog.getByRole("button", { name: "Verify email (2 providers)" }).click();
    await expect(dialog.locator("#step-p-0")).toContainText("Hunter");
    await expect(dialog.locator("#step-p-1")).toContainText("ZeroBounce");
    // Both steps run the same action, so "Add step" has no third verifier to offer.
    await expect(dialog.getByRole("button", { name: "Add step" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Add columns" }).click();
    await expect(dialog).toBeHidden();

    const { columns } = await gridPage(page.request, tableId);
    const waterfall = columns.find((c) => c.type === "waterfall");
    expect(waterfall?.config).toMatchObject({ steps: [{ providerKey: "c2-hunter", actionKey: "verify-email" }, { providerKey: "c2-zerobounce", actionKey: "verify-email" }] });
  });

  test("an AI column is added from the toolbar and filled by a run", async ({ page }) => {
    await signInAdmin(page);
    const { workbookId, tableId } = await newWorkbook(page.request, "C2 AI column");
    await importCsv(page.request, tableId, PEOPLE);
    await page.goto(`/tables/${workbookId}`);
    await expect(page.getByRole("gridcell", { name: "Company: Acme" })).toBeVisible();

    await page.getByRole("button", { name: "Add column" }).click();
    await page.getByRole("menuitem", { name: "AI column" }).click();
    const dialog = page.getByRole("dialog", { name: "Add AI column" });
    await dialog.getByLabel("Column name").fill("Summary");
    await dialog.getByLabel("Prompt").fill("Describe the company {{company}} in one line.");
    await dialog.getByRole("button", { name: "Add columns" }).click();
    await expect(page.getByRole("columnheader", { name: /Summary/ })).toBeVisible();

    await page.getByRole("button", { name: "Run", exact: true }).first().click();
    const run = page.getByRole("dialog", { name: "Run enrichments" });
    await run.getByRole("button", { name: /^Run( [\d,]+ rows?)?$/ }).click();
    await expect(page.getByText(/Queued 3 cells across 3 rows/)).toBeVisible();
    await settle(page.request, tableId);
    expect(await cellValue(page.request, tableId, "Company", "Acme", "answer")).toBe("fake: Acme");
    await expect(page.getByRole("gridcell", { name: "answer: fake: Acme" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("status").filter({ hasText: "Done" })).toBeVisible();
  });
});
