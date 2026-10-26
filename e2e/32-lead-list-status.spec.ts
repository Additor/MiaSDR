import type { Page } from "@playwright/test";
import { columnCells } from "./support/table";
import { e2eOrganizationId, expect, expectNoHorizontalOverflow, MOBILE_DARK, openFilters, signInAdmin, sql, test, waitForHydrated } from "./support/fixtures";

/**
 * The people list answers "who do I work next": the lead status token with the campaign as a second line, last contact and the Reach icons (email and LinkedIn) per lead,
 * removable filter chips with one submit button and one Clear filters, and a column set that survives a reload.
 * Logic is unit tested and the read model has integration tests. This scenario covers the browser parts.
 */
async function seed() {
  const db = sql();
  const orgId = await e2eOrganizationId();
  const [existing] = await db`select id from people where organization_id = ${orgId} and full_name = 'S30 Rita Replied'`;
  if (existing) return;
  const [campaign] = await db`insert into campaigns (organization_id, channel, name, status) values (${orgId}, 'email', 'S30 Autumn push', 'active') returning id`;
  const [pipeline] = await db`select id from pipelines where organization_id = ${orgId} order by is_default desc limit 1`;
  const pipelineId = pipeline?.id ?? (await db`insert into pipelines (organization_id, name, is_default) values (${orgId}, 'default', true) returning id`)[0].id;
  const person = async (name: string, email: string | null, slug: string | null, createdAt: string) => {
    const [row] = await db`
      insert into people (organization_id, email, linkedin_slug, full_name, title, source, created_at, updated_at)
      values (${orgId}, ${email}, ${slug}, ${name}, 'Engineer', 'manual', ${createdAt}, ${createdAt}) returning id`;
    return row.id as string;
  };
  const replied = await person("S30 Rita Replied", "rita@s30.test", "s30-rita", "2024-02-01T10:00:00Z");
  const waiting = await person("S30 Wade Waiting", "wade@s30.test", null, "2024-02-02T10:00:00Z");
  await person("S30 Nora Nocampaign", null, "s30-nora", "2024-02-03T10:00:00Z");
  await db`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${orgId}, ${campaign.id}, ${replied}, 'email', 'replied')`;
  await db`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${orgId}, ${campaign.id}, ${waiting}, 'email', 'active')`;
  const [record] = await db`insert into records (organization_id, person_id, pipeline_id) values (${orgId}, ${replied}, ${pipelineId}) returning id`;
  const [conversation] = await db`insert into conversations (organization_id, record_id, channel, account_ref) values (${orgId}, ${record.id}, 'email', 's30@e2e-corp.test') returning id`;
  await db`insert into messages (organization_id, conversation_id, channel, account_ref, direction, idempotency_key, body_text, sent_at)
    values (${orgId}, ${conversation.id}, 'email', 's30@e2e-corp.test', 'outbound', 's30-msg-1', 'Hello', now() - interval '3 days')`;
}

const names = async (page: Page) => (await columnCells(page.getByRole("table"), "Name")).getByRole("link").allTextContents();

test.describe("lead list status columns, chips and column set", () => {
  test("shows the status token, last contact and Reach icons, and narrows with removable chips", async ({ page }) => {
    await signInAdmin(page);
    await seed();

    await page.goto("/leads?q=s30");
    await expect.poll(() => names(page)).toHaveLength(3);
    const header = page.locator("thead");
    await expect(header.getByText("Status", { exact: true })).toBeVisible();
    await expect(header.getByText("Campaign", { exact: true })).toHaveCount(0);
    await expect(header.getByText("Last contact", { exact: true })).toBeVisible();
    // The contact-point column reads "Reach"; "Contact" names a person in the CRM.
    await expect(header.getByText("Reach", { exact: true })).toBeVisible();
    await expect(header.getByText("Contact", { exact: true })).toHaveCount(0);
    await expect(header.getByText("Channels", { exact: true })).toHaveCount(0);
    await expect(header.getByText("Updated", { exact: true })).toHaveCount(0);

    const rita = page.locator("tbody tr", { hasText: "S30 Rita Replied" });
    await expect(rita.getByTestId("lead-status-campaign")).toHaveText("S30 Autumn push");
    await expect(rita.getByTestId("lead-status")).toHaveAttribute("data-state", "replied");
    await expect(rita.getByText("Replied", { exact: true }).filter({ visible: true })).toHaveCount(1);
    await expect(rita.locator("time", { hasText: "3 d ago" }).filter({ visible: true })).toHaveAttribute("title", /UTC/);

    // Reach column: a link where the lead has the value, a muted named icon where it has not.
    const email = rita.getByRole("link", { name: "Email rita@s30.test" });
    await expect(email).toHaveAttribute("href", "mailto:rita@s30.test");
    const linkedin = rita.getByRole("link", { name: "Open LinkedIn profile of S30 Rita Replied" });
    await expect(linkedin).toHaveAttribute("href", "https://www.linkedin.com/in/s30-rita/");
    await expect(linkedin).toHaveAttribute("target", "_blank");
    expect(await linkedin.getAttribute("rel")).toMatch(/noopener/);
    expect(await linkedin.getAttribute("rel")).toMatch(/noreferrer/);
    const box = await linkedin.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(24);
    expect(box?.height).toBeGreaterThanOrEqual(24);
    const wade = page.locator("tbody tr", { hasText: "S30 Wade Waiting" });
    await expect(wade.getByRole("img", { name: "No LinkedIn" })).toBeVisible();
    await expect(wade.getByRole("link", { name: "Email wade@s30.test" })).toBeVisible();
    await expect(wade.getByRole("link", { name: /LinkedIn profile/ })).toHaveCount(0);
    await expect(page.locator("tbody tr", { hasText: "S30 Nora Nocampaign" }).getByRole("img", { name: "No email" })).toBeVisible();

    // The icon sits above the row's stretched link: it opens the profile in a new tab and the list stays put.
    await page.context().route("https://www.linkedin.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>profile</title>" }));
    const [popup] = await Promise.all([page.context().waitForEvent("page"), linkedin.click()]);
    expect(popup.url()).toBe("https://www.linkedin.com/in/s30-rita/");
    await popup.close();
    await expect(page).toHaveURL(/\/leads\?q=s30/);
    const nora = page.locator("tbody tr", { hasText: "S30 Nora Nocampaign" });
    await expect(nora.getByTestId("lead-status")).toHaveText("New");
    await expect(nora.getByText("Not contacted", { exact: true }).filter({ visible: true })).toBeVisible();

    // One submit button, one Clear filters while the search is applied, none once its chip is removed.
    const form = page.locator('form[aria-label="Filter leads"]');
    // The search's hidden submit and the Filters popover's Apply, which stays in the form while it is closed.
    await expect(form.locator('button[type="submit"]')).toHaveCount(2);
    await expect(page.getByRole("link", { name: "Clear filters" })).toHaveCount(1);
    await page.getByRole("link", { name: "Remove filter Search: s30" }).click();
    await expect(page.getByRole("link", { name: "Clear filters" })).toHaveCount(0);

    await page.goto("/leads?q=s30");
    await openFilters(page);
    await page.getByRole("radiogroup", { name: "Replied" }).getByText("Yes", { exact: true }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page).toHaveURL(/replied=yes/);
    await expect.poll(() => names(page)).toEqual(["S30 Rita Replied"]);
    await expect(page.getByTestId("filters-toggle")).toHaveText(/^Filters\s*1 in use$/);
    const chip = page.getByRole("link", { name: "Remove filter Replied: Yes" });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page).not.toHaveURL(/replied=/);
    await expect.poll(() => names(page)).toHaveLength(3);

    // No match: one Clear filters, and the Export button says why it is disabled.
    await page.goto("/leads?q=s30&lastFrom=2999-01-01");
    await expect(page.getByText("No leads match", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Clear filters" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Export filtered CSV/ })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: /Export filtered CSV/ })).toContainText("No leads match, so there is nothing to export.");

    // Last contact filter finds the lead contacted three days ago.
    const today = new Date().toISOString().slice(0, 10);
    await page.goto(`/leads?q=s30&lastTo=${today}`);
    await expect.poll(() => names(page)).toEqual(["S30 Rita Replied"]);
    await page.getByRole("link", { name: /Remove filter Last contact to/ }).click();
    await expect.poll(() => names(page)).toHaveLength(3);

    // A single page shows the count and the page size, with no Previous or Next.
    await expect(page.getByText("3 leads", { exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Leads per page" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Pages" })).toHaveCount(0);
  });

  test("remembers the column set after a reload and keeps the narrow layout inside the viewport", async ({ page }) => {
    await signInAdmin(page);
    await seed();
    await page.goto("/leads?q=s30");
    await waitForHydrated(page.getByLabel("Select all leads on this page"));
    await expect(page.locator("thead").getByText("Title", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /Columns/ }).click();
    await page.getByRole("menuitemcheckbox", { name: "Title" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Added" }).click();
    await page.keyboard.press("Escape");
    await expect(page.locator("thead").getByText("Title", { exact: true })).toHaveCount(0);

    await page.reload();
    await expect(page.locator("thead").getByText("Title", { exact: true })).toHaveCount(0);
    await expect(page.locator("thead").getByText("Added", { exact: true })).toHaveCount(0);
    await expect(page.locator("thead").getByText("Status", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Columns (2 hidden)" })).toBeVisible();

    // Narrow screen: the status line sits under the name and the page does not scroll sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/leads?q=s30");
    const rita = page.locator("tbody tr", { hasText: "S30 Rita Replied" });
    await expect(rita.getByTestId("lead-status-line").getByText("Replied, S30 Autumn push", { exact: true })).toBeVisible();
    await expect(rita.getByText("Email, LinkedIn", { exact: true })).toBeVisible();
    await expect(rita.getByText("3 d ago").filter({ visible: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Restore the default set for the other scenarios.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("button", { name: /Columns/ }).click();
    await page.getByRole("menuitemcheckbox", { name: "Title" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Added" }).click();
  });
});

test.describe("leads on a desktop and a phone", () => {
  test("the list with both lifecycles and a lead page with Create deal fit 1440x900 and 390x844 in dark mode", async ({ page }) => {
    await signInAdmin(page);
    await seed();
    for (const screen of [{ viewport: { width: 1440, height: 900 }, colorScheme: "light" as const }, MOBILE_DARK]) {
      await page.setViewportSize(screen.viewport);
      await page.emulateMedia({ colorScheme: screen.colorScheme });
      await page.goto("/leads?q=s30&lifecycle=all");
      if (screen.colorScheme === "dark") await expect(page.locator("html")).toHaveClass(/dark/);
      await expect.poll(() => names(page)).toHaveLength(3);
      await expect(page.getByRole("table")).toBeVisible();
      await expectNoHorizontalOverflow(page);

      await page.getByRole("link", { name: "S30 Rita Replied", exact: true }).click();
      await expect(page.getByTestId("lead-header").getByRole("button", { name: "Create deal" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });
});
