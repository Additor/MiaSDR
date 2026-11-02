import { ensureMailbox, expect, importLeads, openAddLeads, openCampaignTab, signInAdmin, test, unique } from "./support/fixtures";

test("a field written in other words fills, and a field no lead has stops the start and names itself", async ({ page, watch }) => {
  watch.tolerate(/422/);
  await signInAdmin(page);
  await ensureMailbox(page.request, "sdr52@e2e-corp.test");
  const domain = `${unique("s52")}.test`;
  await importLeads(page.request, [{ email: `ivy@${domain}`, firstName: "Ivy", lastName: "Ng" }]);

  await page.goto("/campaigns");
  await page.getByRole("button", { name: "New campaign" }).click();
  await page.getByLabel("Name").fill(unique("S52"));
  await page.getByRole("button", { name: "Create campaign" }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);
  await openAddLeads(page);
  await page.getByPlaceholder(/Search name, email, title or company/).fill(domain);
  await page.getByRole("button", { name: "Add matching leads" }).click();
  await expect(page.locator('[role="status"]').filter({ hasText: "Added 1 lead." })).toBeVisible();

  // The campaign list stays in the page, hidden, with a status of its own for each campaign.
  const status = page.getByTestId("campaign-status").filter({ visible: true });
  const saveSteps = async (subject: string, message: string) => {
    await openCampaignTab(page, "sequence");
    await page.getByLabel("Subject", { exact: true }).fill(subject);
    await page.getByLabel("Message").first().fill(message);
    // Two saves close together show two toasts, so the answer to this save is the proof.
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && /\/api\/campaigns\/[0-9a-f-]{36}$/.test(r.url()) && r.ok());
    await page.getByRole("button", { name: "Save steps" }).click();
    await saved;
  };

  await saveSteps("Hello {{first_nmae}}", "Hi {{first_name}}, {{fav_color}}.");
  await page.getByRole("button", { name: "Start campaign" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start campaign" }).click();
  const refusal = page.getByText("Fix the merge fields before starting.");
  await expect(refusal).toContainText("{{first_nmae}}");
  await expect(refusal).toContainText("{{fav_color}}");
  await expect(status).toHaveText("Draft");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  await saveSteps("Hello {{First Name}}", "Hi {{first_name}}.");
  await expect(page.getByText("Hello Ivy")).toBeVisible();
  await page.getByRole("button", { name: "Start campaign" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start campaign" }).click();
  await expect(page.getByText("Campaign is running.")).toBeVisible();
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(status).toHaveText("Paused");
});
