import type { Locator, Page } from "@playwright/test";
import { expect, importLeads, seedMember, seedReply, signInAdmin, signInAs, sql, test, waitForHydrated } from "./support/fixtures";

const MEMBER = { name: "Bea Tasks", email: "bea21@e2e-corp.test", password: "bea21-password-1" };
const LEAD = { email: "tess@s21-group.test", firstName: "Tess", lastName: "Aldrin", title: "COO", company: "S21 Group" };
/** Notes are written on the contact page, so the notes check uses a contact of its own and Tess stays a lead. */
const CONTACT = { email: "nora@s21-notes.test", firstName: "Nora", lastName: "Quill", title: "CFO", company: "S21 Notes" };

test.describe("tasks, notes and the important flag", () => {
  test.describe.configure({ mode: "serial" });

  test("a task is created, assigned, completed, reopened and shows in the actions queue overdue first", async ({ page }) => {
    await signInAdmin(page);
    await seedMember(page.request, MEMBER);
    await seedReply(page.request, { key: "S21", mailbox: "sdr21@e2e-corp.test", lead: LEAD, reply: { bodyText: "Please call me on Friday about rollout." } });

    await page.goto("/inbox");
    await page.getByRole("link", { name: /Tess Aldrin/ }).click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);

    // Important star and the inbox filter.
    await page.getByRole("button", { name: "Mark as important" }).first().click();
    await expect(page.getByRole("button", { name: "Remove important mark" })).toBeVisible();
    await page.goto("/inbox?view=important");
    await expect(page.getByRole("link", { name: /Tess Aldrin/ })).toBeVisible();
    await page.getByRole("link", { name: /Tess Aldrin/ }).click();

    // Two tasks: one long overdue and assigned to Bea, one with no date for the admin.
    const panel = page.locator('[data-slot="tasks-panel"]');
    await panel.getByLabel("New task").fill("Send rollout plan");
    await panel.getByLabel("Due date").fill("2020-01-02");
    await pick(page, panel.getByRole("combobox", { name: "Assign to" }), MEMBER.name);
    await panel.getByRole("button", { name: "Add task" }).click();
    await expect(panel.getByText("Send rollout plan")).toBeVisible();
    await expect(panel.getByText("Overdue")).toBeVisible();

    await panel.getByLabel("New task").fill("Call Tess");
    await pick(page, panel.getByRole("combobox", { name: "Assign to" }), "Ada Admin (you)");
    await panel.getByRole("button", { name: "Add task" }).click();
    await expect(panel.getByText("Call Tess")).toBeVisible();

    // The queue opens on Mine, which lists the admin's own task under "Your tasks". Bea's overdue task is Others' work.
    // Tess is a lead with a conversation, so her task rows open the thread.
    const thread = new URL(page.url()).pathname;
    await page.goto("/actions");
    await expect(page.getByText("Call Tess")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Call Tess" }).getByRole("link", { name: "Open conversation" })).toHaveAttribute("href", thread);
    await expect(page.getByText("Send rollout plan")).toHaveCount(0);
    await page.getByRole("link", { name: /^Others/ }).click();
    await expect(page).toHaveURL(/scope=others/);
    await expect(page.getByText("Send rollout plan")).toBeVisible();
    await expect(page.getByText("Call Tess")).toHaveCount(0);
    await expect(page.getByText("Overdue").first()).toBeVisible();

    // Complete and reopen.
    await page.goto(thread);
    await page.getByLabel("Complete Call Tess").click();
    await expect(page.locator('[data-task-state="done"]').filter({ hasText: "Call Tess" })).toBeVisible();
    await page.getByLabel("Reopen Call Tess").click();
    await expect(page.locator('[data-task-state="open"]').filter({ hasText: "Call Tess" })).toBeVisible();
  });

  test("a member changes only their own notes and tasks; an admin changes any", async ({ page, browser }) => {
    await signInAdmin(page);
    await page.goto("/inbox");
    await page.getByRole("link", { name: /Tess Aldrin/ }).first().click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}/);
    const threadUrl = page.url();

    // A contact for the notes: imported, then given a deal, which makes it a contact.
    await importLeads(page.request, [CONTACT]);
    const [{ id: contactId }] = await sql()`select id from people where email = ${CONTACT.email}`;
    const converted = await page.request.post(`/api/leads/${contactId}/convert`, { data: { title: "S21 notes deal" } });
    expect([200, 201, 409]).toContain(converted.status());
    const contactUrl = new URL(`/crm/contacts/${contactId}`, threadUrl).toString();
    await page.goto(contactUrl);
    await openNotes(page);
    await page.getByLabel("Note", { exact: true }).fill("Admin note about rollout");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByText("Admin note about rollout")).toBeVisible();

    const bea = await browser.newContext({ baseURL: new URL(threadUrl).origin });
    const beaPage = await bea.newPage();
    await signInAs(beaPage, MEMBER.email, MEMBER.password);

    // Bea holds "Send rollout plan", so she can complete it on the thread. She cannot complete the admin's "Call Tess".
    await beaPage.goto(threadUrl);
    await beaPage.getByLabel("Complete Send rollout plan").click();
    await expect(beaPage.locator('[data-task-state="done"]').filter({ hasText: "Send rollout plan" })).toBeVisible();
    await expect(beaPage.getByLabel("Complete Call Tess")).toBeDisabled();

    await beaPage.goto(contactUrl);
    await openNotes(beaPage);
    const adminNote = beaPage.getByRole("listitem").filter({ hasText: "Admin note about rollout" });
    await expect(adminNote).toBeVisible();
    await expect(adminNote.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(adminNote.getByRole("button", { name: "Delete" })).toHaveCount(0);

    // Bea writes and edits her own note.
    await beaPage.getByLabel("Note", { exact: true }).fill("Bea note");
    await beaPage.getByRole("button", { name: "Add note" }).click();
    const own = beaPage.getByRole("listitem").filter({ hasText: "Bea note" });
    await own.getByRole("button", { name: "Edit" }).click();
    await beaPage.getByLabel("Note text").fill("Bea note, edited");
    await beaPage.getByRole("button", { name: "Save", exact: true }).click();
    await expect(beaPage.getByLabel("Note text")).toHaveCount(0);
    await expect(beaPage.getByText("Bea note, edited")).toBeVisible();
    await bea.close();

    // The admin deletes Bea's note.
    await page.reload();
    await openNotes(page);
    await page.getByRole("listitem").filter({ hasText: "Bea note, edited" }).getByRole("button", { name: "Delete" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete note" }).click();
    await expect(page.getByText("Bea note, edited")).toHaveCount(0);
  });
});

/** The contact page's Activity opens on Tasks; notes are one tab over. */
async function openNotes(page: Page) {
  const tab = page.getByRole("tab", { name: /Notes/ });
  await waitForHydrated(tab);
  await tab.click();
}

/** Picks an option in the app's Select (a combobox with a listbox popup). */
async function pick(page: Page, trigger: Locator, option: string) {
  await trigger.click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
