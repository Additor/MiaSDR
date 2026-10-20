import type { Page } from "@playwright/test";
import { ADMIN, delivered, devFakes, ensureMailbox, expect, seedMember, signInAdmin, sql, test, tick } from "./support/fixtures";
import { secondBrowser } from "./support/grid";

const MEMBER = { name: "Bea Settings", email: "bea18@e2e-corp.test", password: "bea18-password-1" };

async function openTestDialog(page: Page, mailbox: string) {
  await page.goto("/settings/mailboxes");
  const card = page.getByTestId("mailbox-row").filter({ hasText: mailbox }).first();
  await card.getByRole("button", { name: /^More/ }).click();
  await page.getByRole("menuitem", { name: "Send test email" }).click();
  return page.getByRole("dialog");
}

async function sendFromDialog(dialog: ReturnType<Page["getByRole"]>, to: string) {
  await dialog.getByLabel("Send to").fill(to);
  await dialog.getByRole("button", { name: "Send test" }).click();
  return dialog.getByTestId("test-send-result");
}

test.describe("mailbox test send", () => {
  test("a test email reaches the fake outbox through a claimed kind=test send, then the fourth in an hour is refused", async ({ page }) => {
    await signInAdmin(page);
    const mailbox = "sdr18a@e2e-corp.test";
    await ensureMailbox(page.request, mailbox, "Sam Eighteen");
    await tick(page.request);

    const dialog = await openTestDialog(page, mailbox);
    const result = await sendFromDialog(dialog, "tester18@example.com");
    await expect(result).toContainText("Test email sent to tester18@example.com");

    const out = (await delivered(page.request)).filter((m) => m.to === "tester18@example.com");
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe("MiaSDR test email");
    expect(out[0].mailbox.emailAddress).toBe(mailbox);
    expect(out[0].bodyText).toContain(`test email from ${mailbox}`);

    const rows = await sql()`select s.kind, s.status, s.to_address, s.enrollment_id from sends s join mailboxes m on m.id = s.mailbox_id where m.email_address = ${mailbox}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "test", status: "sent", to_address: "tester18@example.com", enrollment_id: null });
    const audit = await sql()`select count(*)::int as n from audit_log where action = 'mailbox.test_sent' and meta->>'to' = 'tester18@example.com'`;
    expect(audit[0].n).toBe(1);

    // Two more succeed through the API, the fourth is refused in the dialog.
    const id = await ensureMailbox(page.request, mailbox);
    for (let i = 0; i < 2; i++) {
      const res = await page.request.post(`/api/mailboxes/${id}/send-test`, { data: { to: "tester18@example.com" } });
      expect(res.status()).toBe(200);
      expect((await res.json()).status).toBe("sent");
    }
    const refused = await sendFromDialog(dialog, "tester18@example.com");
    await expect(refused).toContainText("3 test emails per hour");
    expect((await delivered(page.request)).filter((m) => m.to === "tester18@example.com")).toHaveLength(3);
  });

  test("a suppressed address and a refusing provider show a clear failure and an unconfirmed send stays unknown", async ({ page }) => {
    await signInAdmin(page);
    const mailbox = "sdr18b@e2e-corp.test";
    await ensureMailbox(page.request, mailbox, "Sam Eighteen B");
    const id = await ensureMailbox(page.request, mailbox);

    await sql()`insert into suppression_list (organization_id, email, reason) select organization_id, 'blocked18@example.com', 'manual' from mailboxes where id = ${id} on conflict do nothing`;
    const dialog = await openTestDialog(page, mailbox);
    await expect(await sendFromDialog(dialog, "blocked18@example.com")).toContainText("suppression list");
    expect((await delivered(page.request)).filter((m) => m.to === "blocked18@example.com")).toHaveLength(0);

    try {
      await devFakes(page.request, { action: "mailBehavior", mode: "refuse" });
      await expect(await sendFromDialog(dialog, "refused18@example.com")).toContainText("The mail provider refused the test email");
      await devFakes(page.request, { action: "mailBehavior", mode: "timeout-after-accept" });
      // The in-flight guard only holds for `sending`; this row ends `unknown`, so the dialog can send again within the hourly cap.
      await expect(await sendFromDialog(dialog, "unknown18@example.com")).toContainText("did not confirm");
    } finally {
      await devFakes(page.request, { action: "mailBehavior", mode: "ok" });
    }
    const states = await sql()`select to_address, status from sends where mailbox_id = ${id} order by claimed_at`;
    expect(states.map((s) => [s.to_address, s.status])).toEqual([
      ["refused18@example.com", "failed"],
      ["unknown18@example.com", "unknown"],
    ]);
  });

  test("a member sees no test button and the API refuses them", async ({ page, browser }) => {
    await signInAdmin(page);
    const id = await ensureMailbox(page.request, "sdr18a@e2e-corp.test");
    await seedMember(page.request, MEMBER);
    const member = await secondBrowser(browser, MEMBER.email, MEMBER.password, [/response 403/]);
    await member.page.goto("/settings/mailboxes");
    await expect(member.page.getByText("Only an owner or admin can connect or change mailboxes.")).toBeVisible();
    await expect(member.page.getByRole("button", { name: /^More/ })).toHaveCount(0);
    const res = await member.page.request.post(`/api/mailboxes/${id}/send-test`, { data: { to: "x@example.com" } });
    expect(res.status()).toBe(403);
    await member.done();
  });
});

test.describe("organization settings", () => {
  test("the owner renames the organization and changes the zone; the slug stays; an audit row records both", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/settings/organization");
    await expect(page.getByLabel("Slug")).toBeDisabled();
    await expect(page.getByLabel("Name")).toHaveValue(ADMIN.organization);
    const slug = await page.getByLabel("Slug").inputValue();

    try {
      await page.getByLabel("Name").fill("E2E Corp Renamed");
      await page.getByLabel("Default time zone").click();
      await page.getByRole("option", { name: "Asia/Seoul", exact: true }).click();
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Organization saved.")).toBeVisible();
      await page.reload();
      await expect(page.getByLabel("Name")).toHaveValue("E2E Corp Renamed");
      await expect(page.getByLabel("Slug")).toHaveValue(slug);
      const audit = await sql()`select action, meta from audit_log where action in ('organization.renamed', 'organization.timezone_changed') order by created_at desc limit 2`;
      expect(audit.map((a) => a.action).sort()).toEqual(["organization.renamed", "organization.timezone_changed"]);
    } finally {
      const res = await page.request.patch("/api/settings/organization", { data: { name: ADMIN.organization, timeZone: "UTC" } });
      expect(res.status()).toBe(200);
    }
  });

  test("a member sees the form disabled and the API answers 403", async ({ page, browser }) => {
    await signInAdmin(page);
    await seedMember(page.request, MEMBER);
    const member = await secondBrowser(browser, MEMBER.email, MEMBER.password, [/response 403/]);
    await member.page.goto("/settings/organization");
    await expect(member.page.getByLabel("Name")).toBeDisabled();
    await expect(member.page.getByText("Only an owner or admin can change these settings.")).toBeVisible();
    const res = await member.page.request.patch("/api/settings/organization", { data: { name: "Nope" } });
    expect(res.status()).toBe(403);
    await member.done();
  });
});
