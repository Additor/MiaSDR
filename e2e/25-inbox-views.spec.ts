import type { Page } from "@playwright/test";
import { deliverInbound, ensureMailbox, expect, makeInboxSyncDue, signInAdmin, sql, test, tick, waitForHydrated } from "./support/fixtures";

const BOX_A = "sdr25a@e2e-corp.test";
const BOX_B = "sdr25b@e2e-corp.test";

/** The Filters button is a client toggle, so it waits for hydration: a click before that opens nothing. */
async function openFilters(page: Page) {
  const toggle = page.getByTestId("inbox-filters-toggle");
  await waitForHydrated(toggle);
  await toggle.click();
  await expect(page.getByRole("form", { name: "Inbox filters" })).toBeVisible();
}

/**
 * Seeds conversations straight into the database, in the organization that owns the mailbox. The inbound path
 * itself is covered by 05 and 06; this scenario tests how the list narrows them.
 */
async function seedBulk(mailboxAddress: string) {
  const db = sql();
  const [box] = await db`select organization_id as org from mailboxes where email_address = ${mailboxAddress}`;
  const [pipeline] = await db`select id from pipelines where organization_id = ${box.org} and is_default`;
  return { db, org: box.org as string, pipeline: pipeline.id as string };
}

async function addThread(
  seed: Awaited<ReturnType<typeof seedBulk>>,
  mailbox: string,
  input: { email: string; name: string; messages: Array<{ direction: "inbound" | "outbound"; subject: string; body: string; hoursAgo: number; autoReply?: boolean }> },
) {
  const { db, org, pipeline } = seed;
  const [person] = await db`insert into people (organization_id, email, full_name, first_name, source) values (${org}, ${input.email}, ${input.name}, ${input.name.split(" ")[0]}, 'inbound') returning id`;
  const [record] = await db`insert into records (organization_id, person_id, pipeline_id, workflow_state) values (${org}, ${person.id}, ${pipeline}, 'idle') returning id`;
  const [conv] = await db`insert into conversations (organization_id, record_id, channel, account_ref, provider_thread_id) values (${org}, ${record.id}, 'email', ${mailbox}, ${"e25-" + input.email}) returning id`;
  let n = 0;
  for (const m of input.messages) {
    await db`
      insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, subject, from_address, body_text, sent_at, raw)
      values (${org}, ${conv.id}, 'email', ${mailbox}, ${m.direction}, ${`e25-${input.email}-${++n}`}, ${m.subject}, ${m.direction === "inbound" ? input.email : mailbox}, ${m.body},
              now() - ${m.hoursAgo + " hours"}::interval, ${m.autoReply ? db.json({ autoReply: true }) : null})`;
  }
  return { personId: person.id as string, conversationId: conv.id as string };
}

test.describe("inbox filters and views", () => {
  test("filters and views narrow the list through the URL and the UI, across pages", async ({ page }) => {
    await signInAdmin(page);
    const boxA = await ensureMailbox(page.request, BOX_A, "Sender 25a");
    const boxB = await ensureMailbox(page.request, BOX_B, "Sender 25b");
    await tick(page.request); // first inbox sync records the mailbox positions
    await deliverInbound(page.request, { mailbox: BOX_A, fromEmail: "first@s25-group.test", fromName: "First Sender", subject: "Hello", bodyText: "Real inbound through the sync path." });
    await makeInboxSyncDue();
    await tick(page.request, 3);

    const seed = await seedBulk(BOX_A);
    for (let i = 1; i <= 26; i++) {
      await addThread(seed, BOX_A, {
        email: `bulk${String(i).padStart(2, "0")}@s25-group.test`,
        name: `Bulk Lead ${String(i).padStart(2, "0")}`,
        messages: [{ direction: "inbound", subject: `Bulk topic ${i}`, body: `Message from bulk lead ${i}`, hoursAgo: 2 + i }],
      });
    }
    // Mailbox B: one answered thread (Sent), one long thread whose first message holds the search word, one machine mail.
    await addThread(seed, BOX_B, {
      email: "answered@s25-group.test",
      name: "Answered Person",
      messages: [
        { direction: "inbound", subject: "Pricing", body: "What does it cost?", hoursAgo: 30 },
        { direction: "outbound", subject: "Re: Pricing", body: "Here are our plans.", hoursAgo: 29 },
      ],
    });
    await addThread(seed, BOX_B, {
      email: "longthread@s25-group.test",
      name: "Long Thread",
      messages: [
        { direction: "inbound", subject: "Integration", body: "We run gadolinium based tooling.", hoursAgo: 200 },
        { direction: "outbound", subject: "Re: Integration", body: "Tell me more.", hoursAgo: 199 },
        { direction: "inbound", subject: "Re: Integration", body: "It is complicated.", hoursAgo: 198 },
        { direction: "outbound", subject: "Re: Integration", body: "Understood.", hoursAgo: 197 },
      ],
    });
    await addThread(seed, BOX_B, {
      email: "noreply@billing.s25-group.test",
      name: "Billing Robot",
      messages: [{ direction: "inbound", subject: "Your invoice is ready", body: "Download your invoice.", hoursAgo: 5 }],
    });
    await addThread(seed, BOX_B, {
      email: "away@s25-group.test",
      name: "Away Person",
      messages: [{ direction: "inbound", subject: "Automatic reply: away", body: "I am out until Monday.", hoursAgo: 4, autoReply: true }],
    });
    // A queued campaign step for a lead on mailbox B.
    const away = await addThread(seed, BOX_B, {
      email: "queued@s25-group.test",
      name: "Queued Quinn",
      messages: [{ direction: "outbound", subject: "Intro", body: "First touch.", hoursAgo: 72 }],
    });
    const steps = [
      { stepNumber: 1, kind: "email", subject: "Intro", body: "First touch.", waitDays: 0 },
      { stepNumber: 2, kind: "email", subject: "Second touch", body: "Following up.", waitDays: 3 },
    ];
    const [campaign] = await seed.db`insert into campaigns (organization_id, channel, name, status, steps) values (${seed.org}, 'email', 'S25 campaign', 'active', ${seed.db.json(steps)}) returning id`;
    await seed.db`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step, mailbox_id, next_send_at)
      values (${seed.org}, ${campaign.id}, ${away.personId}, 'email', 'active', 1, ${boxB}, now() + interval '2 days')`;
    const [paused] = await seed.db`insert into campaigns (organization_id, channel, name, status, steps) values (${seed.org}, 'email', 'S25 paused', 'paused', ${seed.db.json(steps)}) returning id`;
    const [pausedPerson] = await seed.db`insert into people (organization_id, email, full_name, source) values (${seed.org}, 'paused@s25-group.test', 'Paused Pat', 'import') returning id`;
    await seed.db`
      insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step, mailbox_id, next_send_at)
      values (${seed.org}, ${paused.id}, ${pausedPerson.id}, 'email', 'active', 1, ${boxB}, now() + interval '1 day')`;

    // Filter through the UI: open the panel, pick mailbox A, apply. The URL carries the filter.
    await page.goto("/inbox");
    await openFilters(page);
    await page.locator("#f-mailbox").selectOption({ label: BOX_A });
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(new RegExp(`mailbox=${boxA}`));
    await expect(page.getByText("27 conversations, page 1 of 2")).toBeVisible();
    await expect(page.getByRole("link", { name: /Bulk Lead 01/ })).toBeVisible();
    await expect(page.getByRole("link", { name: "Answered Person" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Remove filter Mailbox/ })).toBeVisible();
    await expect(page.locator('[data-slot="day-divider"]').first()).toContainText(/Today|Yesterday|This week|Earlier/);

    // The filter survives paging and a view switch.
    await page.getByRole("link", { name: "Next" }).click();
    await expect(page).toHaveURL(new RegExp(`mailbox=${boxA}.*page=2|page=2.*mailbox=${boxA}`));
    await expect(page.getByText("27 conversations, page 2 of 2")).toBeVisible();
    await expect(page.getByRole("link", { name: /Bulk Lead 26/ })).toBeVisible();
    await page.getByRole("link", { name: "Unread", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`view=unread`));
    await expect(page).toHaveURL(new RegExp(`mailbox=${boxA}`));
    await expect(page).not.toHaveURL(/page=2/);

    // Clear filters keeps the view and drops the mailbox.
    await openFilters(page);
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/inbox\?view=unread$/);

    // Views by URL, always scoped to mailbox B so other scenarios' data stays out.
    await page.goto(`/inbox?mailbox=${boxB}&view=sent`);
    await expect(page.getByRole("link", { name: "Answered Person" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Long Thread" })).toBeVisible(); // latest message is ours
    await expect(page.getByRole("link", { name: "Billing Robot" })).toHaveCount(0);

    await page.goto(`/inbox?mailbox=${boxB}&view=replied`);
    await expect(page.getByRole("link", { name: "Billing Robot" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Away Person" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Answered Person" })).toHaveCount(0);

    await page.goto(`/inbox?mailbox=${boxB}&view=automated`);
    await expect(page.getByRole("link", { name: "Billing Robot" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Away Person" })).toBeVisible();
    const automatedRows = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: /Billing Robot|Away Person/ }) });
    await expect(automatedRows.getByText("Auto-reply", { exact: true }).first()).toBeVisible();

    await page.goto(`/inbox?mailbox=${boxB}`);
    await expect(page.getByRole("link", { name: "Billing Robot" })).toHaveCount(0);
    await expect(page.getByText(/2 automated conversations are hidden/)).toBeVisible();
    await page.getByRole("link", { name: "Show automated" }).click();
    await expect(page).toHaveURL(/view=automated/);
    await expect(page.getByRole("link", { name: "Billing Robot" })).toBeVisible();

    // Search reaches the first message of a four-message thread, and filters combine with it.
    await page.goto(`/inbox?mailbox=${boxB}&q=gadolinium`);
    await expect(page.getByRole("link", { name: "Long Thread" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Answered Person" })).toHaveCount(0);
    await page.goto(`/inbox?mailbox=${boxA}&q=gadolinium`);
    await expect(page.getByText("No conversations match")).toBeVisible();

    // Scheduled: read-only queue of campaign steps, soonest first, without the paused campaign.
    await page.goto(`/inbox?mailbox=${boxB}&view=scheduled`);
    await expect(page.getByText(/Queued in the campaign/)).toBeVisible();
    await expect(page.getByRole("cell", { name: /Queued Quinn/ })).toBeVisible();
    await expect(page.getByText("Second touch")).toBeVisible();
    await expect(page.getByText("Paused Pat")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Queued Quinn/ })).toHaveCount(0);

    // A custom date range through the panel: nothing was written on 2020-01-01.
    await page.goto(`/inbox?mailbox=${boxA}`);
    await openFilters(page);
    await page.locator("#f-range").selectOption("custom");
    await page.locator("#f-from").fill("2020-01-01");
    await page.locator("#f-to").fill("2020-01-01");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page).toHaveURL(/range=custom/);
    await expect(page.getByText("No conversations match")).toBeVisible();
    await page.getByRole("link", { name: /Remove filter Dates/ }).click();
    await expect(page.getByText("27 conversations, page 1 of 2")).toBeVisible();
  });
});
