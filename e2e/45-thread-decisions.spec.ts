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

  test("Change category under Next step is the one place to correct the reading of a reply, and the card keeps the AI's reading", async ({ page }) => {
    await signInAdmin(page);
    const lead = { email: "omar@s45b.test", firstName: "Omar", lastName: "Reyes", title: "COO", company: "S45B Co" };
    await seedReply(page.request, { key: "s45b", mailbox: "sdr-s45b@e2e-corp.test", lead, reply: { bodyText: "Let's book a call next week." } });
    const [row] = await sql()`select c.id from conversations c join records r on r.id = c.record_id join people p on p.id = r.person_id where p.email = ${lead.email} limit 1`;
    await page.goto(`/inbox/${row.id}`);
    // The card shows the reading and offers no category control of its own.
    const card = page.getByTestId("classification");
    await expect(card.getByRole("combobox")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Apply" })).toHaveCount(0);

    // The category sits under the reply, in Next step, not in the side panel.
    const category = page.getByTestId("next-step").getByTestId("reply-category");
    await expect(page.getByTestId("thread-side-loading")).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Person" }).getByRole("button", { name: "Change category" })).toHaveCount(0);
    const open = category.getByRole("button", { name: "Change category" });
    await waitForHydrated(open);
    await open.click();
    const dialog = page.getByRole("dialog", { name: "Change the category of Omar Reyes" });
    await expect(dialog.getByRole("radio", { name: "The AI read the last reply wrong" })).toBeChecked();
    await expect(dialog.getByTestId("ai-reading")).toContainText("The AI read it as Interested");
    await expect(dialog.getByLabel("Note (optional)")).toHaveCount(0);
    // The picker filters as you type and says what the change does before you confirm.
    await dialog.getByRole("combobox", { name: "New category" }).fill("Meeting");
    await page.getByRole("option", { name: "Meeting requested" }).click();
    await expect(dialog.getByTestId("category-consequence")).toHaveText("Retires the open draft, writes a new one for this category and starts its follow-ups.");
    await dialog.getByRole("button", { name: "Change category", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(category).toContainText("Interested: Meeting requested");
    await expect(category).toContainText("Set by a person");
    await expect(card.getByTestId("category-chip")).toContainText("Meeting requested");
  });

  test("changing the category keeps what you typed in the draft as the out-of-date draft's text", async ({ page }) => {
    await signInAdmin(page);
    const lead = { email: "ida@s45e.test", firstName: "Ida", lastName: "Holm", title: "VP Sales", company: "S45E Co" };
    await seedReply(page.request, { key: "s45e", mailbox: "sdr-s45e@e2e-corp.test", lead, reply: { bodyText: "Let's book a call next week." } });
    const [row] = await sql()`select c.id from conversations c join records r on r.id = c.record_id join people p on p.id = r.person_id where p.email = ${lead.email} limit 1`;
    await page.goto(`/inbox/${row.id}`);
    const panel = page.getByTestId("reply-panel");
    await expect(panel.getByTestId("draft-status")).toHaveText("Awaiting review");
    await waitForHydrated(panel.getByRole("button", { name: "Approve and send" }));
    await panel.getByLabel("Message").fill("Thursday at ten works. Typed by hand.");

    const open = page.getByTestId("next-step").getByRole("button", { name: "Change category" });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "Change the category of Ida Holm" });
    await dialog.getByRole("combobox", { name: "New category" }).fill("Not required");
    await page.getByRole("option", { name: "Not required right now" }).click();
    await expect(dialog.getByTestId("category-consequence")).toHaveText("Retires the open draft. This category needs no reply, so none is written.");
    await dialog.getByRole("button", { name: "Change category", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(panel.getByTestId("draft-status")).toHaveText("Out of date");
    await expect(panel.getByTestId("stale-preview")).toHaveText("Thursday at ten works. Typed by hand.");
  });

  test("a stop request opens Stop contacting, which asks how far the stop reaches before anything stops", async ({ page }) => {
    await signInAdmin(page);
    const lead = { email: "rui@s45d.test", firstName: "Rui", lastName: "Alves", title: "CTO", company: "S45D Co" };
    await seedReply(page.request, { key: "s45d", mailbox: "sdr-s45d@e2e-corp.test", lead, reply: { bodyText: "Please stop emailing me." } });
    const [row] = await sql()`select c.id from conversations c join records r on r.id = c.record_id join people p on p.id = r.person_id where p.email = ${lead.email} limit 1`;
    await page.goto(`/inbox/${row.id}`);
    const banner = page.getByTestId("stop-banner");
    const open = banner.getByRole("button", { name: "Stop contacting…" });
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

    await open.click();
    await dialog.getByRole("radio", { name: "Only rui@s45d.test" }).check();
    await dialog.getByRole("button", { name: "Stop contacting" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("next-step-status")).toContainText("Added rui@s45d.test to the suppression list.");
    await expect(banner).toHaveCount(0);
  });

  test("a held suggestion with no draft leads the page, and hand-typing waits behind one button", async ({ page }) => {
    await signInAdmin(page);
    const lead = { email: "pia@s45c.test", firstName: "Pia", lastName: "Lund", title: "CISO", company: "S45C Co" };
    await seedReply(page.request, { key: "s45c", mailbox: "sdr-s45c@e2e-corp.test", lead, reply: { bodyText: "Send the security questionnaire when you can." } });
    const [row] = await sql()`select c.id from conversations c join records r on r.id = c.record_id join people p on p.id = r.person_id where p.email = ${lead.email} limit 1`;
    await page.goto(`/inbox/${row.id}`);
    const panel = page.getByTestId("reply-panel");
    const card = panel.getByTestId("classification");
    await expect(card).toHaveAttribute("open", "");
    // The decision comes before the reply card.
    const order = await panel.evaluate((el) => {
      const c = el.querySelector('[data-testid="classification"]');
      const w = el.querySelector('[data-testid="write-yourself"]');
      return c && w ? c.compareDocumentPosition(w) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
    });
    expect(order, "classification before the reply").toBeGreaterThan(0);
    await expect(panel.getByTestId("reply-composer")).toHaveCount(0);

    const accept = card.getByRole("button", { name: "Accept suggestion" });
    await waitForHydrated(accept);
    await accept.click();
    await expect(panel.getByTestId("decided")).toContainText("Suggestion accepted.");

    await panel.getByTestId("write-yourself").click();
    await expect(panel.getByTestId("reply-composer")).toBeVisible();
  });
});
