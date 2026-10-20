import { delivered, deliverInbound, ensureMailbox, expect, importLeads, makeInboxSyncDue, openAddLeads, openCampaignTab, signInAdmin, test, tick } from "./support/fixtures";

const LEAD = { email: "nora@s5-works.test", firstName: "Nora", lastName: "Lindqvist", title: "COO", company: "S5 Works" };
const MAILBOX = "sdr5@e2e-corp.test";

test.describe("send, reply and stop", () => {
  test("a sent step, then a reply, stops the lead's campaign steps", async ({ page }) => {
    await signInAdmin(page);
    await ensureMailbox(page.request, MAILBOX, "Sam Five");
    // The first inbox sync only records where the mailbox is. Mail that arrives later is picked up.
    await tick(page.request);
    await importLeads(page.request, [LEAD]);

    await page.goto("/campaigns");
    await page.getByRole("button", { name: "New campaign" }).click();
    await page.getByLabel("Name").fill("S5 reply stop");
    await page.getByRole("button", { name: "Create campaign" }).click();
    await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);
    const campaignUrl = page.url();

    // Steps are on the Sequence tab.
    await openCampaignTab(page, "sequence");
    await page.getByLabel("Subject", { exact: true }).fill("Hello {{firstName}} from S5");
    await page.getByLabel("Message").first().fill("Hi {{firstName}}, do you have ten minutes this week?");
    await page.getByRole("button", { name: "Save steps" }).click();
    await expect(page.getByText("Steps saved.")).toBeVisible();

    // The Leads tab opens the Add leads panel while the campaign has no leads.
    await openCampaignTab(page, "leads");
    await openAddLeads(page);
    await page.getByPlaceholder(/Search name, email, title or company/).fill("s5-works");
    await page.getByRole("button", { name: "Add matching leads" }).click();
    await expect(page.locator('[role="status"]').filter({ hasText: "Added 1 lead." })).toBeVisible();
    await page.getByRole("button", { name: "Start campaign" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Start campaign" }).click();
    await expect(page.getByText("Campaign is running.")).toBeVisible();

    // The send job delivers step 1.
    await tick(page.request);
    let sent = (await delivered(page.request)).filter((m) => m.to === LEAD.email);
    await expect.poll(async () => {
      await tick(page.request);
      sent = (await delivered(page.request)).filter((m) => m.to === LEAD.email);
      return sent.length;
    }).toBe(1);
    expect(sent[0].subject).toBe("Hello Nora from S5");
    expect(sent[0].bodyText).toContain("Hi Nora, do you have ten minutes this week?");

    await page.reload();
    const row = page.getByRole("row", { name: new RegExp(LEAD.email) });
    await expect(row).toContainText("1/2");
    await expect(row).toContainText(/in sequence/i);

    // The lead answers the thread.
    await deliverInbound(page.request, {
      mailbox: sent[0].mailbox.emailAddress,
      fromEmail: LEAD.email,
      fromName: "Nora Lindqvist",
      subject: `Re: ${sent[0].subject}`,
      bodyText: "Yes, Thursday works. Talk then.",
      inReplyTo: sent[0].rfcMessageId,
    });
    await makeInboxSyncDue();
    await tick(page.request, 2);

    await page.reload();
    await expect(row).toContainText(/replied/i);
    await expect(row).not.toContainText(/in sequence/i);

    // The Replied filter chip lists her (the status filter is ?status=), and an older ?tab=replied link opens the same filter.
    await page.getByTestId("tab-replied").click();
    await expect(page).toHaveURL(/[?&]status=replied/);
    await expect(page.getByTestId("tab-replied")).toHaveAttribute("aria-current", "true");
    await expect(row).toBeVisible();
    await page.goto(`${campaignUrl}?tab=replied`);
    await expect(page.getByTestId("campaign-tab-leads")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("tab-replied")).toHaveAttribute("aria-current", "true");
    await expect(row).toBeVisible();

    // More ticks send nothing further to this lead.
    await tick(page.request, 2);
    expect((await delivered(page.request)).filter((m) => m.to === LEAD.email)).toHaveLength(1);

    // The reply is in the inbox.
    await page.goto("/inbox");
    await expect(page.getByRole("link", { name: /Nora Lindqvist/ })).toBeVisible();
  });
});
