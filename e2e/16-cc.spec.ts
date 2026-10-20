import { delivered, expect, seedReply, signInAdmin, sql, test, tick } from "./support/fixtures";

const lead = (first: string, domain: string) => ({ email: `${first.toLowerCase()}@${domain}`, firstName: first, lastName: "Cc", title: "Buyer", company: "CC Group" });

test.describe("CC recipients on inbound mail and replies", () => {
  test("a CC on the inbound mail shows in the thread, unchecked on the reply, and an old record link opens the same thread", async ({ page }) => {
    await signInAdmin(page);
    const l = lead("Cora", "s16a.test");
    await seedReply(page.request, {
      key: "S16A",
      mailbox: "sdr16a@e2e-corp.test",
      lead: l,
      reply: { bodyText: "Adding my colleague, could you send pricing and more info?", cc: ["Boss@S16A.test", "sdr16a@e2e-corp.test", l.email, "boss@s16a.test"] },
    });
    await tick(page.request, 2);

    await page.goto("/inbox");
    await page.getByRole("link", { name: /Cora Cc/ }).click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);
    // The message header shows the Cc line as received (lowercased, deduplicated). The reply options leave out the lead and our mailbox.
    await expect(page.getByText(/, cc boss@s16a\.test, sdr16a@e2e-corp\.test, cora@s16a\.test$/)).toBeVisible();
    const options = page.getByTestId("cc-option");
    await expect(options).toHaveCount(1);
    await expect(options.first()).not.toBeChecked();
    await expect(page.getByTestId("cc-options")).toContainText("boss@s16a.test");

    // The record page folded into the thread: an old /crm/records/[id] link lands on this conversation, with the same CC.
    const thread = new URL(page.url()).pathname;
    const [record] = await sql()`select r.id from records r join people p on p.id = r.person_id where p.email = ${l.email}`;
    await page.goto(`/crm/records/${record.id}`);
    await expect(page).toHaveURL(new RegExp(`${thread}$`));
    await expect(page.getByText(/, cc boss@s16a\.test/).first()).toBeVisible();
    await expect(page.getByTestId("cc-option")).toHaveCount(1);
  });

  test("a reply with the CC ticked sends once with the CC header, and the CC is stored on the outbound message", async ({ page }) => {
    await signInAdmin(page);
    const l = lead("Dana", "s16b.test");
    await seedReply(page.request, {
      key: "S16B",
      mailbox: "sdr16b@e2e-corp.test",
      lead: l,
      reply: { bodyText: "Looping in my teammate. Could you send pricing and more info?", cc: ["peer@s16b.test"] },
    });
    await tick(page.request, 2);
    await page.goto("/inbox");
    await page.getByRole("link", { name: /Dana Cc/ }).click();
    await expect(page.getByText("Awaiting review", { exact: true })).toBeVisible();

    const before = (await delivered(page.request)).filter((m) => m.to === l.email).length;
    await page.getByTestId("cc-option").check();
    await page.getByRole("button", { name: "Approve and send" }).click();
    await expect(page.getByText("The reply was sent and is in the thread above.")).toBeVisible();

    const replies = (await delivered(page.request)).filter((m) => m.to === l.email);
    expect(replies).toHaveLength(before + 1);
    expect(replies.at(-1)!.cc).toEqual(["peer@s16b.test"]);

    await page.reload();
    await expect(page.getByText(/to dana@s16b\.test, cc peer@s16b\.test/).first()).toBeVisible();
  });

  test("a reply without ticking the CC goes to the lead only", async ({ page }) => {
    await signInAdmin(page);
    const l = lead("Eli", "s16c.test");
    await seedReply(page.request, {
      key: "S16C",
      mailbox: "sdr16c@e2e-corp.test",
      lead: l,
      reply: { bodyText: "Could you send pricing and more info?", cc: ["quiet@s16c.test"] },
    });
    await tick(page.request, 2);
    await page.goto("/inbox");
    await page.getByRole("link", { name: /Eli Cc/ }).click();
    await expect(page.getByText("Awaiting review", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Approve and send" }).click();
    await expect(page.getByText("The reply was sent and is in the thread above.")).toBeVisible();
    const reply = (await delivered(page.request)).filter((m) => m.to === l.email).at(-1)!;
    expect(reply.cc ?? []).toEqual([]);
  });

  test("a suppressed CC is shown as suppressed and cannot be ticked", async ({ page }) => {
    await signInAdmin(page);
    const l = lead("Finn", "s16d.test");
    await seedReply(page.request, {
      key: "S16D",
      mailbox: "sdr16d@e2e-corp.test",
      lead: l,
      reply: { bodyText: "Could you send pricing and more info?", cc: ["optout@s16d.test"] },
    });
    const [org] = await sql()`select organization_id from people where email = ${l.email}`;
    await sql()`insert into suppression_list (organization_id, email, reason) values (${org.organization_id}, 'optout@s16d.test', 'unsubscribed')`;
    await tick(page.request, 2);
    await page.goto("/inbox");
    await page.getByRole("link", { name: /Finn Cc/ }).click();
    await expect(page.getByText("Awaiting review", { exact: true })).toBeVisible();
    const option = page.getByTestId("cc-option");
    await expect(option).toBeDisabled();
    await expect(page.getByTestId("cc-options").getByText("Suppressed")).toBeVisible();
  });
});
