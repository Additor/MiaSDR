import type { Locator, Page } from "@playwright/test";
import { e2eOrganizationId, expect, MOBILE_DARK, expectNoHorizontalOverflow, signInAdmin, sql, test, unique, waitForHydrated } from "./support/fixtures";

/**
 * The lead page: a record header with the name as h1, one lead status token and reach links that show their state, empty Campaigns and Send
 * history collapsed to one line, a Details panel that reads first and edits in three groups, previous and next links
 * that follow the list the lead was opened from, one Do not contact card whose button validates on click and whose
 * delete says before the click whether the lead qualifies, and touch targets that hold at 390px in the dark theme.
 * Seeds five leads "S34 ..." and one throwaway lead.
 */
const NAMES = ["S34 Alpha Adams", "S34 Bea Beta", "S34 Cleo Chen", "S34 Dara Delta", "S34 Eli Echo"] as const;

async function seed() {
  const db = sql();
  const orgId = await e2eOrganizationId();
  // Events are append-only, so a lead that was marked do-not-contact cannot be deleted. Seed once, then reset state.
  const existing = await db`select id, full_name from people where organization_id = ${orgId} and full_name like 'S34 %'`;
  if (existing.length > 0) {
    await db`delete from contact_policies where organization_id = ${orgId} and person_id in ${db(existing.map((r) => r.id as string))}`;
    const byName = Object.fromEntries(existing.map((r) => [r.full_name as string, r.id as string]));
    if (!byName["S34 Zed Throwaway"]) {
      const [row] = await db`insert into people (organization_id, email, full_name, source) values (${orgId}, 'zed@s34.test', 'S34 Zed Throwaway', 'manual') returning id`;
      byName["S34 Zed Throwaway"] = row.id as string;
    }
    return byName;
  }
  const ids: Record<string, string> = {};
  const add = async (name: string, email: string | null, slug: string | null, phone: string | null, day: number, raw: object | null = null) => {
    const at = `2024-04-${String(day).padStart(2, "0")}T10:00:00Z`;
    const [row] = await db`
      insert into people (organization_id, email, linkedin_slug, phone, full_name, first_name, title, source, raw, created_at, updated_at)
      values (${orgId}, ${email}, ${slug}, ${phone}, ${name}, ${name.split(" ")[1]}, 'Engineer', 'manual', ${raw ? db.json(raw as never) : null}, ${at}, ${at}) returning id`;
    ids[name] = row.id as string;
  };
  await add(NAMES[0], null, "s34-alpha", null, 1);
  await add(NAMES[1], "bea@s34.test", "s34-bea", "+15550100123", 2, { Region: "EMEA" });
  await add(NAMES[2], "cleo@s34.test", null, null, 3);
  await add(NAMES[3], "dara@s34.test", null, null, 4);
  await add(NAMES[4], "eli@s34.test", null, null, 5);
  await add("S34 Zed Throwaway", "zed@s34.test", null, null, 6);
  const [campaign] = await db`insert into campaigns (organization_id, channel, name, status) values (${orgId}, 'email', 'S34 Autumn push', 'active') returning id`;
  await db`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${orgId}, ${campaign.id}, ${ids[NAMES[3]]}, 'email', 'replied')`;
  await db`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status, current_step) values (${orgId}, ${campaign.id}, ${ids[NAMES[4]]}, 'email', 'active', 1)`;
  await db`insert into suppression_list (organization_id, email, reason) values (${orgId}, 'dara@s34.test', 'bounced') on conflict do nothing`;
  return ids;
}

/** Height in CSS pixels, rounded so a 43.98px box still counts as 44. */
async function heightOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, "the control is on screen").not.toBeNull();
  return Math.round(box!.height);
}

const openFromList = async (page: Page, listPath: string, name: string) => {
  await page.goto(listPath);
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}\?list=/);
  await expect(page.getByTestId("lead-header")).toBeVisible();
};

test.describe("lead page header, collapsed cards and groups", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("shows the status token, working links and one-line empty sections", async ({ page }) => {
    await signInAdmin(page);
    await seed();
    await openFromList(page, "/leads?q=S34&sort=name&dir=asc", "S34 Bea Beta");

    const header = page.getByTestId("lead-header");
    // One token beside the name; an open channel is a working link with no "can be contacted" text.
    await expect(header.getByTestId("lead-status")).toHaveAttribute("data-state", "new");
    await expect(header.getByTestId("lead-status")).toHaveText("New");
    await expect(header.getByText(/can be contacted/i)).toHaveCount(0);
    await expect(header.getByRole("list", { name: "Lead status" })).toHaveCount(0);
    await expect(header.getByRole("link", { name: "bea@s34.test" })).toHaveAttribute("href", "mailto:bea@s34.test");
    const linkedin = header.getByRole("link", { name: /LinkedIn profile/ });
    await expect(linkedin).toHaveAttribute("href", "https://www.linkedin.com/in/s34-bea/");
    await expect(linkedin).toHaveAttribute("target", "_blank");
    await expect(linkedin).toHaveAttribute("rel", /noopener/);
    await expect(linkedin).toHaveAccessibleName(/opens in a new tab/);
    await expect(header.getByRole("link", { name: "+15550100123" })).toHaveAttribute("href", "tel:+15550100123");
    await expect(header.getByRole("button", { name: "Add to campaign" })).toBeVisible();
    // Create deal is the primary action and comes first.
    const actions = header.getByRole("button", { name: /^(Create deal|Add to campaign)$/ });
    await expect(actions).toHaveText(["Create deal", "Add to campaign"]);
    expect(await actions.first().evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await expect(page.getByTestId("person-stop").getByRole("heading", { level: 2, name: "Do not contact" })).toBeVisible();
    await expect(header.getByRole("heading", { level: 1 })).toHaveText("S34 Bea Beta");

    // Empty Campaigns and Send history are one line each, not cards.
    await expect(page.getByTestId("campaigns-empty")).toContainText("This lead is not in any campaign");
    await expect(page.getByTestId("sends-empty")).toContainText("Nothing sent to this lead yet");
    await expect(page.getByTestId("campaigns")).toHaveCount(0);
    await expect(page.getByText("The last 1 attempts")).toHaveCount(0);

    // Details starts high on the page and reads first; each fact opens its own editor in its row.
    const details = page.getByTestId("person-details");
    const top = (await details.getByRole("heading", { name: "Details" }).boundingBox())!.y;
    expect(top, "Details starts above the fold at 1440x900").toBeLessThan(450);
    await expect(details.getByRole("link", { name: "bea@s34.test" })).toBeVisible();
    const editPhone = details.getByRole("button", { name: "Edit Phone" });
    await waitForHydrated(editPhone);
    await editPhone.click();
    await expect(details.getByRole("textbox", { name: "Phone" })).toHaveAttribute("placeholder", "+1 555 0100");
    // Escape leaves the row as it was and hands focus back to its pencil.
    await page.keyboard.press("Escape");
    await expect(details.getByRole("textbox", { name: "Phone" })).toHaveCount(0);
    await expect(editPhone).toBeFocused();
    // A new domain asks for the company name.
    await details.getByRole("button", { name: "Edit Company" }).click();
    await details.getByLabel("Website or domain").fill("s34-new-co.test");
    await expect(details.getByLabel("Company name", { exact: true })).toBeVisible();
    await expect(details.getByText("Names the company when the domain is new.")).toBeVisible();
    await details.getByRole("button", { name: "Cancel" }).click();
  });

  test("keeps the sections when they hold rows, names the status and shows a suppressed address in place", async ({ page }) => {
    await signInAdmin(page);
    const ids = await seed();
    await page.goto(`/leads/${ids[NAMES[3]]}`);
    const header = page.getByTestId("lead-header");
    await expect(header.getByTestId("lead-status")).toHaveAttribute("data-state", "replied");
    await expect(header.getByTestId("lead-status")).toContainText("Replied");
    await expect(page.getByTestId("campaigns").getByRole("heading", { name: "Campaigns" })).toBeVisible();
    await expect(page.getByTestId("campaigns-empty")).toHaveCount(0);
    // Suppression blocks email only: the address stays a link, crossed out, and says why on focus.
    const email = header.getByTestId("reach-email-suppressed");
    await expect(email).toHaveAttribute("href", "mailto:dara@s34.test");
    await expect(email).toHaveAccessibleName(/Email suppressed: Bounced/);
    await waitForHydrated(email);
    await email.focus();
    await expect(page.locator('[data-slot="tooltip-content"]')).toContainText("Email suppressed: Bounced, since");
    await expect(header.getByTestId("reach-dnc")).toHaveCount(0);

    // A lead in a running campaign: the token says In sequence and its tooltip names the campaign and the steps.
    await page.goto(`/leads/${ids[NAMES[4]]}`);
    const token = page.getByTestId("lead-header").getByTestId("lead-status");
    await expect(token).toHaveAttribute("data-state", "in_sequence");
    await waitForHydrated(token);
    await token.hover();
    const tip = page.locator('[data-slot="tooltip-content"]');
    await expect(tip).toContainText("S34 Autumn push");
    await expect(tip).toContainText("1 step sent");
  });

  test("labels the imported fields and gives the map button the visible words in its name", async ({ page }) => {
    await signInAdmin(page);
    const ids = await seed();
    await page.goto(`/leads/${ids[NAMES[1]]}`);
    await expect(page.getByText("Imported fields", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Columns of the imported file that were not mapped to a lead field.")).toBeVisible();
    await expect(page.getByText("Source data")).toHaveCount(0);
    const map = page.getByRole("button", { name: "Map this field: Region" });
    await expect(map).toBeVisible();
    await expect(map).toHaveText("Map this field");
    // Without unmapped columns the section stays away.
    await page.goto(`/leads/${ids[NAMES[0]]}`);
    await expect(page.getByTestId("imported-fields")).toHaveCount(0);
  });
});

test.describe("previous and next follow the list", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("moves through the sorted list, stops at its ends and hides without a list", async ({ page }) => {
    await signInAdmin(page);
    const ids = await seed();
    const nav = page.getByRole("navigation", { name: "Leads in this list" });

    await openFromList(page, "/leads?q=S34&sort=name&dir=asc", "S34 Bea Beta");
    await nav.getByRole("link", { name: "Next lead" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("S34 Cleo Chen");
    await expect(page).toHaveURL(/list=/);
    await nav.getByRole("link", { name: "Previous lead" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("S34 Bea Beta");
    await nav.getByRole("link", { name: "Previous lead" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("S34 Alpha Adams");
    // First lead of the list: no link, and the control says why.
    await expect(nav.getByRole("link", { name: /Previous/ })).toHaveCount(0);
    await expect(nav.getByText("Previous")).toHaveAttribute("aria-disabled", "true");

    // The back link returns to the same filtered and sorted list.
    await page.getByRole("link", { name: "Back to Leads" }).click();
    await expect(page).toHaveURL(/q=S34/);
    await expect(page).toHaveURL(/sort=name/);

    // Descending sort reverses the walk.
    await openFromList(page, "/leads?q=S34&sort=name&dir=desc", "S34 Bea Beta");
    await nav.getByRole("link", { name: "Next lead" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("S34 Alpha Adams");

    // A filter drops the leads that do not match: Alpha has no email, so Bea is first.
    await openFromList(page, "/leads?q=S34&email=yes&sort=name&dir=asc", "S34 Bea Beta");
    await expect(nav.getByRole("link", { name: /Previous/ })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Next lead" })).toBeVisible();

    // Opened without a list, the controls are gone.
    await page.goto(`/leads/${ids[NAMES[1]]}`);
    await expect(page.getByTestId("lead-header")).toBeVisible();
    await expect(nav).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Back to Leads" })).toHaveAttribute("href", "/leads");
  });
});

test.describe("contact and removal", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("validates the do-not-contact reason on click and says whether delete qualifies", async ({ page }) => {
    await signInAdmin(page);
    const ids = await seed();
    await page.goto(`/leads/${ids[NAMES[2]]}`);
    const section = page.getByTestId("person-stop");
    await waitForHydrated(section.getByRole("button", { name: "Mark do not contact" }));

    // A quiet button opens the reason field; the red confirm button stays enabled and says an empty reason on click.
    await section.getByRole("button", { name: "Mark do not contact" }).click();
    const mark = section.getByRole("button", { name: "Confirm do not contact" });
    await expect(mark).toBeEnabled();
    await mark.click();
    await expect(section.getByRole("alert")).toHaveText("Type a reason to mark this person do not contact.");
    await expect(section.getByLabel("Reason")).toHaveAttribute("aria-invalid", "true");
    await section.getByLabel("Reason").fill("Asked to stop");
    await expect(section.getByRole("alert")).toHaveCount(0);

    // The delete row says it qualifies and the confirmation repeats it with what is protected.
    await expect(page.getByTestId("delete-qualification")).toContainText("This lead can be deleted.");
    await section.getByRole("button", { name: "Delete lead" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("This lead can be deleted.");
    await expect(dialog).toContainText("protected");
    await expect(dialog).toContainText("cannot be undone");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await mark.click();
    await expect(page.getByTestId("lead-header").getByTestId("reach-dnc")).toContainText("Do not contact");
    // Do not contact is reach, not a lead status: the token keeps its own state.
    await expect(page.getByTestId("lead-header").getByTestId("lead-status")).toHaveAttribute("data-state", "new");
    await expect(section.getByRole("button", { name: "Clear do not contact" })).toBeVisible();

    // A lead in a running campaign gets the reason and no delete button.
    await page.goto(`/leads/${ids[NAMES[4]]}`);
    await expect(page.getByTestId("delete-qualification")).toContainText("This lead cannot be deleted.");
    await expect(page.getByTestId("delete-qualification")).toContainText("running or paused campaign");
    await expect(page.getByTestId("person-stop").getByRole("button", { name: "Delete lead" })).toHaveCount(0);
  });

  test("deletes a lead that qualifies and returns to the list it came from", async ({ page }) => {
    await signInAdmin(page);
    await seed();
    await openFromList(page, "/leads?q=S34+Zed", "S34 Zed Throwaway");
    const section = page.getByTestId("person-stop");
    await waitForHydrated(section.getByRole("button", { name: "Delete lead" }));
    await section.getByRole("button", { name: "Delete lead" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete lead" }).click();
    // The toast names the lead, as the contact delete does.
    await expect(page.getByText("Deleted S34 Zed Throwaway.", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/leads\?q=S34\+Zed|\/leads\?q=S34%20Zed/);
    await expect(page.getByText("No leads match", { exact: true })).toBeVisible();
  });
});

test.describe("create deal from the lead page", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("opens the deal page, drops the person from the default list and sends its lead page to the contact page", async ({ page }) => {
    await signInAdmin(page);
    const db = sql();
    const org = { id: await e2eOrganizationId() };
    const name = `S34 Deal ${unique("d")}`;
    const [row] = await db`insert into people (organization_id, email, full_name, title, source) values (${org.id}, ${`${name.replace(/\W+/g, "-").toLowerCase()}@s34.test`}, ${name}, 'Engineer', 'manual') returning id`;
    const id = row.id as string;

    await page.goto(`/leads/${id}`);
    const create = page.getByTestId("lead-header").getByRole("button", { name: "Create deal" });
    await waitForHydrated(create);
    await create.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: `Create deal for ${name}` })).toBeVisible();
    await expect(dialog).toContainText(`Moves ${name} to Contacts.`);
    await expect(dialog.getByRole("button", { name: "Create deal" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Create deal" }).click();

    // AC2: the deal page, then the default list no longer holds the person.
    await expect(page).toHaveURL(/\/crm\/deals\/[0-9a-f-]{36}$/);
    await page.goto(`/leads?q=${encodeURIComponent(name)}`);
    await expect(page.getByText("No leads match", { exact: true })).toBeVisible();
    await page.goto(`/leads?q=${encodeURIComponent(name)}&lifecycle=contact`);
    await expect(page.locator("tbody tr")).toHaveCount(1);

    // AC4: the old lead page answers 200 (the page streams) and ends on the contact page through a client redirect.
    const response = await page.goto(`/leads/${id}`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/crm/contacts/${id}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  });
});

test.describe("at 390px in the dark theme", () => {
  test.use(MOBILE_DARK);

  test("keeps touch targets at 44px and does not scroll sideways", async ({ page }) => {
    await signInAdmin(page);
    await seed();
    await openFromList(page, "/leads?q=S34&sort=name&dir=asc", "S34 Bea Beta");
    const header = page.getByTestId("lead-header");
    await expectNoHorizontalOverflow(page);

    const targets: Array<[string, Locator]> = [
      ["Create deal", header.getByRole("button", { name: "Create deal" })],
      ["Add to campaign", header.getByRole("button", { name: "Add to campaign" })],
      ["Previous", page.getByRole("link", { name: "Previous lead" })],
      ["Next", page.getByRole("link", { name: "Next lead" })],
      ["email link", header.getByRole("link", { name: "bea@s34.test" })],
      ["LinkedIn link", header.getByRole("link", { name: /LinkedIn profile/ })],
      ["phone link", header.getByRole("link", { name: "+15550100123" })],
      ["Edit email", page.getByTestId("person-details").getByRole("button", { name: "Edit Email" })],
      ["Mark do not contact", page.getByRole("button", { name: "Mark do not contact" })],
      ["Delete lead", page.getByRole("button", { name: "Delete lead" })],
    ];
    for (const [label, locator] of targets) {
      await locator.scrollIntoViewIfNeeded();
      expect(await heightOf(locator), `${label} is at least 44px tall`).toBeGreaterThanOrEqual(44);
    }
    // Every other control is at least 24px.
    for (const button of await page.locator("main").getByRole("button").all()) {
      if (!(await button.isVisible())) continue;
      const box = await button.boundingBox();
      if (box && box.width > 0) expect(Math.round(box.height), `button ${await button.innerText()}`).toBeGreaterThanOrEqual(24);
    }
    await expectNoHorizontalOverflow(page);
  });
});
