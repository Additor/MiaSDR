import { csvFile, devFakes, expect, signInAdmin, sql, test, tick, unique } from "./support/fixtures";

const search = (tag: string) => `https://www.linkedin.com/search/results/people/?keywords=${tag}`;

test.describe("search batch upload", () => {
  test("upload a sheet, see per-row results, rerun the failed search, download the results", async ({ page }) => {
    const tag = unique("s22").toLowerCase();
    await signInAdmin(page);

    // One connected account on the fake gateway, and a clean queue.
    const db = sql();
    const [{ id: org }] = await db`select id from organizations order by created_at limit 1`;
    await db`update linkedin_search_queries set status = 'cancelled' where status in ('queued', 'running', 'paused', 'paused_limit')`;
    const [existing] = await db`select id from linkedin_accounts where organization_id = ${org} and status = 'connected' limit 1`;
    if (!existing) {
      await db`insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, name, status)
               values (${org}, 'demo-account', 'ACo-demo', 'demo-seller', 'Demo Seller', 'connected')`;
    }
    await devFakes(page.request, { action: "liSearchBehavior", refuseUrlIncludes: "failme" });

    // The template downloads and passes its own rules.
    const template = await page.request.get("/api/linkedin/search-batches/template");
    expect(template.status()).toBe(200);
    expect(template.headers()["content-disposition"]).toContain("search-batch-template.csv");
    expect(await template.text()).toContain("company_name,search_url");

    await page.goto("/leads/searches/batches");
    await page.getByRole("button", { name: "Upload sheet" }).click();
    await page.getByLabel("Name").fill(`Batch ${tag}`);
    await page.getByLabel("File").setInputFiles(
      csvFile(`${tag}.csv`, [
        ["company_name", "search_url"],
        ["Alpha Co", search(`alpha-${tag}`)],
        ["Failing Co", search(`failme-${tag}`)],
        ["Profile Co", "https://www.linkedin.com/in/someone"],
        ["Alpha Again", `${search(`alpha-${tag}`)}&origin=GLOBAL_SEARCH_HEADER`],
        ["Empty Co", ""],
      ]),
    );
    await page.getByLabel("Stop each search after").fill("10");
    await page.getByRole("button", { name: "Queue searches" }).click();
    await expect(page).toHaveURL(/\/leads\/searches\/batches\/[0-9a-f-]{36}$/);

    // The report: two queued, two refused with a reason each, one repeat dropped.
    await expect(page.getByText("2 searches, 0 people found")).toBeVisible();
    const rejections = page.getByTestId("batch-rejections");
    await expect(rejections).toContainText("2 of 5 rows were refused");
    await expect(rejections).toContainText("Row 4");
    await expect(rejections).toContainText("Row 6: The search URL is empty.");
    await expect(page.getByRole("row", { name: /Alpha Co/ })).toContainText("Queued");

    // Run the queue until the good search finishes and the other one fails.
    const batchId = new URL(page.url()).pathname.split("/").pop()!;
    await expect
      .poll(
        async () => {
          await tick(page.request);
          const rows = await db`select company_name, status from linkedin_search_queries where batch_id = ${batchId}`;
          return Object.fromEntries(rows.map((r) => [r.company_name, r.status]));
        },
        { timeout: 60_000, intervals: [1500] },
      )
      .toEqual({ "Alpha Co": "completed", "Failing Co": "failed" });

    await page.reload();
    await expect(page.getByRole("row", { name: /Failing Co/ })).toContainText("Failed");
    await expect(page.getByRole("row", { name: /Failing Co/ })).toContainText("Fake refusal: rejected");
    await expect(page.getByRole("row", { name: /Alpha Co/ })).toContainText("10 / 10");

    // The provider recovers. Rerun the failed search from the page; a second click finds nothing to do.
    await devFakes(page.request, { action: "liSearchBehavior", refuseUrlIncludes: "" });
    await page.getByRole("button", { name: "Rerun 1 failed" }).click();
    await expect(page.getByText("1 search queued again.")).toBeVisible();
    await expect(page.getByRole("row", { name: /Failing Co/ })).toContainText("Rerun 1 time");
    await expect(page.getByRole("button", { name: /Rerun \d+ failed/ })).toHaveCount(0);
    await expect
      .poll(
        async () => {
          await tick(page.request);
          return (await db`select status from linkedin_search_queries where batch_id = ${batchId} and company_name = 'Failing Co'`)[0].status;
        },
        { timeout: 60_000, intervals: [1500] },
      )
      .toBe("completed");

    // Results CSV: header, 20 people, both company names.
    const csv = await page.request.get(`/api/linkedin/search-batches/${batchId}/results`);
    expect(csv.status()).toBe(200);
    expect(csv.headers()["content-type"]).toContain("text/csv");
    const lines = (await csv.text()).trim().split("\r\n");
    expect(lines[0]).toContain("company_name,search_url,profile_url");
    expect(lines).toHaveLength(21);
    expect(lines.filter((l) => l.startsWith("Alpha Co,")).length).toBe(10);
    expect(lines.filter((l) => l.startsWith("Failing Co,")).length).toBe(10);

    // The batch list shows it, and the searches page opens the same upload dialog.
    await page.goto("/leads/searches/batches");
    await expect(page.getByRole("link", { name: `Batch ${tag}` })).toBeVisible();
    await page.goto("/leads/searches");
    await expect(page.getByRole("button", { name: "Upload sheet" })).toBeVisible();
  });

  test("a file with no usable row and a file with the wrong columns are refused with a reason", async ({ page, watch }) => {
    watch.tolerate(/422/);
    await signInAdmin(page);
    await page.goto("/leads/searches/batches");
    await page.getByRole("button", { name: "Upload sheet" }).click();
    await page.getByLabel("Name").fill("Bad file");
    await page.getByLabel("File").setInputFiles(csvFile("bad.csv", [["name", "email"], ["Ada", "ada@x.test"]]));
    const finished = page.waitForResponse((r) => r.url().endsWith("/api/linkedin/search-batches") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Queue searches" }).click();
    expect((await finished).status()).toBe(422);
    await expect(page.getByRole("alert")).toContainText("search_url");
  });
});
