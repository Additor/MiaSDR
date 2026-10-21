import type { Locator, Page } from "@playwright/test";
import { expect, seedMember, seedReply, signInAdmin, signInAs, sql, test } from "./support/fixtures";

const MEMBER = { name: "Bea Assign", email: "bea42@e2e-corp.test", password: "bea42-password-1" };
const LEAD = { email: "cora@s42-group.test", firstName: "Cora", lastName: "Vance", title: "VP", company: "S42 Group" };

/** The number the sidebar shows beside Actions: records and tasks that are the viewer's. Zero when the sidebar shows none. */
async function pending(page: Page): Promise<number> {
  await page.goto("/actions");
  const badge = page.getByTestId("actions-pending");
  if ((await badge.count()) === 0) return 0;
  return Number.parseInt((await badge.innerText()).trim(), 10);
}

/** Picks an option in the app's Select (a combobox with a listbox popup). */
async function pick(page: Page, trigger: Locator, option: string) {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test.describe("who handles a reply", () => {
  test.describe.configure({ mode: "serial" });

  test("the campaign creator gets the reply, hands it over, takes it back, and a stale change is refused", async ({ page, browser }) => {
    await signInAdmin(page);
    await seedMember(page.request, MEMBER);
    await seedReply(page.request, { key: "S42", mailbox: "sdr42@e2e-corp.test", lead: LEAD, reply: { bodyText: "Yes, let's talk about the rollout on Monday." } });

    // The admin created the campaign, so the reply is theirs from the first moment, and the activity says who did it.
    await page.goto("/inbox");
    await page.getByRole("link", { name: /Cora Vance/ }).first().click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}/);
    const threadUrl = page.url();
    const assignee = page.getByTestId("thread-assignee");
    await expect(assignee.getByText("You handle this conversation.")).toBeVisible();
    // The assignment is an Activity line; Activity folds behind its count.
    await expect(page.locator("#main-content").getByTestId("thread-activity")).toContainText("Assigned to Ada Admin");

    await page.goto("/actions");
    await expect(page.getByRole("link", { name: /^Mine \d+/ })).toBeVisible();
    await expect(page.getByTestId("queue-item").filter({ hasText: "Cora Vance" })).toBeVisible();
    await expect(page.getByTestId("actions-pending")).toBeVisible();

    // A rerun on the same database can leave Bea holding work. Her count is read before the handover and compared after it.
    const bea = await browser.newContext({ baseURL: new URL(threadUrl).origin });
    const beaPage = await bea.newPage();
    await signInAs(beaPage, MEMBER.email, MEMBER.password);
    const beaBefore = await pending(beaPage);

    // The admin gives it to Bea. It leaves Mine and appears under Others, with Bea's name on the row.
    await page.goto(threadUrl);
    await pick(page, assignee.getByRole("combobox", { name: "Assign to" }), MEMBER.name);
    await expect(assignee.getByRole("combobox", { name: "Assign to" })).toContainText(MEMBER.name);
    await expect(page.locator("#main-content").getByTestId("thread-activity")).toContainText(`Assigned to ${MEMBER.name}`);
    await page.goto("/actions");
    await expect(page.getByTestId("queue-item").filter({ hasText: "Cora Vance" })).toHaveCount(0);
    await page.goto("/actions?scope=others");
    const row = page.getByTestId("queue-item").filter({ hasText: "Cora Vance" });
    await expect(row).toBeVisible();
    await expect(row.getByText(`Assigned to ${MEMBER.name}`)).toBeVisible();

    // Bea sees it as hers: the sidebar counts one more, and the thread says so.
    await beaPage.goto(threadUrl);
    const beaAssignee = beaPage.getByTestId("thread-assignee");
    await expect(beaAssignee.getByText("You handle this conversation.")).toBeVisible();
    await beaPage.goto("/actions");
    await expect(beaPage.getByTestId("queue-item").filter({ hasText: "Cora Vance" })).toBeVisible();
    expect(await pending(beaPage)).toBe(beaBefore + 1);

    // Someone else cannot take what Bea holds, and a change made from a stale view is refused. Both answer 409 and change nothing.
    const [{ id: recordId }] = await sql()`select r.id from records r join people p on p.id = r.person_id where p.email = ${LEAD.email}`;
    const [{ id: beaId }] = await sql()`select id from users where email = ${MEMBER.email}`;
    const taken = await page.request.post(`/api/crm/records/${recordId}/assignee`, { data: { action: "claim" } });
    expect(taken.status()).toBe(409);
    expect(((await taken.json()) as { error: string }).error).toContain("Another member already handles");
    const stale = await page.request.post(`/api/crm/records/${recordId}/assignee`, { data: { action: "assign", assignedTo: beaId, expectedAssignedTo: null } });
    expect(stale.status()).toBe(409);
    expect((await sql()`select assigned_to from records where id = ${recordId}`)[0].assigned_to).toBe(beaId);

    // Bea hands it to nobody. Her sidebar count goes, and it waits under Unassigned.
    await beaPage.goto(threadUrl);
    await pick(beaPage, beaAssignee.getByRole("combobox", { name: "Assign to" }), "Nobody");
    await expect(beaAssignee.getByText("Nobody handles this conversation yet.")).toBeVisible();
    expect(await pending(beaPage)).toBe(beaBefore);
    await bea.close();

    await page.goto("/actions?scope=unassigned");
    await expect(page.getByRole("link", { name: /^Unassigned \d+/ })).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("queue-item").filter({ hasText: "Cora Vance" })).toBeVisible();

    // The admin takes it.
    await page.goto(threadUrl);
    await expect(assignee.getByText("Nobody handles this conversation yet.")).toBeVisible();
    await assignee.getByRole("button", { name: "Take it" }).click();
    await expect(assignee.getByText("You handle this conversation.")).toBeVisible();
    expect((await sql()`select assigned_source from records where id = ${recordId}`)[0].assigned_source).toBe("human");
  });
});
