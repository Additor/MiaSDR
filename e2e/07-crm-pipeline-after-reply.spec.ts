import { afterReplySettings, enableAiFollowUps, expect, seedReply, signInAdmin, test, threadAfterReply, tick } from "./support/fixtures";

const LEAD = { email: "rae@s7-co.test", firstName: "Rae", lastName: "Costa", title: "Founder", company: "S7 Co" };
const HANDOFF_LEAD = { email: "hal@s7-hand.test", firstName: "Hal", lastName: "Ortiz", title: "Founder", company: "S7 Hand" };
const SWITCH_LEAD = { email: "ivo@s7-switch.test", firstName: "Ivo", lastName: "Berg", title: "Founder", company: "S7 Switch" };
const CONTACT_LEAD = { email: "cass@s7-contact.test", firstName: "Cass", lastName: "Moreno", title: "Founder", company: "S7 Contact" };

/** The reply category card in the side column of an Inbox thread. */
const replyCategory = (page: import("@playwright/test").Page) => page.locator("#main-content").getByTestId("reply-category");

test.describe("reply handling on the thread and After a reply", () => {
  test("turn on AI follow-ups, let a reply start the run, control it on the thread, change the category", async ({ page }) => {
    await signInAdmin(page);

    // The campaign emails Rae first. Before her reply arrives, its After a reply setting goes to "AI drafts follow-ups for my approval".
    const { campaignId } = await seedReply(page.request, {
      key: "S7",
      mailbox: "sdr7@e2e-corp.test",
      lead: LEAD,
      reply: { bodyText: "We would like a demo of the product." },
      beforeReply: (id) => enableAiFollowUps(page, id, { replyGoal: "Answer the demo request and offer two times.", followUpGoal: "Check in once and offer two meeting times.", wait: 2, unit: "Hours" }),
    });
    await tick(page.request, 3);

    // The saved setting survives a reload: both steps, the wait in hours, the read-only stop list and no run yet.
    await page.goto(`/campaigns/${campaignId}?tab=settings`);
    const settings = afterReplySettings(page);
    await expect(settings.getByRole("radio", { name: /AI drafts follow-ups for my approval/ })).toBeChecked();
    await expect(settings.getByText("1. Reply to their answer")).toBeVisible();
    await expect(settings.getByText("2. Follow-up")).toBeVisible();
    await expect(settings.getByLabel("Goal").nth(1)).toHaveValue("Check in once and offer two meeting times.");
    await expect(settings.getByLabel("Wait after the previous message")).toHaveValue("2");
    await expect(settings.getByRole("combobox", { name: "Unit for step 2" })).toContainText("Hours");
    await expect(settings.getByRole("heading", { name: "Always stops on" })).toBeVisible();

    // The run shows under Follow-ups in progress on the campaign and links to the conversation.
    await page.goto(`/campaigns/${campaignId}?tab=settings`);
    await expect(settings.getByRole("heading", { name: "Follow-ups in progress (1)" })).toBeVisible();
    await settings.getByRole("link", { name: "Rae Costa" }).click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);

    // A reply asking for a demo is classified and starts the run. The thread's side column holds what the record page had.
    await expect(replyCategory(page)).toContainText("Demo request");
    await expect(page.locator("#main-content").getByTestId("thread-person").getByRole("link", { name: "Open lead" })).toBeVisible();
    // Campaigns, like the other histories, folds behind its count.
    const campaigns = page.locator("#main-content").getByTestId("thread-campaigns");
    await campaigns.locator("summary").click();
    await expect(campaigns.getByRole("link", { name: "S7 campaign" })).toBeVisible();

    // The After a reply card names the campaign and the run is going. Pause, resume, skip, stop and restart.
    const card = threadAfterReply(page);
    await expect(card.getByRole("link", { name: "S7 campaign" })).toBeVisible();
    await expect(card.locator('[data-slot="badge"]').getByText("Running", { exact: true })).toBeVisible();
    await expect(card.getByRole("listitem").filter({ hasText: "2. Follow-up" })).toHaveCount(1);
    await expect(page.locator("#main-content").getByTestId("thread-activity")).toContainText("Started follow-ups");

    await card.getByRole("button", { name: "Pause follow-ups" }).click();
    await expect(page.getByText("Follow-ups paused.", { exact: true })).toBeVisible();
    await expect(card.locator('[data-slot="badge"]').getByText("Paused", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.getByText("Follow-ups resumed.", { exact: true })).toBeVisible();
    await expect(card.locator('[data-slot="badge"]').getByText("Running", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: "Skip step" }).click();
    await expect(page.getByText("Step skipped.", { exact: true })).toBeVisible();
    await expect(card.getByText("Skipped", { exact: true })).toBeVisible();

    // Stop asks first in place, like the other stops, and Keep following up leaves the run going.
    await card.getByRole("button", { name: "Stop follow-ups" }).click();
    const stop = card.getByTestId("stop-follow-ups");
    await expect(stop).toContainText("Stopped follow-ups cannot resume");
    await stop.getByRole("button", { name: "Keep following up" }).click();
    await expect(stop).toBeHidden();
    await expect(card.locator('[data-slot="badge"]').getByText("Running", { exact: true })).toBeVisible();
    await expect(card.getByText("Cancelled", { exact: true })).toHaveCount(0);
    await card.getByRole("button", { name: "Stop follow-ups" }).click();
    await stop.getByRole("button", { name: "Confirm stop" }).click();
    await expect(page.getByText("Follow-ups stopped.", { exact: true })).toBeVisible();
    await expect(card.getByText("Cancelled", { exact: true }).first()).toBeVisible();
    await expect(page.locator("#main-content").getByTestId("thread-activity")).toContainText("Stopped follow-ups");

    // The campaign is in ai_drafts mode, so the thread offers a restart.
    await card.getByRole("button", { name: "Restart follow-ups" }).click();
    await expect(page.getByText("Follow-ups restarted.", { exact: true })).toBeVisible();
    await expect(card.locator('[data-slot="badge"]').getByText("Running", { exact: true })).toBeVisible();

    // A paused campaign cannot restart follow-ups. The button stays, disabled, and the card says why.
    const paused = await page.request.post(`/api/campaigns/${campaignId}/status`, { data: { status: "paused" } });
    expect(paused.status(), "pause the campaign").toBe(200);
    await page.reload();
    await expect(card.getByRole("button", { name: "Restart follow-ups" })).toBeDisabled();
    await expect(card.getByText(/is paused\. Resume it to restart follow-ups\./)).toBeVisible();
    const resumed = await page.request.post(`/api/campaigns/${campaignId}/status`, { data: { status: "active" } });
    expect(resumed.status(), "resume the campaign").toBe(200);
    await page.reload();
    await expect(card.getByRole("button", { name: "Restart follow-ups" })).toBeEnabled();

    // Change the reply category on the thread. The Pipeline board holds deals now (e2e/35).
    await replyCategory(page).getByRole("button", { name: "Change category" }).click();
    const change = page.getByRole("dialog", { name: "Change the category of Rae Costa" });
    await change.getByRole("radio", { name: /Something happened off the thread/ }).check();
    await change.getByRole("combobox", { name: "New category" }).click();
    await page.getByRole("option", { name: "Interested: Meeting requested" }).click();
    await change.getByLabel("Note (optional)").fill("Booked for Thursday");
    await change.getByRole("button", { name: "Change category", exact: true }).click();
    await expect(change).toBeHidden();
    await expect(replyCategory(page)).toContainText("Interested: Meeting requested");
    await expect(replyCategory(page)).toContainText("Set by a person");
    await expect(page.locator("#main-content").getByTestId("thread-activity")).toContainText("Changed category");
    await page.reload();
    await expect(replyCategory(page)).toContainText("Meeting requested");
    await expect(replyCategory(page)).not.toContainText("Demo request");
  });

  test("a lead who replies to a campaign that hands replies to the Inbox gets no follow-ups, and reply handling closes and reopens", async ({ page }) => {
    await signInAdmin(page);
    const { campaignId } = await seedReply(page.request, {
      key: "S7H",
      mailbox: "sdr7h@e2e-corp.test",
      lead: HANDOFF_LEAD,
      reply: { bodyText: "We would like a demo of the product." },
    });
    await tick(page.request, 3);

    // The default is the handoff, and nothing runs for the campaign.
    await page.goto(`/campaigns/${campaignId}?tab=settings`);
    const settings = afterReplySettings(page);
    await expect(settings.getByRole("radio", { name: /hand the conversation to the Inbox/i })).toBeChecked();
    await expect(settings.getByRole("radio", { name: /AI drafts follow-ups for my approval/ })).not.toBeChecked();
    await expect(settings.getByRole("heading", { name: "Follow-ups in progress (0)" })).toBeVisible();
    await expect(settings.getByText("No follow-ups are running for this campaign.")).toBeVisible();

    // The reply waits in the Inbox. Nothing follows up, so the thread shows no Follow-ups; the campaign's row says why.
    await page.goto("/inbox");
    await page.getByRole("link", { name: /Hal Ortiz/ }).first().click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}/);
    await expect(threadAfterReply(page)).toHaveCount(0);
    const campaigns = page.locator("#main-content").getByTestId("thread-campaigns");
    await campaigns.locator("summary").click();
    await expect(campaigns.getByTestId("campaign-handoff")).toContainText("Replies go to the Inbox.");
    await expect(campaigns.getByRole("link", { name: "Turn on AI follow-ups" })).toHaveAttribute("href", /#after-reply$/);
    await expect(page.getByText("Started follow-ups")).toHaveCount(0);

    // Close reply handling with a reason, then reopen it. Closing sits at the foot of the panel and works like the
    // other stops: a quiet button opens the reason, and a missing reason is said on confirm. Closed, the reply category
    // says so and offers Reopen in place of Change category.
    const category = replyCategory(page);
    const handling = page.locator("#main-content").getByTestId("thread-reply-handling");
    await handling.getByRole("button", { name: "Close reply handling" }).click();
    await expect(handling.getByText("Closing stops follow-ups on every channel and retires unsent drafts.", { exact: false })).toBeVisible();
    await handling.getByRole("button", { name: "Confirm close" }).click();
    await expect(handling.getByRole("alert")).toHaveText("Type a reason to close reply handling.");
    await handling.getByLabel("Reason").fill("Talking on the phone now");
    await handling.getByRole("button", { name: "Confirm close" }).click();
    await expect(page.getByText("Reply handling closed.", { exact: true })).toBeVisible();
    await expect(category).toContainText("Reply handling closed: Talking on the phone now.");
    await expect(category.getByRole("button", { name: "Change category" })).toHaveCount(0);
    await expect(handling).toHaveCount(0);
    await category.getByRole("button", { name: "Reopen" }).click();
    await expect(page.getByText("Reply handling reopened.", { exact: true })).toBeVisible();
    await expect(category.getByRole("button", { name: "Change category" })).toBeVisible();
  });

  test("a contact's thread keeps reply handling but turns follow-ups off and offers the deal", async ({ page }) => {
    await signInAdmin(page);
    await seedReply(page.request, { key: "S7C", mailbox: "sdr7c@e2e-corp.test", lead: CONTACT_LEAD, reply: { bodyText: "We would like a demo of the product." } });
    await tick(page.request, 3);
    await page.goto("/inbox");
    await page.getByRole("link", { name: /Cass Moreno/ }).first().click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}/);
    const person = page.locator("#main-content").getByTestId("thread-person");

    // Create deal from the thread: the lead becomes a contact and the dialog opens the deal page.
    await person.getByRole("button", { name: "Create deal" }).click();
    const dialog = page.getByRole("dialog", { name: "Create deal for Cass Moreno" });
    await expect(dialog).toContainText("Moves Cass Moreno to Contacts.");
    await dialog.getByRole("button", { name: "Create deal" }).click();
    // The deal page keeps the thread as its origin, so Back and a delete return to it.
    await expect(page).toHaveURL(/\/crm\/deals\/[0-9a-f-]{36}\?from=%2Finbox%2F[0-9a-f-]{36}$/);
    await page.goBack();
    await page.reload();

    await expect(person.getByRole("link", { name: "Open deal" })).toHaveAttribute("href", /^\/crm\/deals\/[0-9a-f-]{36}\?from=%2Finbox%2F[0-9a-f-]{36}$/);
    await expect(person.getByRole("link", { name: "Open contact" })).toHaveAttribute("href", /^\/crm\/contacts\/[0-9a-f-]{36}$/);
    // A contact gets no follow-ups, and with no run to show the thread has no Follow-ups section.
    await expect(threadAfterReply(page)).toHaveCount(0);
    // Reply handling itself stays: the category can still change, and the activity names the conversion.
    await expect(replyCategory(page).getByRole("button", { name: "Change category" })).toBeVisible();
    await expect(page.locator("#main-content").getByTestId("thread-activity")).toContainText("Became a contact");
  });

  test("switching AI follow-ups off asks first, and confirming stops the follow-ups in progress", async ({ page }) => {
    await signInAdmin(page);
    const { campaignId } = await seedReply(page.request, {
      key: "S7S",
      mailbox: "sdr7s@e2e-corp.test",
      lead: SWITCH_LEAD,
      reply: { bodyText: "We would like a demo of the product." },
      beforeReply: (id) => enableAiFollowUps(page, id),
    });
    await tick(page.request, 3);

    await page.goto(`/campaigns/${campaignId}?tab=settings`);
    const settings = afterReplySettings(page);
    await expect(settings.getByRole("heading", { name: "Follow-ups in progress (1)" })).toBeVisible();

    // Back to the handoff: Save opens the confirmation. Keep following up leaves the run alone.
    await settings.getByRole("radio", { name: /hand the conversation to the Inbox/i }).check();
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Stop 1 follow-up in progress?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep following up" }).click();
    await expect(dialog).toBeHidden();
    await expect(settings.getByRole("heading", { name: "Follow-ups in progress (1)" })).toBeVisible();

    // Confirming switches the setting off and stops the run.
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("dialog", { name: "Stop 1 follow-up in progress?" }).getByRole("button", { name: "Switch off follow-ups" }).click();
    await expect(page.getByText(/Follow-ups switched off\. 1 stopped\./)).toBeVisible();
    await expect(settings.getByRole("heading", { name: "Follow-ups in progress (0)" })).toBeVisible();
    await expect(settings.getByRole("radio", { name: /hand the conversation to the Inbox/i })).toBeChecked();
  });
});
