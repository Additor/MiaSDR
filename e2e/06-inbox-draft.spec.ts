import { delivered, expect, seedReply, signInAdmin, test, tick } from "./support/fixtures";

const LEAD = { email: "pia@s6-group.test", firstName: "Pia", lastName: "Okafor", title: "Head of Ops", company: "S6 Group" };

test.describe("inbox classification and draft approval", () => {
  test("a reply is classified, a draft is edited and approved, and the reply goes out in the thread", async ({ page }) => {
    await signInAdmin(page);
    const { sent } = await seedReply(page.request, {
      key: "S6",
      mailbox: "sdr6@e2e-corp.test",
      lead: LEAD,
      reply: { bodyText: "Thanks for reaching out. Could you send pricing and more info?" },
    });
    await tick(page.request, 2); // classification and drafting run as AI jobs

    await page.goto("/inbox");
    await page.getByRole("link", { name: /Pia Okafor/ }).click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("paragraph").filter({ hasText: "Could you send pricing and more info?" })).toBeVisible();

    // The classifier files it under information requested.
    await expect(page.getByText(/Information requested \(\w+\)/)).toBeVisible();

    // The draft waits for review.
    await expect(page.getByText("Awaiting review", { exact: true })).toBeVisible();
    const body = page.getByLabel("Message", { exact: true });
    await expect(body).toContainText("Hi Pia");
    await body.fill("Hi Pia,\n\nPricing starts at 49 per seat. A case study is attached to the next email.\n\nBest,\nSender S6");
    await page.getByRole("button", { name: "Approve and send" }).click();
    await expect(page.getByText("The reply was sent and is in the thread above.")).toBeVisible();

    const reply = (await delivered(page.request)).filter((m) => m.to === LEAD.email).at(-1)!;
    expect(reply.bodyText).toContain("Pricing starts at 49 per seat.");
    expect(reply.inReplyTo).not.toBeNull();
    expect(reply.mailbox.emailAddress).toBe(sent.mailbox.emailAddress);

    // The thread now shows the outgoing answer.
    await page.reload();
    await expect(page.getByText("Pricing starts at 49 per seat.").first()).toBeVisible();
  });

  test("a draft can be discarded and the lead stays unanswered", async ({ page }) => {
    await signInAdmin(page);
    await seedReply(page.request, {
      key: "S6b",
      mailbox: "sdr6b@e2e-corp.test",
      lead: { email: "quinn@s6-group.test", firstName: "Quinn", lastName: "Haddad", company: "S6 Group" },
      reply: { bodyText: "Could we schedule a call next week?" },
    });
    await tick(page.request, 2);
    await page.goto("/inbox");
    await page.getByRole("link", { name: /Quinn Haddad/ }).click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);
    await expect(page.getByText("Awaiting review", { exact: true })).toBeVisible();
    const before = (await delivered(page.request)).length;
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Discard draft" }).click();
    await expect(page.getByText("Awaiting review", { exact: true })).toHaveCount(0);
    expect((await delivered(page.request)).length).toBe(before);
  });
});
