import type { Locator, Page } from "@playwright/test";
import { MOBILE_DARK, expect, expectNoHorizontalOverflow, seedContact, seedReply, signInAdmin, signOut, sql, test, unique } from "./support/fixtures";
import { importCsv, newWorkbook } from "./support/grid";

/**
 * Every main page at 390x844 with the dark color scheme: the `dark` class is on <html> and nothing scrolls sideways.
 * The file seeds what its pages show, so it runs alone. Checks that belong to one page (touch targets, thumb zone,
 * contrast, cards) stay in that page's spec.
 */
test.use(MOBILE_DARK);

interface Route {
  path: string;
  /** Visible once the page has rendered what it lays out. Defaults to the first h1 of the main content. */
  ready?: (page: Page) => Locator;
}

const heading = (page: Page) => page.locator("#main-content h1").first();

async function expectFits(page: Page, route: Route) {
  await test.step(route.path, async () => {
    await page.goto(route.path);
    await expect((route.ready ?? heading)(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Page not found" })).toHaveCount(0);
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await expectNoHorizontalOverflow(page);
  });
}

test.describe("phone width in dark mode", () => {
  test.setTimeout(180_000);

  test("the signed-out pages fit the phone", async ({ page }) => {
    await signOut(page);
    const routes: Route[] = [
      { path: "/sign-in", ready: (p) => p.getByRole("button", { name: "Sign in" }) },
      { path: "/sign-up", ready: (p) => p.getByText("Invitation only") },
      { path: "/forgot-password", ready: (p) => p.getByRole("button", { name: "Send reset link" }) },
      { path: "/reset-password", ready: (p) => p.getByText("Link expired") },
    ];
    for (const route of routes) await expectFits(page, route);
  });

  test("the app pages fit the phone", async ({ page }) => {
    await signInAdmin(page);
    const tag = unique("s90");
    const lead = { email: `lena@${tag}.test`, firstName: "Lena", lastName: `Phone ${tag}`, title: "COO", company: `S90 Group ${tag}` };
    const { campaignId } = await seedReply(page.request, { key: tag, mailbox: `sdr-${tag}@e2e-corp.test`, lead, reply: { bodyText: "Can we talk on Thursday?" } });
    const [thread] = await sql()`select c.id from conversations c join records r on r.id = c.record_id join people p on p.id = r.person_id where p.email = ${lead.email}`;
    const { workbookId, tableId } = await newWorkbook(page.request, `S90 table ${tag}`);
    await importCsv(page.request, tableId, [["Email", "Company"], [`ann@${tag}.test`, "Acme"], [`bo@${tag}.test`, "Beta"]]);
    const domain = `${tag}-co.test`;
    const { personId } = await seedContact(page.request, { firstName: "Cleo", lastName: `Phone ${tag}`, email: `cleo@${domain}`, companyDomain: domain, companyName: `S90 Co ${tag}` });
    const [company] = await sql()`select id from companies where domain = ${domain}`;

    const routes: Route[] = [
      { path: "/leads" },
      { path: "/leads/import" },
      { path: "/leads/searches/batches", ready: (p) => p.getByRole("button", { name: "Upload sheet" }) },
      { path: "/campaigns", ready: (p) => p.getByRole("group", { name: "Campaign filter" }) },
      { path: `/campaigns/${campaignId}`, ready: (p) => p.getByTestId("campaign-facts") },
      { path: `/campaigns/${campaignId}?tab=sequence`, ready: (p) => p.getByTestId("campaign-facts") },
      { path: `/campaigns/${campaignId}?tab=settings`, ready: (p) => p.getByTestId("campaign-facts") },
      { path: "/inbox", ready: (p) => p.locator("li[data-list-row]").first() },
      { path: `/inbox/${thread.id}`, ready: (p) => p.getByTestId("thread-assignee") },
      { path: "/inbox?view=scheduled", ready: (p) => p.getByRole("navigation", { name: "Inbox sections" }) },
      { path: "/inbox?view=automated", ready: (p) => p.getByRole("navigation", { name: "Inbox sections" }) },
      { path: "/inbox/unmatched" },
      { path: "/actions", ready: (p) => p.getByTestId("queue-item").first() },
      { path: "/actions?scope=others" },
      { path: "/tables", ready: (p) => p.getByRole("link", { name: `S90 table ${tag}` }) },
      { path: `/tables/${workbookId}`, ready: (p) => p.getByRole("gridcell", { name: "Company: Beta" }) },
      { path: `/crm/contacts?q=${tag}` },
      { path: `/crm/contacts/${personId}` },
      { path: `/crm/companies?q=${tag}` },
      { path: `/crm/companies/${company.id}` },
      { path: "/settings/members", ready: (p) => p.getByRole("button", { name: "Send invitation" }) },
      { path: "/settings/organization", ready: (p) => p.getByLabel("Slug") },
      { path: "/settings/mailboxes", ready: (p) => p.getByRole("button", { name: /^More/ }).first() },
      { path: "/settings/replies" },
      { path: "/settings/linkedin", ready: (p) => p.getByRole("heading", { name: "LinkedIn", exact: true }).first() },
      { path: "/settings/jobs", ready: (p) => p.getByRole("heading", { name: "Jobs", exact: true }).first() },
    ];
    for (const route of routes) await expectFits(page, route);
  });
});
