import { deliverInbound, expect, makeInboxSyncDue, seedReply, signInAdmin, sql, test, tick, waitForHydrated } from "./support/fixtures";

/** A reply with its AI draft, then a second message in the thread, which puts the draft out of date. */
async function staleThread(page: Parameters<typeof signInAdmin>[0], key: string) {
  const lead = { email: `nora@${key}.test`, firstName: "Nora", lastName: "Quist", title: "Head of Sales", company: `${key} Ltd` };
  const { sent } = await seedReply(page.request, { key, mailbox: `sdr-${key}@e2e-corp.test`, lead, reply: { bodyText: "Can you send pricing for ten seats?" } });
  await deliverInbound(page.request, { mailbox: sent.mailbox.emailAddress, fromEmail: lead.email, fromName: "Nora Quist", subject: `Re: ${sent.subject}`, bodyText: "Also, do you integrate with HubSpot?", inReplyTo: sent.rfcMessageId });
  await makeInboxSyncDue();
  await tick(page.request, 3);
  const [row] = await sql()`select c.id from conversations c join records r on r.id = c.record_id join people p on p.id = r.person_id where p.email = ${lead.email} limit 1`;
  return row.id as string;
}

test.describe("the conversation page", () => {
  test("an out-of-date draft shows once, read-only, with Regenerate first and a way to edit and send it", async ({ page }) => {
    await signInAdmin(page);
    const id = await staleThread(page, "s45a");
    await page.goto(`/inbox/${id}`);
    const panel = page.getByTestId("reply-panel");
    await expect(panel.getByTestId("draft-status")).toHaveText("Out of date");
    // One editor at most: the old text is a preview, and no composer stacks above it.
    await expect(panel.getByTestId("stale-preview")).toBeVisible();
    await expect(panel.locator("#draft-body")).toHaveCount(0);
    await expect(panel.getByTestId("reply-composer")).toHaveCount(0);
    const actions = panel.getByTestId("reply-actions");
    await expect(actions.getByRole("button")).toHaveText(["Regenerate", "Edit and send anyway", "Discard"]);

    await waitForHydrated(actions.getByRole("button", { name: "Edit and send anyway" }));
    await actions.getByRole("button", { name: "Edit and send anyway" }).click();
    const composer = panel.getByTestId("reply-composer");
    await expect(composer.getByLabel("Message")).not.toHaveValue("");
    await composer.getByRole("button", { name: "Create draft" }).click();
    await expect(panel.getByTestId("draft-status")).toHaveText("Awaiting review");
    await expect(panel.getByRole("button", { name: "Approve and send" })).toBeVisible();
  });

  test("the type line under the latest message names the type, and Change type is the one place to correct it", async ({ page }) => {
    await signInAdmin(page);
    const lead = { email: "omar@s45b.test", firstName: "Omar", lastName: "Reyes", title: "COO", company: "S45B Co" };
    await seedReply(page.request, { key: "s45b", mailbox: "sdr-s45b@e2e-corp.test", lead, reply: { bodyText: "Let's book a call next week." } });
    const [row] = await sql()`select c.id from conversations c join records r on r.id = c.record_id join people p on p.id = r.person_id where p.email = ${lead.email} limit 1`;
    await page.goto(`/inbox/${row.id}`);
    const main = page.locator("#main-content");
    const line = main.getByTestId("type-line");
    // The type, its group and what its rules do, with who set it on the sparkle.
    await expect(line.getByTestId("type-name")).toHaveText("Meeting requested · Interested");
    await expect(line).toContainText("Draft · Follow-ups keep going");
    await expect(line.getByTestId("type-source")).toContainText("Picked by the AI");
    // The old places are gone: no Waiting on pair, no Classification card, no category row in Next step.
    await expect(main.getByText("Waiting on")).toHaveCount(0);
    await expect(main.getByTestId("classification")).toHaveCount(0);
    const step = main.getByTestId("next-step");
    await expect(step.getByRole("heading", { level: 2 })).toHaveText("Next step");
    await expect(step.getByRole("button")).toHaveText(["Remind me", "Done, no reply needed", "Stop contacting…"]);
    await expect(page.getByRole("complementary", { name: "Person" }).getByRole("button", { name: "Change type" })).toHaveCount(0);
    // AI picks folds closed under History.
    await expect(main.getByTestId("thread-ai-picks")).not.toHaveAttribute("open", "");

    // The line sits right under the latest message: the element before it is that message.
    await expect(line.locator("xpath=preceding-sibling::*[1]")).toContainText("Let's book a call next week.");

    // Why opens the AI's reasoning in place.
    const why = line.getByRole("button", { name: "Why" });
    await waitForHydrated(why);
    await why.click();
    await expect(line.getByTestId("type-why")).toHaveText("The AI picked Meeting requested · Interested, 90% confident. The sender proposes a meeting.");

    // The applied pick waits for Looks right, beside Change type.
    const decision = line.getByTestId("type-decision");
    await expect(decision.getByRole("button")).toHaveText(["Looks right", "Change type"]);
    await decision.getByRole("button", { name: "Change type" }).click();
    const dialog = page.getByRole("dialog", { name: "Change the reply type of Omar Reyes" });
    await expect(dialog.getByRole("radio", { name: "The AI read the last reply wrong" })).toBeChecked();
    await expect(dialog.getByTestId("ai-reading")).toContainText("The AI picked Meeting requested · Interested, 90% confident");
    await expect(dialog.getByLabel("Note (optional)")).toHaveCount(0);
    // The picker filters as you type and says what the change does before you confirm.
    await dialog.getByRole("combobox", { name: "New type" }).fill("Demo");
    await page.getByRole("option", { name: "Demo request" }).click();
    await expect(dialog.getByTestId("type-outcome")).toContainText("Reply draft: the AI writes a new one.");
    await expect(dialog.getByTestId("type-outcome")).toContainText("Contact: unchanged.");
    await dialog.getByRole("button", { name: "Change type", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(line.getByTestId("type-name")).toHaveText("Demo request · Interested");
    await expect(line.getByTestId("type-source")).toContainText("Set by a person");
    await expect(line.getByTestId("type-decision")).toHaveCount(0);
  });

  test("changing the type keeps what you typed in the draft as the out-of-date draft's text", async ({ page }) => {
    await signInAdmin(page);
    const lead = { email: "ida@s45e.test", firstName: "Ida", lastName: "Holm", title: "VP Sales", company: "S45E Co" };
    await seedReply(page.request, { key: "s45e", mailbox: "sdr-s45e@e2e-corp.test", lead, reply: { bodyText: "Let's book a call next week." } });
    const [row] = await sql()`select c.id from conversations c join records r on r.id = c.record_id join people p on p.id = r.person_id where p.email = ${lead.email} limit 1`;
    await page.goto(`/inbox/${row.id}`);
    const panel = page.getByTestId("reply-panel");
    await expect(panel.getByTestId("draft-status")).toHaveText("Awaiting review");
    await waitForHydrated(panel.getByRole("button", { name: "Approve and send" }));
    // Under a draft that waits for approval, the type line's buttons are outline and Approve and send stays the filled one.
    const looksRight = page.getByTestId("type-decision").getByRole("button", { name: "Looks right" });
    await expect(looksRight).toHaveAttribute("data-variant", "outline");
    await panel.getByLabel("Message").fill("Thursday at ten works. Typed by hand.");

    await page.getByTestId("type-line").getByRole("button", { name: "Change type" }).click();
    const dialog = page.getByRole("dialog", { name: "Change the reply type of Ida Holm" });
    await dialog.getByRole("combobox", { name: "New type" }).fill("Not now");
    await page.getByRole("option", { name: "Not now" }).click();
    await expect(dialog.getByTestId("type-outcome")).toContainText("Reply draft: none. Not now is set to not write one.");
    await dialog.getByRole("button", { name: "Change type", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(panel.getByTestId("draft-status")).toHaveText("Out of date");
    await expect(panel.getByTestId("stale-preview")).toHaveText("Thursday at ten works. Typed by hand.");
  });

  test("a stop request asks for Review stop request, which opens Stop contacting before anything stops", async ({ page }) => {
    await signInAdmin(page);
    const lead = { email: "rui@s45d.test", firstName: "Rui", lastName: "Alves", title: "CTO", company: "S45D Co" };
    await seedReply(page.request, { key: "s45d", mailbox: "sdr-s45d@e2e-corp.test", lead, reply: { bodyText: "Please stop emailing me." } });
    const [row] = await sql()`select c.id from conversations c join records r on r.id = c.record_id join people p on p.id = r.person_id where p.email = ${lead.email} limit 1`;
    await page.goto(`/inbox/${row.id}`);
    const decision = page.getByTestId("type-decision");
    await expect(decision).toContainText("Possible stop request.");
    // Accept is not offered for a stop request: accepting would only change the type.
    await expect(decision.getByRole("button")).toHaveText(["Review stop request", "Change type"]);
    const open = decision.getByRole("button", { name: "Review stop request" });
    await waitForHydrated(open);
    await open.click();
    const dialog = page.getByRole("dialog", { name: "Stop contacting Rui Alves?" });
    await expect(dialog.getByRole("radio", { name: "Every channel" })).toBeChecked();
    // Every channel needs a reason; the address alone does not ask for one.
    await dialog.getByRole("button", { name: "Stop contacting" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Type a reason to mark this person do not contact.");
    await dialog.getByRole("radio", { name: "Only rui@s45d.test" }).check();
    await expect(dialog.getByLabel("Reason")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Keep contacting" }).click();
    await expect(dialog).toBeHidden();
    expect((await sql()`select count(*)::int as n from suppression_list where email = ${lead.email}`)[0].n).toBe(0);

    // A link with ?stop=1 opens the same dialog on load.
    await page.goto(`/inbox/${row.id}?stop=1`);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: "Only rui@s45d.test" }).check();
    await dialog.getByRole("button", { name: "Stop contacting" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("next-step-status")).toContainText("Added rui@s45d.test to the suppression list.");
    await expect(decision).toHaveCount(0);
  });

  test("Change type to Asked to stop asks how far the stop reaches, and Only change the type stops nothing", async ({ page }) => {
    await signInAdmin(page);
    const lead = { email: "lea@s45f.test", firstName: "Lea", lastName: "Brandt", title: "CEO", company: "S45F Co" };
    await seedReply(page.request, { key: "s45f", mailbox: "sdr-s45f@e2e-corp.test", lead, reply: { bodyText: "Not now, maybe next year." } });
    const [row] = await sql()`select c.id, p.id as person_id from conversations c join records r on r.id = c.record_id join people p on p.id = r.person_id where p.email = ${lead.email} limit 1`;
    await page.goto(`/inbox/${row.id}`);
    const line = page.getByTestId("type-line");
    await expect(line.getByTestId("type-name")).toHaveText("Not now · Not interested");
    // Not now writes no draft, and the reply card says why instead of "No draft yet."
    await expect(page.getByTestId("reply-panel").getByTestId("no-draft")).toContainText("No draft: Not now replies get none.");

    const change = line.getByRole("button", { name: "Change type" });
    await waitForHydrated(change);
    await change.click();
    const dialog = page.getByRole("dialog", { name: "Change the reply type of Lea Brandt" });
    await dialog.getByRole("combobox", { name: "New type" }).fill("Asked");
    await page.getByRole("option", { name: "Asked to stop" }).click();
    await expect(dialog.getByTestId("type-outcome")).toContainText("Contact: unchanged until you choose Stop contacting.");
    const stop = dialog.getByTestId("type-stop");
    await expect(stop.getByRole("radio", { name: "Every channel" })).toBeChecked();
    await expect(stop.getByLabel("Reason")).toBeVisible();
    await dialog.getByRole("button", { name: "Only change the type" }).click();
    await expect(dialog).toBeHidden();
    await expect(line.getByTestId("type-name")).toHaveText("Asked to stop · Not interested");
    expect((await sql()`select count(*)::int as n from contact_policies where person_id = ${row.person_id} and do_not_contact`)[0].n).toBe(0);
  });

  test("a held pick with no draft opens the type line in place, and hand-typing waits behind one button", async ({ page }) => {
    await signInAdmin(page);
    const lead = { email: "pia@s45c.test", firstName: "Pia", lastName: "Lund", title: "CISO", company: "S45C Co" };
    await seedReply(page.request, { key: "s45c", mailbox: "sdr-s45c@e2e-corp.test", lead, reply: { bodyText: "Send the security questionnaire when you can." } });
    const [row] = await sql()`select c.id from conversations c join records r on r.id = c.record_id join people p on p.id = r.person_id where p.email = ${lead.email} limit 1`;
    await page.goto(`/inbox/${row.id}`);
    const panel = page.getByTestId("reply-panel");
    const decision = page.getByTestId("type-decision");
    await expect(decision).toContainText("The AI picked Unclear");
    // The decision comes before the reply card, and it holds the one filled button.
    const order = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="type-decision"]');
      const w = document.querySelector('[data-testid="write-yourself"]');
      return d && w ? d.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
    });
    expect(order, "type decision before the reply").toBeGreaterThan(0);
    await expect(panel.getByTestId("reply-composer")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Write a draft" })).toHaveAttribute("data-variant", "outline");

    const accept = decision.getByRole("button", { name: "Accept" });
    await waitForHydrated(accept);
    await accept.click();
    await expect(page.getByTestId("type-status")).toContainText("AI pick accepted.");
    await expect(decision).toHaveCount(0);

    await panel.getByTestId("write-yourself").click();
    await expect(panel.getByTestId("reply-composer")).toBeVisible();
  });
});
