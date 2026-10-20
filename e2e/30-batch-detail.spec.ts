import { MOBILE_DARK, csvFile, expect, expectNoHorizontalOverflow, signInAdmin, sql, test, unique } from "./support/fixtures";
import type { Page } from "@playwright/test";

const search = (tag: string) => `https://www.linkedin.com/search/results/people/?keywords=${tag}`;

/**
 * A batch with one search per status that matters: queued, paused, failed, running, completed (3 people in leads),
 * waiting for the daily limit. One connected account exists. Nothing ticks, so the statuses stay as seeded.
 */
async function seedBatch(page: Page) {
  const tag = unique("s30").toLowerCase();
  const db = sql();
  const [{ id: org }] = await db`select id from organizations order by created_at limit 1`;
  const [existing] = await db`select id from linkedin_accounts where organization_id = ${org} and status = 'connected' limit 1`;
  if (!existing) {
    await db`insert into linkedin_accounts (organization_id, provider_account_id, linkedin_id, username, name, status)
             values (${org}, 'demo-account', 'ACo-demo', 'demo-seller', 'Demo Seller', 'connected')`;
  }
  const names = ["Queued Co", "Paused Co", "Failed Co", "Running Co", "Done Co", "Limit Co"];
  const res = await page.request.post("/api/linkedin/search-batches", {
    multipart: {
      name: `Detail ${tag}`,
      maxResults: "10",
      campaignId: "",
      file: csvFile(`${tag}.csv`, [["company_name", "search_url"], ...names.map((n) => [n, search(`${n.split(" ")[0].toLowerCase()}-${tag}`)])]),
    },
  });
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  const set = (company: string, status: string, extra: Record<string, unknown> = {}) =>
    db`update linkedin_search_queries set status = ${status}, last_error = ${(extra.lastError as string) ?? null}, imported_count = ${(extra.imported as number) ?? 0}, leads_fetched = ${(extra.found as number) ?? 0}
       where batch_id = ${id} and company_name = ${company}`;
  await set("Paused Co", "paused");
  await set("Failed Co", "failed", { lastError: "LinkedIn refused the search." });
  await set("Running Co", "running");
  await set("Done Co", "completed", { imported: 3, found: 5 });
  await set("Limit Co", "paused_limit");
  return { id, db, tag };
}

/** Router refreshes are RSC fetches. Counting them shows whether a page keeps polling. */
function countRefreshes(page: Page) {
  let count = 0;
  page.on("request", (r) => {
    if (r.headers()["rsc"] === "1" && !r.headers()["next-router-prefetch"]) count += 1;
  });
  return () => count;
}

/**
 * Returns once every request the page started so far has reached the test. Lets React's scheduler run (the fake clock
 * leaves MessageChannel alone), then sends a marker request. The browser reports requests in the order it sends them,
 * so a refresh that a timer started is counted before the marker arrives.
 */
async function afterPendingRequests(page: Page) {
  await page.route("**/__e2e-marker", (route) => route.fulfill({ status: 204 }));
  const marker = page.waitForRequest("**/__e2e-marker");
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = resolve;
        channel.port2.postMessage(null);
      });
    }
    await fetch("/__e2e-marker");
  });
  await marker;
}

test.describe("batch detail", () => {
  test("the header groups Run actions and keeps delete and download in a Data menu", async ({ page }) => {
    await signInAdmin(page);
    const { id } = await seedBatch(page);
    await page.goto(`/leads/searches/batches/${id}`);

    const run = page.getByRole("group", { name: "Run" });
    await expect(run.getByRole("button", { name: "Add searches" })).toBeVisible();
    await expect(run.getByRole("button", { name: "Run now" })).toBeVisible();
    await expect(run.getByRole("button", { name: "Rerun 1 failed" })).toBeVisible();
    // Destructive and data actions do not sit beside Run now.
    await expect(page.getByRole("button", { name: "Delete batch" })).toHaveCount(0);

    await page.getByRole("button", { name: "Data" }).click();
    const items = page.getByRole("menuitem");
    await expect(items).toHaveText(["Download results", "Delete stored results", "Delete batch"]);
    const download = page.waitForEvent("download");
    await items.first().click();
    expect((await download).suggestedFilename()).toContain("csv");

    // Delete batch asks first, and Cancel leaves the batch alone.
    await page.getByRole("button", { name: "Data" }).click();
    await page.getByRole("menuitem", { name: "Delete batch" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Delete the batch");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/leads/searches/batches/${id}$`));
  });

  test("Run now states the capacity it may use and what it leaves alone, and runs only after confirming", async ({ page }) => {
    await signInAdmin(page);
    const { id, db } = await seedBatch(page);
    await page.goto(`/leads/searches/batches/${id}`);

    await page.getByRole("button", { name: "Run now" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Run 2 searches now?" })).toBeVisible();
    await expect(dialog).toContainText(/up to [\d,]+ more people today across \d+ accounts?/);
    await expect(dialog).toContainText("Running, finished and failed searches, and people already in Leads, stay as they are.");

    // Cancel changes nothing.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    const before = await db`select company_name, status, next_page_at from linkedin_search_queries where batch_id = ${id} order by company_name`;
    expect(before.find((r) => r.company_name === "Paused Co")?.status).toBe("paused");

    await page.getByRole("button", { name: "Run now" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Run now" }).click();
    await expect(page.getByText(/2 searches are ready to run/)).toBeVisible();
    const after = await db`select company_name, status from linkedin_search_queries where batch_id = ${id}`;
    const status = Object.fromEntries(after.map((r) => [r.company_name, r.status]));
    expect(status["Paused Co"]).toBe("queued");
    // Searches that were running, finished, failed or waiting for the limit stay as they were.
    expect(status["Running Co"]).toBe("running");
    expect(status["Done Co"]).toBe("completed");
    expect(status["Failed Co"]).toBe("failed");
    expect(status["Limit Co"]).toBe("paused_limit");
  });

  test("a row shows one or two buttons for its status and keeps the rest in its menu", async ({ page }) => {
    await signInAdmin(page);
    const { id } = await seedBatch(page);
    await page.goto(`/leads/searches/batches/${id}`);
    const row = (name: string) => page.getByRole("row", { name: new RegExp(name) });

    const queued = row("Queued Co");
    await expect(queued.getByRole("button", { name: /^Run / })).toBeVisible();
    await expect(queued.getByRole("button", { name: /^Pause / })).toBeVisible();
    await expect(queued.getByRole("button", { name: /^Stop|^Resume|^Remove/ })).toHaveCount(0);

    // A failed search offers Rerun and never Stop.
    const failed = row("Failed Co");
    await expect(failed.getByRole("button", { name: /^Rerun / })).toBeVisible();
    await failed.getByRole("button", { name: /^More actions/ }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Remove"]);
    await page.keyboard.press("Escape");

    // A paused search: Run first, then Resume, Stop and Remove with the destructive ones last.
    const paused = row("Paused Co");
    await expect(paused.getByRole("button", { name: /^Run / })).toBeVisible();
    await paused.getByRole("button", { name: /^More actions/ }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Resume", "Stop", "Remove"]);
    await page.keyboard.press("Escape");

    // Done: only Remove, in the menu. The In leads count opens the lead list for that search.
    const done = row("Done Co");
    await expect(done.getByRole("button", { name: /^(Run|Pause|Rerun) / })).toHaveCount(0);
    await done.getByRole("link", { name: /3 in Leads/ }).click();
    await expect(page).toHaveURL(/\/leads\?source=linkedin_search%3A[0-9a-f-]{36}$/);
  });

  test("at 390px every search is a card with Found, In leads and its actions in reach", async ({ browser }) => {
    const context = await browser.newContext(MOBILE_DARK);
    const page = await context.newPage();
    await signInAdmin(page);
    const { id } = await seedBatch(page);
    await page.goto(`/leads/searches/batches/${id}`);

    await expect(page.getByRole("table")).toBeHidden();
    const cards = page.getByTestId("batch-card");
    await expect(cards).toHaveCount(6);
    await expectNoHorizontalOverflow(page);

    const paused = cards.filter({ hasText: "Paused Co" });
    await expect(paused).toContainText("Found 0 / 10");
    await expect(paused).toContainText("In leads 0");
    const done = cards.filter({ hasText: "Done Co" });
    await expect(done).toContainText("Found 5 / 10");
    await expect(done.getByRole("link", { name: /3 in Leads/ })).toBeVisible();

    // Primary controls are 44px tall.
    for (const locator of [page.getByRole("button", { name: "Run now" }), paused.getByRole("button", { name: /^Run / }), paused.getByRole("button", { name: /^More actions/ })]) {
      const box = await locator.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await paused.getByRole("button", { name: /^More actions/ }).click();
    await expect(page.getByRole("menuitem")).toHaveText(["Resume", "Stop", "Remove"]);
    await context.close();
  });

  test("the batch refreshes while a search is active and stops when nothing is", async ({ page }) => {
    await signInAdmin(page);
    const { id, db } = await seedBatch(page);
    await page.clock.install();
    await page.goto(`/leads/searches/batches/${id}`);
    const refreshes = countRefreshes(page);

    // Active searches: the page re-reads about every 8 seconds.
    await page.clock.runFor(8_500);
    await expect.poll(refreshes).toBeGreaterThanOrEqual(1);

    // Everything finishes. The next refresh shows it, and then the timer stops.
    await db`update linkedin_search_queries set status = 'completed' where batch_id = ${id}`;
    const beforeLast = refreshes();
    await page.clock.runFor(8_500);
    await expect(page.getByRole("row", { name: /Queued Co/ })).toContainText("Completed");
    await expect.poll(refreshes).toBeGreaterThan(beforeLast);
    const settled = refreshes();
    await page.clock.runFor(60_000);
    await afterPendingRequests(page);
    expect(refreshes()).toBe(settled);
  });
});

test.describe("search pages", () => {
  test("Upload sheet is the same dialog on both pages, and New search has a Cancel", async ({ page }) => {
    await signInAdmin(page);
    for (const path of ["/leads/searches", "/leads/searches/batches"]) {
      await page.goto(path);
      await page.getByRole("button", { name: "Upload sheet" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("heading", { name: "Upload search batch" })).toBeVisible();
      await expect(dialog.getByRole("link", { name: "Download the template" })).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toHaveCount(0);
    }
    await page.goto("/leads/searches");
    await page.getByRole("button", { name: "New search" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
  });

  test("the batches list refreshes while a batch has an active search and stops when none has", async ({ page }) => {
    await signInAdmin(page);
    const { id, db } = await seedBatch(page);
    // Earlier specs leave their own queued searches behind. Only this batch may be active here.
    await db`update linkedin_search_queries set status = 'cancelled' where status in ('queued', 'running', 'paused_limit') and batch_id <> ${id}`;
    await page.clock.install();
    await page.goto("/leads/searches/batches");
    const refreshes = countRefreshes(page);
    await page.clock.runFor(8_500);
    await expect.poll(refreshes).toBeGreaterThanOrEqual(1);

    await db`update linkedin_search_queries set status = 'cancelled' where batch_id = ${id}`;
    const beforeLast = refreshes();
    await page.clock.runFor(8_500);
    await expect.poll(refreshes).toBeGreaterThan(beforeLast);
    await expect(page.getByRole("row", { name: /Detail/ }).first()).toContainText("cancelled");
    const settled = refreshes();
    await page.clock.runFor(60_000);
    await afterPendingRequests(page);
    expect(refreshes()).toBe(settled);
  });
});
