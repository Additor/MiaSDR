import type { APIRequestContext, Page } from "@playwright/test";
import { MOBILE_DARK, expect, expectNoHorizontalOverflow, importLeads, seedReply, signInAdmin, sql, test, unique, waitForHydrated } from "./support/fixtures";

/*
 * Deals, the Pipeline board, the deal page and Settings > Pipeline stages ("Leads and CRM" in docs/decisions.md).
 * Every lead here is this spec's own: the leads of specs 07, 19 and 21 stay leads.
 */

const LENA = { email: "lena@s35-alpha.test", firstName: "Lena", lastName: "Stone", title: "Head of Ops", company: "S35 Alpha" };
const LENA_DEAL = "S35 Lena deal";

async function personId(email: string): Promise<string> {
  const [row] = await sql()`select id from people where email = ${email}`;
  expect(row, `person ${email}`).toBeTruthy();
  return row.id as string;
}

/** Create deal through the API, as the lead page's dialog does. The lead becomes a contact. */
async function convert(request: APIRequestContext, email: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await request.post(`/api/leads/${await personId(email)}/convert`, { data: { idempotencyKey: unique("s35"), ...body } });
  expect(res.status(), `convert ${email}`).toBe(201);
  return ((await res.json()) as { dealId: string }).dealId;
}

async function stageId(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.get("/api/deal-stages");
  expect(res.status()).toBe(200);
  const stage = ((await res.json()) as { stages: Array<{ id: string; name: string }> }).stages.find((s) => s.name === name);
  expect(stage, `stage ${name}`).toBeTruthy();
  return stage!.id;
}

async function moveByApi(request: APIRequestContext, dealId: string, stage: string): Promise<void> {
  const deal = (await (await request.get(`/api/deals/${dealId}`)).json()) as { version: number };
  const res = await request.post(`/api/deals/${dealId}/stage`, { data: { stageId: await stageId(request, stage), expectedVersion: deal.version } });
  expect(res.status(), `move to ${stage}`).toBe(200);
}

const column = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test.describe("deals pipeline", () => {
  test("a replied lead becomes a deal on the board; move it, survive a stale version, mark it lost and won", async ({ page, browser, watch }) => {
    await signInAdmin(page);
    await seedReply(page.request, { key: "S35", mailbox: "sdr35@e2e-corp.test", lead: LENA, reply: { bodyText: "Sounds good, what does it cost?" } });
    const dealId = await convert(page.request, LENA.email, { title: LENA_DEAL, amount: "12000", currency: "USD" });

    // AC1: the deal sits in the first open stage with the contact's name, company and amount; the column sums its currency.
    await page.goto("/crm/pipeline?q=S35%20Lena");
    const card = column(page, "New").getByTestId("deal-card").filter({ hasText: LENA_DEAL });
    await expect(card).toContainText("Lena Stone, S35 Alpha");
    await expect(card).toContainText("USD 12,000.00");
    await expect(card).toContainText("From S35 campaign");
    await expect(column(page, "New").locator("header")).toContainText("USD 12,000.00");

    // AC2: Move stage from the card.
    await card.getByRole("button", { name: "Move stage" }).click();
    const move = page.getByRole("dialog", { name: `Move ${LENA_DEAL}` });
    await move.getByRole("combobox", { name: "New stage" }).click();
    await page.getByRole("option", { name: "Meeting", exact: true }).click();
    await move.getByRole("button", { name: "Move", exact: true }).click();
    await expect(column(page, "Meeting").getByRole("link", { name: LENA_DEAL })).toBeVisible();
    await expect(column(page, "New").getByRole("link", { name: LENA_DEAL })).toHaveCount(0);

    // The whole card opens the deal page.
    await column(page, "Meeting").getByRole("link", { name: LENA_DEAL }).click();
    // The link names the board it came from, filters included, and the back link returns there.
    await expect(page).toHaveURL(new RegExp(`/crm/deals/${dealId}\\?from=%2Fcrm%2Fpipeline%3Fq%3DS35%2BLena$`));
    await expect(page.getByRole("link", { name: "Back to Pipeline" })).toHaveAttribute("href", "/crm/pipeline?q=S35+Lena");
    await expect(page.getByTestId("deal-stage")).toHaveText("Meeting");
    // Activity opens on Tasks on a deal page; History is a tab over.
    await waitForHydrated(page.getByRole("tab", { name: /History/ }));
    await page.getByRole("tab", { name: /History/ }).click();
    await expect(page.getByRole("list", { name: "History" }).getByText("Became a contact", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open conversation" })).toBeVisible();

    // AC2: a second session moves the deal while this one has the dialog open. The move here answers 409 and offers a retry.
    await page.getByRole("button", { name: "Move stage" }).click();
    const stale = page.getByRole("dialog", { name: `Move ${LENA_DEAL}` });
    await stale.getByRole("combobox", { name: "New stage" }).click();
    await page.getByRole("option", { name: "New", exact: true }).click();

    const other = await browser.newContext({ storageState: await page.context().storageState() });
    const second = await other.newPage();
    await second.goto(`/crm/deals/${dealId}`);
    await second.getByRole("button", { name: "Move stage" }).click();
    await second.getByRole("combobox", { name: "New stage" }).click();
    await second.getByRole("option", { name: "Proposal", exact: true }).click();
    await second.getByRole("dialog").getByRole("button", { name: "Move", exact: true }).click();
    await expect(second.getByTestId("deal-stage")).toHaveText("Proposal");
    await other.close();

    watch.tolerate(/response 409: POST .*\/api\/deals\/[0-9a-f-]+\/stage/, /status of 409 \(Conflict\).*\/api\/deals\/[0-9a-f-]+\/stage/);
    await stale.getByRole("button", { name: "Move", exact: true }).click();
    await expect(stale.getByRole("status")).toContainText("Someone changed this deal since you opened it.");
    await stale.getByRole("button", { name: "Move again" }).click();
    await expect(stale).toBeHidden();
    await expect(page.getByTestId("deal-stage")).toHaveText("New");

    // AC3: Mark lost asks for the reason first.
    await page.getByRole("button", { name: "Mark lost" }).click();
    const lost = page.getByRole("dialog", { name: `Mark ${LENA_DEAL} lost` });
    await expect(lost.getByRole("button", { name: "Mark lost" })).toBeDisabled();
    await lost.getByLabel("Lost reason").fill("Chose a competitor");
    await lost.getByRole("button", { name: "Mark lost" }).click();
    await expect(page.getByTestId("deal-stage")).toHaveText("Lost");
    await expect(page.getByText("Chose a competitor").first()).toBeVisible();
    await page.getByRole("tab", { name: /History/ }).click();
    await expect(page.getByRole("list", { name: "History" })).toContainText("Moved deal to Lost: Chose a competitor");

    // Mark won moves it out of Lost and clears the reason.
    await page.getByRole("button", { name: "Mark won" }).click();
    await page.getByRole("dialog", { name: `Mark ${LENA_DEAL} won` }).getByRole("button", { name: "Mark won" }).click();
    await expect(page.getByTestId("deal-stage")).toHaveText("Won");
    await expect(page.getByText("Lost reason")).toHaveCount(0);
    // A won deal offers no Delete in the More menu.
    await page.getByRole("button", { name: `More actions for ${LENA_DEAL}` }).click();
    await expect(page.getByRole("menuitem", { name: "Delete deal" })).toHaveCount(0);

    // Edit the amount.
    await page.getByRole("menuitem", { name: "Edit deal" }).click();
    const edit = page.getByRole("dialog", { name: `Edit ${LENA_DEAL}` });
    await edit.getByLabel("Amount (optional)").fill("15000");
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("deal-summary").getByText("USD 15,000.00")).toBeVisible();

    // The board shows the won deal in the Won column, closed within the window.
    await page.goto("/crm/pipeline?q=S35%20Lena");
    await expect(column(page, "Won").getByRole("link", { name: LENA_DEAL })).toBeVisible();
    await expect(column(page, "Won").locator("header")).toContainText("Last 30 days");
  });

  test("a card dragged to another stage moves there, a stale drag goes back, and a drop on Won or Lost asks first", async ({ page, watch }) => {
    await signInAdmin(page);
    const DREW = { email: "drew@s35-drag.test", firstName: "Drew", lastName: "Hale", title: "COO", company: "S35 Drag" };
    const DEAL = "S35 Drew deal";
    await importLeads(page.request, [DREW]);
    await seedReply(page.request, { key: "S35D", mailbox: "sdr35d@e2e-corp.test", lead: DREW, reply: { bodyText: "Let's talk." } });
    const dealId = await convert(page.request, DREW.email, { title: DEAL });

    // Wide enough that every stage is on screen: a drag across a column that has to scroll is the browser's job.
    await page.setViewportSize({ width: 2200, height: 900 });
    await page.goto("/crm/pipeline?q=S35%20Drew");
    const card = (stage: string) => column(page, stage).getByTestId("deal-card").filter({ hasText: DEAL });
    await waitForHydrated(card("New"));
    await card("New").dragTo(column(page, "Meeting"));
    await expect(card("Meeting")).toBeVisible();
    await expect(card("New")).toHaveCount(0);
    await expect(page.getByText(`Moved ${DEAL} to Meeting.`)).toBeVisible();
    await expect(column(page, "Meeting").locator("header")).toContainText("1");
    // The board keeps the moved card's new version, so it moves again without a reload.
    await card("Meeting").dragTo(column(page, "Proposal"));
    await expect(page.getByText(`Moved ${DEAL} to Proposal.`)).toBeVisible();
    await card("Proposal").dragTo(column(page, "Meeting"));
    await expect(page.getByText(`Moved ${DEAL} to Meeting.`)).toHaveCount(2);
    await page.reload();
    await expect(card("Meeting")).toBeVisible();

    // Someone moves the deal after the board loaded: the drag is refused and the board shows where the deal is now.
    await moveByApi(page.request, dealId, "Proposal");
    watch.tolerate(/response 409: POST .*\/api\/deals\/[0-9a-f-]+\/stage/, /status of 409 \(Conflict\).*\/api\/deals\/[0-9a-f-]+\/stage/);
    await card("Meeting").dragTo(column(page, "New"));
    await expect(page.getByText("Someone changed this deal since the board loaded.")).toBeVisible();
    await expect(card("Proposal")).toBeVisible();
    await expect(card("New")).toHaveCount(0);

    // Won and Lost close the deal, so a drop there asks first, as Mark won and Mark lost do.
    await card("Proposal").dragTo(column(page, "Won"));
    const won = page.getByRole("dialog", { name: `Move ${DEAL}` });
    await expect(won.getByRole("combobox", { name: "New stage" })).toContainText("Won");
    await won.getByRole("button", { name: "Cancel" }).click();
    await expect(card("Proposal")).toBeVisible();

    // Lost keeps a reason.
    await card("Proposal").dragTo(column(page, "Lost"));
    const lost = page.getByRole("dialog", { name: `Move ${DEAL}` });
    await expect(lost.getByRole("combobox", { name: "New stage" })).toContainText("Lost");
    await lost.getByLabel("Lost reason").fill("No budget this year");
    await lost.getByRole("button", { name: "Move", exact: true }).click();
    await expect(card("Lost")).toBeVisible();
    await expect(card("Proposal")).toHaveCount(0);
  });

  test("Won and Lost show the last 30 days, Show all widens them, and a long column loads more inside itself", async ({ page }) => {
    await signInAdmin(page);
    const bram = { email: "bram@s35-beta.test", firstName: "Bram", lastName: "Older", company: "S35 Beta" };
    await importLeads(page.request, [bram]);
    const dealId = await convert(page.request, bram.email, { title: "S35 Bram deal" });
    await moveByApi(page.request, dealId, "Won");
    await sql()`update deals set closed_at = now() - interval '40 days' where id = ${dealId}`;

    // AC4: the deal closed 40 days ago is outside the window until Show all.
    await page.goto("/crm/pipeline?q=S35%20Bram");
    await expect(column(page, "Won")).toBeVisible();
    await expect(column(page, "Won").getByRole("link", { name: "S35 Bram deal" })).toHaveCount(0);
    await page.getByRole("group", { name: "Closed deals" }).getByRole("link", { name: "Show all" }).click();
    await expect(page).toHaveURL(/showAll=1/);
    await expect(column(page, "Won").getByRole("link", { name: "S35 Bram deal" })).toBeVisible();

    // 26 deals in one stage: 25 cards, then "1 more" loads the last one inside the column.
    const bulk = Array.from({ length: 26 }, (_, i) => ({ email: `bulk${i}@s35-bulk.test`, firstName: "Bulk", lastName: `Person${String(i).padStart(2, "0")}`, company: "S35 Bulk" }));
    await importLeads(page.request, bulk);
    const ids = await Promise.all(bulk.map((b) => personId(b.email)));
    const res = await page.request.post("/api/leads/convert", { data: { ids } });
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { created: unknown[] }).created).toHaveLength(26);

    await page.goto("/crm/pipeline?q=S35%20Bulk");
    const cards = column(page, "New").getByTestId("deal-card");
    await expect(cards).toHaveCount(25);
    await column(page, "New").getByRole("button", { name: "1 more" }).click();
    await expect(cards).toHaveCount(26);
    await expect(column(page, "New").getByRole("button", { name: /more/ })).toHaveCount(0);

    // Old reply-board params are ignored, and an unknown owner falls back to any owner.
    await page.goto("/crm/pipeline?category=interested&channel=email&closed=1&owner=nobody&q=S35%20Bulk");
    await expect(cards).toHaveCount(25);
    // The owner filter narrows the board; the bulk deals have the admin as owner.
    await page.goto("/crm/pipeline?owner=none&q=S35%20Bulk");
    await expect(page.getByText("No deals match these filters.")).toBeVisible();
  });

  test("a deal deleted from the board returns to the board with its filters", async ({ page }) => {
    await signInAdmin(page);
    const otto = { email: "otto@s35-delta.test", firstName: "Otto", lastName: "Delta", company: "S35 Delta" };
    await importLeads(page.request, [otto]);
    await convert(page.request, otto.email, { title: "S35 Otto deal" });

    await page.goto("/crm/pipeline?q=S35%20Otto");
    await column(page, "New").getByRole("link", { name: "S35 Otto deal" }).click();
    await expect(page).toHaveURL(/\/crm\/deals\/[0-9a-f-]{36}\?from=/);
    const more = page.getByRole("button", { name: "More actions for S35 Otto deal" });
    await waitForHydrated(more);
    await more.click();
    await page.getByRole("menuitem", { name: "Delete deal" }).click();
    await page.getByRole("dialog", { name: "Delete S35 Otto deal?" }).getByRole("button", { name: "Delete deal" }).click();
    await expect(page).toHaveURL(/\/crm\/pipeline\?q=S35\+Otto$/);
    await expect(page.getByText("Deleted S35 Otto deal.")).toBeVisible();
    await expect(column(page, "New").getByRole("link", { name: "S35 Otto deal" })).toHaveCount(0);
  });

  test("Settings > Pipeline stages: rename, reorder, add, and delete blocked while the stage has deals", async ({ page }) => {
    await signInAdmin(page);
    // AC5: the nav entry is reachable.
    await page.goto("/settings");
    await page.getByRole("link", { name: "Pipeline stages" }).first().click();
    await expect(page).toHaveURL(/\/settings\/pipeline$/);
    const list = page.getByRole("list", { name: "Stages" });
    const items = list.getByRole("listitem");
    await expect(items.filter({ hasText: "Won" }).locator('[data-slot="badge"]')).toHaveText("Won");

    // Rename.
    await page.getByRole("button", { name: "Rename Proposal" }).click();
    await page.getByLabel("New name for Proposal").fill("Proposal sent");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(items.nth(2)).toContainText("Proposal sent");

    // Reorder: up swaps with Meeting; Won and Lost stay last, so the last open stage cannot move down.
    await expect(page.getByRole("button", { name: "Move Proposal sent down" })).toBeDisabled();
    await page.getByRole("button", { name: "Move Proposal sent up" }).click();
    await expect(items.nth(1)).toContainText("Proposal sent");
    await expect(items.nth(2)).toContainText("Meeting");
    await page.goto("/crm/pipeline");
    await expect(page.locator("#main-content").getByTestId("board").locator("section").nth(1)).toHaveAttribute("aria-label", "Proposal sent");

    // Put the defaults back for the specs after this one.
    await page.goto("/settings/pipeline");
    await page.getByRole("button", { name: "Move Proposal sent down" }).click();
    await expect(items.nth(2)).toContainText("Proposal sent");
    await page.getByRole("button", { name: "Rename Proposal sent" }).click();
    await page.getByLabel("New name for Proposal sent").fill("Proposal");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(items.nth(2)).toContainText("Proposal");
    await expect(items.nth(2)).not.toContainText("Proposal sent");

    // Add an open stage: it goes after the last open stage.
    await page.getByLabel("Name", { exact: true }).fill("S35 Negotiation");
    await page.getByRole("button", { name: "Add stage" }).click();
    await expect(items.nth(3)).toContainText("S35 Negotiation");
    await expect(items.nth(4)).toContainText("Won");

    // A stage with a deal cannot be deleted, and the page says how many deals hold it.
    const nina = { email: "nina@s35-gamma.test", firstName: "Nina", lastName: "Gamma", company: "S35 Gamma" };
    await importLeads(page.request, [nina]);
    const dealId = await convert(page.request, nina.email, { title: "S35 Nina deal", stageId: await stageId(page.request, "S35 Negotiation") });
    await page.reload();
    await expect(items.filter({ hasText: "S35 Negotiation" })).toContainText("1 deal");
    await page.getByRole("button", { name: "Delete S35 Negotiation" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "S35 Negotiation" })).toHaveText("1 deal is in S35 Negotiation. Move it to another stage first.");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Empty again, it deletes after a confirmation.
    await moveByApi(page.request, dealId, "New");
    await page.reload();
    await page.getByRole("button", { name: "Delete S35 Negotiation" }).click();
    await page.getByRole("dialog", { name: "Delete S35 Negotiation?" }).getByRole("button", { name: "Delete stage" }).click();
    await expect(items.filter({ hasText: "S35 Negotiation" })).toHaveCount(0);
  });

  test("loading and empty states, and a new organization starts from the default stages", async ({ page }) => {
    await signInAdmin(page);
    // AC7: both pages stream a skeleton first.
    expect(await (await page.request.get("/crm/pipeline")).text()).toContain('data-testid="board-loading"');
    const [deal] = await sql()`select id from deals where title = ${LENA_DEAL}`;
    expect(await (await page.request.get(`/crm/deals/${deal.id}`)).text()).toContain('data-testid="deal-loading"');

    // A search with no match says so and offers to clear it.
    await page.goto("/crm/pipeline?q=no-such-deal-s35");
    await expect(page.getByText("No deals match these filters.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/crm/pipeline");

    // An organization without deals or stages: the empty board, then the default stages created from settings.
    const orgs = (await (await page.request.get("/api/organizations")).json()) as { organizations: Array<{ id: string; active: boolean }> };
    const home = orgs.organizations.find((o) => o.active)!.id;
    const created = await page.request.post("/api/organizations", { data: { name: unique("S35 Empty Org") } });
    expect(created.status()).toBe(201);
    try {
      await page.goto("/crm/pipeline");
      await expect(page.getByText("No deals yet.")).toBeVisible();
      await expect(page.getByText("Create a deal from a lead that replied.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Show leads that replied" })).toHaveAttribute("href", "/leads?hasConversation=yes");

      await page.goto("/settings/pipeline");
      await expect(page.getByText("Your pipeline uses these default stages.")).toBeVisible();
      await expect(page.getByRole("button", { name: /^Rename / })).toHaveCount(0);
      await page.getByRole("button", { name: "Create default stages" }).click();
      await expect(page.getByRole("button", { name: "Rename New" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Create default stages" })).toHaveCount(0);
      await expect(page.getByRole("list", { name: "Stages" }).getByRole("listitem")).toHaveCount(5);
    } finally {
      const back = await page.request.post("/api/organizations/active", { data: { organizationId: home } });
      expect(back.status(), "switch back to the first organization").toBe(200);
    }
  });
});

test.describe("deals at 390x844 in dark mode", () => {
  test.use(MOBILE_DARK);

  test("the board, the deal page and the stage settings fit the phone; only the board scrolls sideways", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/crm/pipeline?q=S35");
    await expect(page.locator("#main-content").getByTestId("board")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    // The board scrolls inside its own scroller.
    expect(await page.locator("#main-content").getByTestId("board").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    await page.getByRole("link", { name: LENA_DEAL }).click();
    await expect(page.getByTestId("deal-stage")).toHaveText("Won");
    await expectNoHorizontalOverflow(page);

    await page.goto("/settings/pipeline");
    await expect(page.getByRole("list", { name: "Stages" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
