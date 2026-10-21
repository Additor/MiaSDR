import type { Page } from "@playwright/test";
import { MOBILE_DARK, csvFile, ensureMailbox, expect, openAddLeads, openCampaignTab, signInAdmin, test, waitForHydrated } from "./support/fixtures";

test.describe("leads import to campaign start", () => {
  test("import a CSV, build a campaign, add the leads and start it", async ({ page }) => {
    await signInAdmin(page);
    await ensureMailbox(page.request, "sdr4@e2e-corp.test");

    // Import.
    await page.goto("/leads/import");
    const fileInput = page.getByLabel("Choose a CSV or XLSX file");
    await waitForHydrated(fileInput);
    await fileInput.setInputFiles(
      csvFile("s4-leads.csv", [
        ["first_name", "last_name", "email", "title", "company_name", "company_domain"],
        ["Ivy", "Nguyen", "ivy@s4-labs.test", "CTO", "S4 Labs", "s4-labs.test"],
        ["Omar", "Reyes", "omar@s4-labs.test", "VP Engineering", "S4 Labs", "s4-labs.test"],
        ["Zed", "Park", "not-an-email", "Developer", "S4 Labs", "s4-labs.test"],
      ]),
    );
    await expect(page.getByText("3 rows found.")).toBeVisible();
    await expect(page.getByLabel("Import email as")).toContainText("Email");
    await page.getByRole("button", { name: "Review import" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Review before importing" })).toBeFocused();
    await page.getByRole("button", { name: "Import 2 leads: 2 new" }).click();
    await expect(page.getByText("Import finished")).toBeVisible();
    await expect(summaryValue(page, "New leads")).toHaveText("2");
    await expect(summaryValue(page, "Skipped, no valid email or LinkedIn")).toHaveText("1");
    await expect(page.getByText(/Skipped, row 3/)).toBeVisible();

    await page.getByRole("link", { name: "View leads" }).click();
    await page.getByLabel("Search leads").fill("s4-labs");
    await page.getByLabel("Search leads").press("Enter");
    await expect(page.getByText("ivy@s4-labs.test")).toBeVisible();
    await expect(page.getByText("omar@s4-labs.test")).toBeVisible();

    // Campaign.
    await page.goto("/campaigns");
    await page.getByRole("button", { name: "New campaign" }).click();
    await page.getByLabel("Name").fill("S4 launch");
    await page.getByRole("button", { name: "Create campaign" }).click();
    await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("campaign-facts")).toHaveText(/Email.*2 steps/);
    // The status token sits beside the h1, which is the campaign name.
    await expect(page.getByRole("heading", { level: 1, name: "S4 launch" })).toBeVisible();
    await expect(page.getByTestId("campaign-status")).toHaveText("Draft");

    // A campaign with no leads starts on the Leads tab with the Add leads panel open.
    await expect(page.getByText("No leads yet", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add leads", exact: true })).toHaveAttribute("aria-expanded", "true");

    // Steps are on the Sequence tab.
    await openCampaignTab(page, "sequence");
    await expect(page.getByRole("heading", { name: "Steps", exact: true })).toBeVisible();
    await page.getByLabel("Subject", { exact: true }).fill("Quick idea for {{company}}");
    await page.getByLabel("Message").first().fill("Hi {{firstName}}, a short note from the S4 launch.");
    await page.getByRole("button", { name: "Save steps" }).click();
    await expect(page.getByText("Steps saved.")).toBeVisible();

    // Add only the imported leads from the Leads tab.
    await openCampaignTab(page, "leads");
    await openAddLeads(page);
    await page.getByPlaceholder(/Search name, email, title or company/).fill("s4-labs");
    await page.getByRole("button", { name: "Add matching leads" }).click();
    await expect(page.locator('[role="status"]').filter({ hasText: "Added 2 leads." })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Leads in this campaign" })).toBeVisible();
    await expect(page.getByTestId("tab-all")).toHaveText(/^All\s*2$/);

    // Preview now uses a real lead.
    await openCampaignTab(page, "sequence");
    await expect(page.getByText(/With (Ivy|Omar)/)).toBeVisible();
    await expect(page.getByText(/Quick idea for S4 Labs/)).toBeVisible();

    // Start, then pause so later scenarios do not send these emails.
    await page.getByRole("button", { name: "Start campaign" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Start campaign" }).click();
    await expect(page.getByText("Campaign is running.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start campaign" })).toHaveCount(0);
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Campaign paused.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(page.getByTestId("campaign-status")).toHaveText("Paused");

    // In a paused campaign the leads read Paused, and the filter row offers Paused in place of Queued and In sequence.
    await openCampaignTab(page, "leads");
    await expect(page.getByRole("group", { name: "Lead status" })).toBeVisible();
    await expect(page.getByTestId("tab-paused")).toContainText("2");
    await expect(page.getByTestId("tab-queued")).toHaveCount(0);
    await expect(page.getByTestId("lead-status").first()).toHaveAttribute("data-state", "paused");
    // An older filter link (?status=pending) opens its successor, which a paused campaign leaves empty.
    await page.goto(`${page.url().split("?")[0]}?status=pending`);
    await expect(page.getByTestId("tab-queued")).toHaveAttribute("aria-current", "true");
    await expect(page.getByText("No leads match this filter")).toBeVisible();
  });

  test("adding the same leads twice skips them", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/campaigns");
    await page.getByRole("link", { name: /S4 launch/ }).click();
    // The campaign has leads now, so the Add leads panel starts closed.
    await expect(page.getByRole("button", { name: "Add leads", exact: true })).toHaveAttribute("aria-expanded", "false");
    await openAddLeads(page);
    await page.getByPlaceholder(/Search name, email, title or company/).fill("s4-labs");
    await page.getByRole("button", { name: "Add matching leads" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Added 0 leads." })).toContainText("2 already added");
  });
});

test.describe("at 390x844 in dark mode", () => {
  test.use(MOBILE_DARK);

  test("a paused campaign keeps Resume in view and puts Mark completed in the More menu", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/campaigns");
    await page.getByRole("link", { name: /S4 launch/ }).click();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mark completed" })).toBeHidden();
    const more = page.getByRole("button", { name: "More actions for S4 launch" });
    await waitForHydrated(more);
    await more.click();
    await expect(page.getByRole("menuitem", { name: "Mark completed" })).toBeVisible();
    await page.keyboard.press("Escape");
  });
});

/** The value beside a label in the import summary list. */
function summaryValue(page: Page, label: string) {
  return page.locator("dl > div").filter({ has: page.getByRole("term").filter({ hasText: new RegExp(`^${label}$`) }) }).getByRole("definition");
}
