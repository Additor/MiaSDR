import { expect, importLeads, seedReply, signInAdmin, sql, test, tick } from "./support/fixtures";

/**
 * Old URLs of the CRM screens reach their new places ("Leads and CRM" in docs/decisions.md), and the moved
 * screens sit where the sidebar and the Inbox header point. Every visit runs through the `watch` fixture, so a response
 * of 400 or higher or a console error fails the test.
 */

const LEAD = { email: "remy@s37-redirect.test", firstName: "Remy", lastName: "Okafor", title: "Founder", company: "S37 Redirect" };
const MATCH = { email: "uma@s37-match.test", firstName: "Uma", lastName: "Match37", title: "CTO", company: "S37 Match" };
const UNKNOWN_RECORD = "00000000-0000-4000-8000-000000000037";

test.describe("old CRM URLs", () => {
  test.describe.configure({ mode: "serial" });

  test("the record list and record links answer 307 from their route handlers and land on the new pages", async ({ page }) => {
    await signInAdmin(page);
    // The static rules of next.config are unit tested in src/architecture/legacy-redirects.test.ts.
    const rows: Array<[string, RegExp]> = [
      ["/crm/records?q=remy%40s37-redirect.test&state=closed&page=2", /\/leads\?hasConversation=yes&lifecycle=all&q=remy%40s37-redirect\.test$/],
      [`/crm/records/${UNKNOWN_RECORD}`, /\/crm\/pipeline$/],
    ];
    for (const [from, to] of rows) {
      const first = await page.request.get(from, { maxRedirects: 0 });
      expect(first.status(), `${from} answers a temporary redirect`).toBe(307);
      await page.goto(from);
      await expect(page, `${from} lands on its new page`).toHaveURL(to);
      await expect(page.locator("#main-content h1").first()).toBeVisible();
    }
    // The plain Leads list stays where it is.
    expect((await page.request.get("/leads", { maxRedirects: 0 })).status()).toBe(200);
  });

  test("an old record link opens the person's conversation", async ({ page }) => {
    await signInAdmin(page);
    await seedReply(page.request, { key: "S37", mailbox: "sdr37@e2e-corp.test", lead: LEAD, reply: { bodyText: "Happy to talk next week." } });
    await tick(page.request, 2);
    const [row] = await sql()`
      select r.id as record_id, c.id as conversation_id from records r
      join people p on p.id = r.person_id join conversations c on c.record_id = r.id
      where p.email = ${LEAD.email} and c.private_campaign_id is null`;
    await page.goto(`/crm/records/${row.record_id}`);
    await expect(page).toHaveURL(new RegExp(`/inbox/${row.conversation_id}$`));
    await expect(page.locator("#main-content").getByTestId("thread-person")).toContainText("Remy Okafor");
  });

  test("the sidebar groups the CRM, Actions is a Work row, and Unmatched senders hangs off the Inbox", async ({ page }) => {
    await signInAdmin(page);
    await importLeads(page.request, [MATCH]);
    const [{ organization_id: org }] = await sql()`select organization_id from people where email = ${MATCH.email}`;
    const key = `s37-${Date.now().toString(36)}`;
    await sql()`
      insert into identity_exceptions (organization_id, channel, account_ref, source_event_key, identity_value, reason, payload)
      values (${org}, 'email', 'sdr37@e2e-corp.test', ${key}, 'stranger@s37.test', 'No lead has this address.',
              ${sql().json({ kind: "email", message: { subject: "Who is this", bodyText: "Hello from a new address.", from: { email: "stranger@s37.test" } } })})`;

    await page.goto("/inbox");
    const nav = page.getByRole("navigation", { name: "Main" });
    for (const name of ["Inbox", "Actions", "Leads", "Campaigns", "Pipeline", "Contacts", "Companies", "Tables", "Analytics", "Settings"]) {
      await expect(nav.getByRole("link", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(nav.getByRole("link", { name: /^Records/ })).toHaveCount(0);
    await expect(nav.getByText("CRM", { exact: true })).toBeVisible();

    // The Inbox header links to Unmatched senders with the open count.
    const link = page.locator("#main-content").getByTestId("unmatched-senders-link");
    await expect(link.getByTestId("unmatched-senders-count")).not.toHaveText("0");
    await link.click();
    await expect(page).toHaveURL(/\/inbox\/unmatched$/);
    await expect(page.locator("#main-content").getByRole("heading", { level: 1, name: "Unmatched senders" })).toBeVisible();

    // The person search covers people of any lifecycle.
    const card = page.getByTestId("unmatched-message").filter({ hasText: "stranger@s37.test" });
    await card.getByLabel("File it under").fill("Match37");
    await card.getByRole("button", { name: "Search" }).click();
    await expect(card.getByRole("list", { name: "Matching people" })).toContainText("Uma Match37");
    await card.getByRole("button", { name: "Ignore" }).click();
    await expect(page.getByText("Message ignored.", { exact: true })).toBeVisible();
    await expect(card).toHaveCount(0);

    // Settings: Reply handling sits in the AI group, Pipeline stages in the CRM group.
    await page.goto("/settings/replies");
    await expect(page.locator("#main-content").getByRole("link", { name: "Reply handling" }).first()).toBeVisible();
    await expect(page.locator("#main-content").getByText("Asked to stop", { exact: true })).toBeVisible();
  });
});
