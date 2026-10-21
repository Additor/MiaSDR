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
});
