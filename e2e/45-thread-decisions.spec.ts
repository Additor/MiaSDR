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

  test("Change category is the one place to correct the reading of a reply, and the card keeps the AI's reading", async ({ page }) => {
    await signInAdmin(page);
    const lead = { email: "omar@s45b.test", firstName: "Omar", lastName: "Reyes", title: "COO", company: "S45B Co" };
    await seedReply(page.request, { key: "s45b", mailbox: "sdr-s45b@e2e-corp.test", lead, reply: { bodyText: "Let's book a call next week." } });
    const [row] = await sql()`select c.id from conversations c join records r on r.id = c.record_id join people p on p.id = r.person_id where p.email = ${lead.email} limit 1`;
    await page.goto(`/inbox/${row.id}`);
    // The card shows the reading and offers no category control of its own.
    const card = page.getByTestId("classification");
    await expect(card.getByRole("combobox")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Apply" })).toHaveCount(0);

    const category = page.getByTestId("reply-category");
    const open = category.getByRole("button", { name: "Change category" });
    await waitForHydrated(open);
    await open.click();
    const dialog = page.getByRole("dialog", { name: "Change the category of Omar Reyes" });
    await expect(dialog.getByRole("radio", { name: "The AI read the last reply wrong" })).toBeChecked();
    await expect(dialog.getByLabel("Note (optional)")).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "New category" }).click();
    await page.getByRole("option", { name: "Interested: Meeting requested" }).click();
    await dialog.getByRole("button", { name: "Change category", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(category).toContainText("Interested: Meeting requested");
    await expect(category).toContainText("Set by a person");
    await expect(card.getByTestId("category-chip")).toContainText("Meeting requested");
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
