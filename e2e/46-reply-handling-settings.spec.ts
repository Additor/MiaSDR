import type { Locator } from "@playwright/test";
import { e2eOrganizationId, expect, signInAdmin, sql, test, unique, waitForHydrated } from "./support/fixtures";

/** The row of one reply type, found by its Edit button: other rows may name the type in their guidance. */
const typeRow = (main: Locator, name: string) => main.getByTestId("reply-type-row").filter({ has: main.page().getByRole("button", { name: `Edit ${name}`, exact: true }) });

/** Settings > Reply handling: reply types by group with their rules, the edit dialog, archive and the confidence floor. */
test.describe("reply handling settings", () => {
  test("lists reply types by group with their rules, and keeps system roles from being archived", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/settings/replies");
    const main = page.locator("#main-content");
    await expect(main.getByRole("heading", { name: "Reply types", level: 2 })).toBeVisible();
    await expect(main.getByRole("heading", { level: 3 })).toHaveText(["Interested", "Existing customer", "Not interested", "Other"]);
    await expect(main.getByText(/subcategor|reply categor/i)).toHaveCount(0);
    await expect(main.getByText(/Position/)).toHaveCount(0);

    const stop = typeRow(main, "Asked to stop");
    await expect(stop.getByTestId("reply-type-rules")).toHaveText("Check before · No draft · Follow-ups stop");
    await expect(stop).toContainText("Use Stop contacting to stop all outreach to the person.");
    await expect(stop.getByRole("button", { name: "Edit Asked to stop" })).toBeVisible();
    await expect(stop.getByRole("button", { name: /^(Archive|Delete)$/ })).toHaveCount(0);

    const customer = typeRow(main, "Customer question");
    await expect(customer).toContainText("Locked");
    await expect(customer.getByRole("button", { name: /^(Archive|Delete)$/ })).toHaveCount(0);

    const notNow = typeRow(main, "Not now");
    await expect(notNow.getByTestId("reply-type-rules")).toHaveText("No check · No draft · Follow-ups stop");

    // Asked to stop keeps its rules: its dialog shows them as text, with no radio to change.
    const edit = stop.getByRole("button", { name: "Edit Asked to stop" });
    await waitForHydrated(edit);
    await edit.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("group", { name: "When the AI picks Asked to stop" })).toContainText("Check before · No draft · Follow-ups stop");
    await expect(dialog.getByRole("radio")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // The API refuses to archive a system role with its reason.
    const [row] = await sql()`select rt.id from reply_types rt join reply_type_sets s on s.id = rt.reply_type_set_id where s.organization_id = ${await e2eOrganizationId()} and s.is_default and rt.system_role = 'stop_request'`;
    const refused = await page.request.patch(`/api/reply-types/${row.id}`, { data: { active: false } });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).code).toBe("system_role");
  });

  test("adds a type with the default rules, edits its rules, archives it and deletes it", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/settings/replies");
    const main = page.locator("#main-content");
    const name = unique("Pricing ask");

    const add = main.getByRole("button", { name: "Add reply type" });
    await waitForHydrated(add);
    await add.click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill(name);
    const rules = dialog.getByRole("group", { name: `When the AI picks ${name}` });
    await expect(rules).toContainText("Applies to replies picked from now on.");
    await expect(rules.getByRole("radio", { name: "After it applies" })).toBeChecked();
    await expect(rules.getByRole("radio", { name: "Write one" })).toBeChecked();
    await expect(rules.getByRole("radio", { name: "Keep going" })).toBeChecked();
    await dialog.getByRole("button", { name: "Add reply type" }).click();
    await expect(dialog).toBeHidden();

    const row = typeRow(main, name);
    await expect(row.getByTestId("reply-type-rules")).toHaveText("Check after · Draft · Follow-ups keep going");

    await row.getByRole("button", { name: `Edit ${name}` }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "Before it applies" }).click();
    await dialog.getByRole("radio", { name: "Don't write" }).click();
    await dialog.getByRole("radio", { name: "Stop", exact: true }).click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByTestId("reply-type-rules")).toHaveText("Check before · No draft · Follow-ups stop");
    const [stored] = await sql()`select check_mode, reply_draft, follow_ups from reply_types where name = ${name}`;
    expect(stored).toMatchObject({ check_mode: "before", reply_draft: false, follow_ups: "stop" });

    // Archive says where the replies that would fit go.
    await row.getByRole("button", { name: "Archive" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("The AI stops picking");
    await expect(dialog).toContainText("goes to the closest other type, often Unclear");
    await dialog.getByRole("button", { name: "Archive reply type" }).click();
    await expect(row).toContainText("Archived");

    await row.getByRole("button", { name: "Delete" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Delete reply type" }).click();
    await expect(row).toHaveCount(0);
  });

  test("saves the confidence floor", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/settings/replies");
    const field = page.getByLabel("Percent confidence");
    await waitForHydrated(field);
    const before = await field.inputValue();
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "Confidence floor" }) });
    await expect(section).toContainText("Below this, the AI only suggests and a person decides.");

    await field.fill("81");
    await section.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Confidence floor saved.")).toBeVisible();
    const [stored] = await sql()`select auto_apply_confidence from reply_handling_settings s join reply_type_sets t on t.id = s.reply_type_set_id where t.organization_id = ${await e2eOrganizationId()} and t.is_default`;
    expect(Number(stored.auto_apply_confidence)).toBe(0.81);

    // Put the floor back for the specs that classify replies after this one.
    await field.fill(before);
    await section.getByRole("button", { name: "Save" }).click();
    await expect(section.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
