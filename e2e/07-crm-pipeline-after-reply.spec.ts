import { afterReplySettings, enableAiFollowUps, expect, seedReply, signInAdmin, test, threadAfterReply, tick } from "./support/fixtures";

const LEAD = { email: "rae@s7-co.test", firstName: "Rae", lastName: "Costa", title: "Founder", company: "S7 Co" };
const HANDOFF_LEAD = { email: "hal@s7-hand.test", firstName: "Hal", lastName: "Ortiz", title: "Founder", company: "S7 Hand" };
const SWITCH_LEAD = { email: "ivo@s7-switch.test", firstName: "Ivo", lastName: "Berg", title: "Founder", company: "S7 Switch" };
const CONTACT_LEAD = { email: "cass@s7-contact.test", firstName: "Cass", lastName: "Moreno", title: "Founder", company: "S7 Contact" };

/** The thread's Next step, under the reply, and the type line under the latest message. */
const nextStep = (page: import("@playwright/test").Page) => page.locator("#main-content").getByTestId("next-step");
const typeLine = (page: import("@playwright/test").Page) => page.locator("#main-content").getByTestId("type-line");

test.describe("reply handling on the thread and Follow-ups after a reply", () => {
  test("turn on AI follow-ups, let a reply start the run, control it on the thread, change the type", async ({ page }) => {
    await signInAdmin(page);

    // The campaign emails Rae first. Before her reply arrives, its Follow-ups after a reply setting goes to "AI drafts, you approve".
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
    await expect(settings.getByRole("radio", { name: /AI drafts, you approve/ })).toBeChecked();
    await expect(settings.getByText("1. Reply to their answer")).toBeVisible();
    await expect(settings.getByText("2. Follow-up")).toBeVisible();
    await expect(settings.getByLabel("Goal").nth(1)).toHaveValue("Check in once and offer two meeting times.");
    await expect(settings.getByLabel("Wait after the previous message")).toHaveValue("2");
    await expect(settings.getByRole("combobox", { name: "Unit for step 2" })).toContainText("Hours");
    // The reply types set to stop follow-ups, read from Reply handling, then the fixed stop rules in one line.
    await expect(settings.getByRole("heading", { name: "Follow-ups after a reply", level: 2 })).toBeVisible();
    const stops = settings.getByTestId("after-reply-stops");
    await expect(stops).toContainText("lands on the suppression list");
    await expect(stops.getByRole("heading", { name: "Stops for these reply types" })).toBeVisible();
    await expect(stops).toContainText("Asked to stop");
    await expect(stops.getByRole("link", { name: "Change in Settings" })).toHaveAttribute("href", "/settings/replies");

    // The run shows under Follow-ups in progress on the campaign and links to the conversation.
    await page.goto(`/campaigns/${campaignId}?tab=settings`);
    await expect(settings.getByRole("heading", { name: "Follow-ups in progress" })).toBeVisible();
    await expect(settings.getByTestId("after-reply-in-progress-count")).toHaveText("1");
    await settings.getByRole("link", { name: "Rae Costa" }).click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);

    // A reply asking for a demo is classified and starts the run. The thread's side column holds what the record page had.
    await expect(typeLine(page).getByTestId("type-name")).toContainText("Demo request");
    await expect(page.locator("#main-content").getByTestId("thread-person").getByRole("link", { name: "Open lead" })).toBeVisible();
    // Campaigns, like the other histories, folds behind its count.
    const campaigns = page.locator("#main-content").getByTestId("thread-campaigns");
    await campaigns.locator("summary").click();
    await expect(campaigns.getByRole("link", { name: "S7 campaign" })).toBeVisible();

    // The Follow-ups card names the campaign and the run is going. Pause, resume, skip, stop and restart.
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

    // Change the reply type on the thread, for something that happened off it. The Pipeline board holds deals now (e2e/35).
    await typeLine(page).getByRole("button", { name: "Change type" }).click();
    const change = page.getByRole("dialog", { name: "Change the reply type of Rae Costa" });
    await change.getByRole("radio", { name: /Something happened off the thread/ }).check();
    await change.getByRole("combobox", { name: "New type" }).fill("Meeting");
    await page.getByRole("option", { name: "Meeting requested" }).click();
    // The off-thread path writes no draft, and the line says so.
    await expect(change.getByTestId("type-outcome")).toContainText("Reply draft: none written now. Write a draft from the reply when you need one.");
    await expect(change.getByTestId("type-outcome")).toContainText("Follow-ups: keep going.");
    await change.getByLabel("Note (optional)").fill("Booked for Thursday");
    await change.getByRole("button", { name: "Change type", exact: true }).click();
    await expect(change).toBeHidden();
    await expect(typeLine(page).getByTestId("type-name")).toContainText("Meeting requested · Interested");
    await expect(typeLine(page).getByTestId("type-source")).toContainText("Set by a person");
    await expect(page.locator("#main-content").getByTestId("thread-activity")).toContainText("Changed the reply type");
    await page.reload();
    await expect(typeLine(page).getByTestId("type-name")).toContainText("Meeting requested");
    await expect(typeLine(page).getByTestId("type-name")).not.toContainText("Demo request");
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
    await expect(settings.getByRole("radio", { name: /Off, hand to the Inbox/ })).toBeChecked();
    await expect(settings.getByRole("radio", { name: /AI drafts, you approve/ })).not.toBeChecked();
    await expect(settings.getByText("The AI still drafts a first reply for reply types set to Write one.", { exact: false })).toBeVisible();
    await expect(settings.getByRole("heading", { name: "Follow-ups in progress" })).toBeVisible();
    await expect(settings.getByTestId("after-reply-in-progress-count")).toHaveText("0");
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

    // Finish without a reply, then reopen. Done sits under the reply in Next step: its reason starts as the reply type, a
    // missing reason is said on confirm, and closed, Next step says so and the type line offers no Change type.
    const step = nextStep(page);
    const line = typeLine(page);
    await expect(page.locator("#main-content").getByTestId("thread-reply-handling")).toHaveCount(0);
    await step.getByRole("button", { name: "Done, no reply needed" }).click();
    const done = step.getByTestId("done-form");
    await expect(done.getByLabel("Reason")).toHaveValue("Demo request");
    await expect(done.getByText("Retires unsent drafts and stops follow-ups on every channel.", { exact: false })).toBeVisible();
    await done.getByLabel("Reason").fill("");
    await done.getByRole("button", { name: "Mark done" }).click();
    await expect(done.getByRole("alert")).toHaveText("Say why no reply is needed.");
    await done.getByLabel("Reason").fill("Talking on the phone now");
    await done.getByRole("button", { name: "Mark done" }).click();
    await expect(step.getByTestId("next-step-status")).toContainText("Marked done for Hal Ortiz.");
    await expect(step.getByTestId("reply-handling")).toContainText("Done: Talking on the phone now.");
    await expect(line.getByRole("button", { name: "Change type" })).toHaveCount(0);
    await expect(step.getByRole("button", { name: "Done, no reply needed" })).toHaveCount(0);
    await step.getByRole("button", { name: "Reopen" }).click();
    await expect(page.getByText("Reopened.", { exact: true })).toBeVisible();
    await expect(line.getByRole("button", { name: "Change type" }).first()).toBeVisible();
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
    // Reply handling itself stays: the reply type can still change, and the activity names the conversion.
    await expect(typeLine(page).getByRole("button", { name: "Change type" }).first()).toBeVisible();
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
    await expect(settings.getByRole("heading", { name: "Follow-ups in progress" })).toBeVisible();
    await expect(settings.getByTestId("after-reply-in-progress-count")).toHaveText("1");

    // Back to the handoff: Save opens the confirmation. Keep following up leaves the run alone.
    await settings.getByRole("radio", { name: /Off, hand to the Inbox/ }).check();
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Stop 1 follow-up in progress?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep following up" }).click();
    await expect(dialog).toBeHidden();
    await expect(settings.getByRole("heading", { name: "Follow-ups in progress" })).toBeVisible();
    await expect(settings.getByTestId("after-reply-in-progress-count")).toHaveText("1");

    // Confirming switches the setting off and stops the run.
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("dialog", { name: "Stop 1 follow-up in progress?" }).getByRole("button", { name: "Switch off follow-ups" }).click();
    await expect(page.getByText(/Follow-ups switched off\. 1 stopped\./)).toBeVisible();
    await expect(settings.getByRole("heading", { name: "Follow-ups in progress" })).toBeVisible();
    await expect(settings.getByTestId("after-reply-in-progress-count")).toHaveText("0");
    await expect(settings.getByRole("radio", { name: /Off, hand to the Inbox/ })).toBeChecked();
  });
});
