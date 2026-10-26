import type { Page } from "@playwright/test";
import { columnCells } from "./support/table";
import { e2eOrganizationId, expect, openFilters, signInAdmin, sql, test, waitForHydrated } from "./support/fixtures";

/**
 * Seeds people, one contact and companies straight into the admin's organization. Import and campaign flows are
 * covered by 04 and 17; this scenario tests how the list narrows, sorts and picks leads, contacts or both.
 */
async function seed() {
  const db = sql();
  const orgId = await e2eOrganizationId();
  const [seeded] = await db`select id from people where organization_id = ${orgId} and full_name = 'S26 Amy Archer'`;
  if (seeded) return;
  const [alpha] = await db`insert into companies (organization_id, domain, name) values (${orgId}, 's26-alpha.test', 'S26 Alpha') returning id`;
  const [beta] = await db`insert into companies (organization_id, domain, name) values (${orgId}, 's26-beta.test', 'S26 Beta') returning id`;
  const person = async (email: string | null, name: string, extra: { slug?: string; companyId?: string; createdAt: string; contact?: boolean }) => {
    const lifecycle = extra.contact ? "contact" : "lead";
    const [row] = await db`
      insert into people (organization_id, email, linkedin_slug, full_name, title, company_id, source, lifecycle, converted_at, created_at, updated_at)
      values (${orgId}, ${email}, ${extra.slug ?? null}, ${name}, 'Engineer', ${extra.companyId ?? null}, 'manual', ${lifecycle}, ${extra.contact ? extra.createdAt : null}, ${extra.createdAt}, ${extra.createdAt}) returning id`;
    return row.id as string;
  };
  await person("amy@s26-alpha.test", "S26 Amy Archer", { slug: "s26-amy", companyId: alpha.id, createdAt: "2024-01-01T10:00:00Z" });
  await person("ben@s26-alpha.test", "S26 Ben Baker", { companyId: alpha.id, createdAt: "2024-01-02T10:00:00Z" });
  await person("cat@s26-alpha.test", "S26 Cat Cole", { slug: "s26-cat", companyId: alpha.id, createdAt: "2024-01-03T10:00:00Z" });
  const dave = await person("dave@s26-beta.test", "S26 Dave Dunn", { companyId: beta.id, createdAt: "2024-01-04T10:00:00Z" });
  await person(null, "S26 Eli Eaves", { slug: "s26-eli", createdAt: "2024-01-05T10:00:00Z" });
  // A contact: a deal was created from it. The default list leaves it out.
  await person("fay@s26-beta.test", "S26 Fay Fisher", { companyId: beta.id, createdAt: "2024-01-06T10:00:00Z", contact: true });
  const [campaign] = await db`insert into campaigns (organization_id, channel, name, status) values (${orgId}, 'email', 'S26 Campaign', 'draft') returning id`;
  await db`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${orgId}, ${campaign.id}, ${dave}, 'email', 'pending')`;
}

const firstNames = async (page: Page) => (await columnCells(page.getByRole("table"), "Name")).getByRole("link").allTextContents();

test.describe("lead list filters, sort and lifecycle", () => {
  test("filter bar, sort header and Lifecycle narrow the list", async ({ page }) => {
    await signInAdmin(page);
    await seed();

    // Search by LinkedIn slug.
    await page.goto("/leads");
    await page.getByLabel("Search leads").fill("s26-eli");
    await page.getByLabel("Search leads").press("Enter");
    await expect(page).toHaveURL(/q=s26-eli/);
    await expect.poll(() => firstNames(page)).toEqual(["S26 Eli Eaves"]);

    // Filter bar: LinkedIn yes, within the s26 leads.
    await page.goto("/leads?q=s26");
    await expect(page.getByText("5 leads", { exact: true })).toBeVisible();
    await openFilters(page);
    await page.getByRole("radiogroup", { name: "Has LinkedIn" }).getByText("Yes", { exact: true }).click();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page).toHaveURL(/linkedin=yes/);
    await expect(page).toHaveURL(/q=s26/);
    await expect(page.getByText("3 leads", { exact: true })).toBeVisible();
    await expect.poll(async () => (await firstNames(page)).sort()).toEqual(["S26 Amy Archer", "S26 Cat Cole", "S26 Eli Eaves"]);

    // Escape throws the draft away, so Enter in the search sends only the filters in force.
    await openFilters(page);
    await page.getByRole("radiogroup", { name: "Has email" }).getByText("No", { exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("filters-toggle")).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("searchbox", { name: "Search leads" }).press("Enter");
    await expect(page).toHaveURL(/linkedin=yes/);
    await expect(page).not.toHaveURL(/email=no/);
    await expect(page.getByText("3 leads", { exact: true })).toBeVisible();

    // Campaign filter through the URL, and the clear link.
    await page.goto("/leads?q=s26&campaign=any");
    await expect.poll(() => firstNames(page)).toEqual(["S26 Dave Dunn"]);
    await page.goto("/leads?q=s26&campaign=none&email=yes");
    await expect(page.getByText("3 leads", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/leads$/);

    // Sort header: default newest first, then name ascending and descending.
    await page.goto("/leads?q=s26");
    await expect.poll(() => firstNames(page)).toEqual(["S26 Eli Eaves", "S26 Dave Dunn", "S26 Cat Cole", "S26 Ben Baker", "S26 Amy Archer"]);
    await page.locator('thead a[data-sort-key="name"]').click();
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=asc/);
    await expect.poll(() => firstNames(page)).toEqual(["S26 Amy Archer", "S26 Ben Baker", "S26 Cat Cole", "S26 Dave Dunn", "S26 Eli Eaves"]);
    await expect(page.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "ascending");
    await page.locator('thead a[data-sort-key="name"]').click();
    await expect(page).toHaveURL(/dir=desc/);
    await expect.poll(() => firstNames(page)).toEqual(["S26 Eli Eaves", "S26 Dave Dunn", "S26 Cat Cole", "S26 Ben Baker", "S26 Amy Archer"]);

    // Selection: delete-all-matching appears only while a filter or search is active.
    const selectAll = page.getByLabel("Select all leads on this page");
    await waitForHydrated(selectAll);
    await selectAll.click();
    await expect(page.getByRole("status")).toContainText("5 selected");
    // The delete actions live in the More actions menu, not in the bar.
    await expect(page.getByRole("button", { name: /Delete all 5 matching/ })).toHaveCount(0);
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: /Delete all 5 matching/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("link", { name: "Export selected" })).toHaveAttribute("href", /ids=/);
    await page.goto("/leads");
    const selectAllUnfiltered = page.getByLabel("Select all leads on this page");
    await waitForHydrated(selectAllUnfiltered);
    await selectAllUnfiltered.click();
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Delete selected" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Delete all .* matching/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // An empty filter is refused by the API.
    const refused = await page.request.post("/api/leads/delete", { data: { filter: {}, confirmCount: 1 } });
    expect(refused.status()).toBe(422);

    // AC5: the Leads page has no People and Companies switch, and no Companies link inside the page.
    await page.goto("/leads?q=s26");
    await expect(page.locator("#main-content").getByRole("link", { name: "Companies", exact: true })).toHaveCount(0);
    await expect(page.locator("#main-content").getByRole("navigation", { name: "Leads view" })).toHaveCount(0);
  });

  test("Lifecycle picks leads, contacts or both, with a chip and a URL that round-trip", async ({ page }) => {
    await signInAdmin(page);
    await seed();
    await page.goto("/leads?q=s26");
    // AC1: the default list shows leads only, with no lifecycle chip.
    await expect(page.getByText("5 leads", { exact: true })).toBeVisible();
    expect(await firstNames(page)).not.toContain("S26 Fay Fisher");
    await expect(page.getByTestId("filter-chip-lifecycle")).toHaveCount(0);

    // Leads and contacts: picked in the panel, written to the URL, shown as a chip, the contact marked.
    await openFilters(page);
    await expect(page.getByLabel("Lifecycle", { exact: true })).toHaveValue("");
    await page.getByLabel("Lifecycle", { exact: true }).selectOption("all");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page).toHaveURL(/lifecycle=all/);
    await expect(page.getByText("6 people", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Remove filter Lifecycle: Leads and contacts" })).toBeVisible();
    await expect(page.getByTestId("filters-toggle")).toHaveText(/^Filters\s*1 in use$/);
    await expect(page.getByLabel("Lifecycle", { exact: true })).toHaveValue("all");
    const fay = page.locator("tbody tr", { hasText: "S26 Fay Fisher" });
    await expect(fay.getByTestId("contact-chip")).toHaveText("Contact");
    await expect(fay.getByRole("link", { name: "S26 Fay Fisher" })).toHaveAttribute("href", /^\/crm\/contacts\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId("contact-chip")).toHaveCount(1);

    // AC6: Delete all matching is gone for a mixed list; Delete selected stays.
    const selectAll = page.getByLabel("Select all leads on this page");
    await waitForHydrated(selectAll);
    await selectAll.click();
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Delete selected" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Delete all .* matching/ })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Create deals" })).toBeVisible();
    await page.getByRole("menuitem").first().press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    // Contacts only, straight from the URL. No contact chip is needed when every row is one.
    await page.goto("/leads?q=s26&lifecycle=contact");
    await expect(page.getByText("1 contact", { exact: true })).toBeVisible();
    await expect.poll(() => firstNames(page)).toEqual(["S26 Fay Fisher"]);
    await expect(page.getByRole("link", { name: "Remove filter Lifecycle: Contacts" })).toBeVisible();
    await expect(page.getByTestId("contact-chip")).toHaveCount(0);
    const selectContacts = page.getByLabel("Select all leads on this page");
    await waitForHydrated(selectContacts);
    await selectContacts.click();
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.getByRole("menuitem", { name: /Delete all .* matching/ })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "Create deals" })).toHaveCount(0);
    await page.getByRole("menuitem").first().press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    // Removing the chip goes back to leads and drops the param.
    await page.getByRole("link", { name: "Remove filter Lifecycle: Contacts" }).click();
    await expect(page).not.toHaveURL(/lifecycle=/);
    await expect(page.getByText("5 leads", { exact: true })).toBeVisible();

    // Picking Leads in the panel posts an empty value, which reads as the default.
    await page.goto("/leads?q=s26&lifecycle=all");
    // The panel starts closed; the chip says what applies.
    await expect(page.getByRole("link", { name: "Remove filter Lifecycle: Leads and contacts" })).toBeVisible();
    await openFilters(page);
    await page.getByLabel("Lifecycle", { exact: true }).selectOption("");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(page).toHaveURL(/lifecycle=(&|$)/);
    await expect(page.getByText("5 leads", { exact: true })).toBeVisible();
    await expect(page.getByTestId("filter-chip-lifecycle")).toHaveCount(0);

    // The filter bar labels the reply taxonomy "Reply category".
    await openFilters(page);
    await expect(page.getByLabel("Reply category")).toBeVisible();
    await expect(page.getByText("CRM category")).toHaveCount(0);
  });
});
