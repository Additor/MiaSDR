import type { APIRequestContext, Page } from "@playwright/test";
import { cellUnder } from "./support/table";
import { e2eOrganizationId, expect, seedContact, seedReply, signInAdmin, sql, test, unique, waitForHydrated } from "./support/fixtures";

/**
 * Contacts and Companies ("Leads and CRM" in docs/decisions.md). Seeds its own people under a unique key:
 *   Rhea  replied to a campaign through the fake mailbox (source campaign, public conversation), company Orbit
 *   Cora  a cold lead with an active enrollment and no reply record, company Orbit
 *   Lee   a lead at Nimbus, which has no contact until Lee becomes one
 * Rhea and Cora become contacts through `POST /api/leads/[id]/convert`, the call the Create deal dialog makes.
 */
const KEY = unique("s36");
const SUFFIX = KEY.slice(4);
const RHEA = { email: `rhea-${SUFFIX}@s36.test`, firstName: "Rhea", lastName: `Reply ${SUFFIX}`, company: "Orbit" };
const ORBIT = `S36 Orbit ${SUFFIX}`;
const NIMBUS = `S36 Nimbus ${SUFFIX}`;
const UUID = /[0-9a-f-]{36}/;

interface World {
  orgId: string;
  rhea: string;
  cora: string;
  lee: string;
  orbit: string;
  nimbus: string;
  campaign: string;
}

let world: World | null = null;

async function convert(request: APIRequestContext, personId: string) {
  const res = await request.post(`/api/leads/${personId}/convert`, { data: { idempotencyKey: `${KEY}-${personId}` } });
  expect([200, 201], `convert ${personId}`).toContain(res.status());
  return ((await res.json()) as { dealId: string }).dealId;
}

/** Seeds once per run. Later tests reuse the people, so each test can run after the first in any order. */
async function seed(request: APIRequestContext): Promise<World> {
  if (world) return world;
  const db = sql();
  const orgId = await e2eOrganizationId();
  const { campaignId } = await seedReply(request, { key: KEY, mailbox: `sdr-${SUFFIX}@e2e-corp.test`, lead: RHEA, reply: { bodyText: "Sounds good, send me a proposal." } });
  const [orbit] = await db`insert into companies (organization_id, domain, name) values (${orgId}, ${`orbit-${SUFFIX}.test`}, ${ORBIT}) returning id`;
  const [nimbus] = await db`insert into companies (organization_id, domain, name) values (${orgId}, ${`nimbus-${SUFFIX}.test`}, ${NIMBUS}) returning id`;
  const [rhea] = await db`update people set company_id = ${orbit.id} where organization_id = ${orgId} and email = ${RHEA.email} returning id`;
  const [cora] = await db`
    insert into people (organization_id, email, full_name, first_name, title, company_id, source)
    values (${orgId}, ${`cora-${SUFFIX}@s36.test`}, ${`Cora Cold ${SUFFIX}`}, 'Cora', 'Head of Ops', ${orbit.id}, 'manual') returning id`;
  const [lee] = await db`
    insert into people (organization_id, email, full_name, first_name, company_id, source)
    values (${orgId}, ${`lee-${SUFFIX}@s36.test`}, ${`Lee Lead ${SUFFIX}`}, 'Lee', ${nimbus.id}, 'manual') returning id`;
  // A paused campaign that still holds Cora: the conversion cancels the enrollment with "Became a contact".
  const [autumn] = await db`insert into campaigns (organization_id, channel, name, status) values (${orgId}, 'email', ${`S36 Autumn ${SUFFIX}`}, 'paused') returning id`;
  await db`insert into campaign_enrollments (organization_id, campaign_id, person_id, channel, status) values (${orgId}, ${autumn.id}, ${cora.id}, 'email', 'active')`;
  await convert(request, rhea.id as string);
  await convert(request, cora.id as string);
  world = { orgId, rhea: rhea.id, cora: cora.id, lee: lee.id, orbit: orbit.id, nimbus: nimbus.id, campaign: campaignId };
  return world;
}


test.describe("contacts and companies", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test("the Contacts list shows each contact with company and open deals, and searches", async ({ page }) => {
    await signInAdmin(page);
    await seed(page.request);
    await page.goto(`/crm/contacts?q=${SUFFIX}`);
    const table = page.getByRole("table");
    const rhea = table.getByRole("row").filter({ hasText: `Rhea Reply ${SUFFIX}` });
    await expect(rhea).toContainText(ORBIT);
    const cell = (header: string) => cellUnder(table, rhea, header);
    await expect((await cell("Reach")).getByRole("link", { name: `Email ${RHEA.email}` })).toHaveAttribute("href", `mailto:${RHEA.email}`);
    await expect(await cell("Email")).toHaveText(RHEA.email);
    await expect(await cell("Latest deal")).toHaveText("New");
    await expect(await cell("Deal owner")).not.toHaveText("No owner");
    await expect(await cell("Open deals")).toHaveText("1");
    // A contact carries no lead status.
    await expect(rhea.getByTestId("lead-status")).toHaveCount(0);
    await expect(table.getByRole("row").filter({ hasText: `Cora Cold ${SUFFIX}` })).toBeVisible();
    // A lead is not a contact.
    await expect(table.getByText(`Lee Lead ${SUFFIX}`)).toHaveCount(0);
    await expect(page.getByText("2 contacts", { exact: true })).toBeVisible();

    // Sort by name, then back to the default order with a second click.
    await page.getByRole("link", { name: "Sort by name" }).click();
    await expect(page).toHaveURL(/sort=name/);
    await expect(table.getByRole("row").nth(1)).toContainText("Cora Cold");
    await page.getByRole("link", { name: /Name, sorted/ }).click();
    await expect(page).not.toHaveURL(/sort=/);

    await page.goto(`/crm/contacts?q=nobody-${SUFFIX}`);
    await expect(page.getByText("No contacts match", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Clear search" })).toHaveAttribute("href", "/crm/contacts");

    // The Stage filter keeps the contacts whose latest deal sits in that stage, and the URL keeps the filter.
    const stages = ((await (await page.request.get("/api/deal-stages")).json()) as { stages: Array<{ id: string; name: string }> }).stages;
    const meeting = stages.find((s) => s.name === "Meeting")!.id;
    const [coraDeal] = await sql()`select id, version from deals where person_id = ${world!.cora} order by created_at desc limit 1`;
    const moved = await page.request.post(`/api/deals/${coraDeal.id}/stage`, { data: { stageId: meeting, expectedVersion: coraDeal.version } });
    expect(moved.status(), "move Cora's deal to Meeting").toBe(200);
    await page.goto(`/crm/contacts?q=${SUFFIX}`);
    const stageFilter = page.getByRole("combobox", { name: "Deal stage" });
    await waitForHydrated(stageFilter);
    await stageFilter.click();
    await page.getByRole("option", { name: "Meeting", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`stage=${meeting}`));
    await expect(page.getByText("1 contact", { exact: true })).toBeVisible();
    await expect(await cellUnder(table, table.getByRole("row").filter({ hasText: `Cora Cold ${SUFFIX}` }), "Latest deal")).toHaveText("Meeting");
    await expect(table.getByText(`Rhea Reply ${SUFFIX}`)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Deal stage" })).toContainText("Meeting");
    await expect(page.getByText("1 contact", { exact: true })).toBeVisible();

    await rowOpen(page, `/crm/contacts?q=${SUFFIX}`, `Rhea Reply ${SUFFIX}`);
    await expect(page).toHaveURL(new RegExp(`/crm/contacts/${world!.rhea}(\\?from=[^#]*)?$`));
  });

  test("the contact page shows the summary, deals, outreach history, tasks, notes, details and do not contact", async ({ page }) => {
    await signInAdmin(page);
    const w = await seed(page.request);
    await page.goto(`/crm/contacts/${w.rhea}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Rhea Reply ${SUFFIX}`);
    const summary = page.getByTestId("contact-summary");
    // The header carries no status: no status line, no lead status token. Contact since and the source campaign are Details facts.
    await expect(summary).not.toContainText("Contact since");
    await expect(summary.getByTestId("lead-status")).toHaveCount(0);
    await expect(summary.getByRole("list", { name: "Contact status" })).toHaveCount(0);
    // Deal links name the contact page, so a deal delete returns here.
    const fromContact = `\\?from=%2Fcrm%2Fcontacts%2F${w.rhea}`;
    await expect(summary.getByRole("link", { name: "Open deal" })).toHaveAttribute("href", new RegExp(`^/crm/deals/${UUID.source}${fromContact}$`));
    const facts = page.getByTestId("person-details");
    await expect(facts).toContainText("Contact since");
    await expect(facts.getByTestId("contact-source")).toHaveText(`${KEY} campaign`);
    await expect(facts.getByRole("link", { name: `${KEY} campaign` })).toHaveAttribute("href", `/campaigns/${w.campaign}`);
    await expect(summary.getByRole("link", { name: ORBIT, exact: true })).toHaveAttribute("href", `/crm/companies/${w.orbit}`);
    await expect(summary.getByRole("link", { name: "Open conversation" })).toHaveAttribute("href", new RegExp(`^/inbox/${UUID.source}$`));

    const deals = page.getByTestId("contact-deals");
    await expect(deals.getByRole("row").nth(1).getByRole("link").first()).toHaveAttribute("href", new RegExp(`^/crm/deals/${UUID.source}${fromContact}$`));
    await expect(deals.getByText("1 open of 1")).toBeVisible();
    const create = summary.getByRole("button", { name: "Create deal" });
    await waitForHydrated(create);
    await create.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Adds a deal for Rhea Reply ${SUFFIX}.`);
    await expect(dialog).toContainText(`Rhea Reply ${SUFFIX} already has 1 open deal.`);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);

    // Outreach history starts collapsed; the replied enrollment is inside.
    const history = page.getByTestId("outreach-history");
    await expect(history).not.toHaveAttribute("open");
    await expect(history.getByText("1 campaign, 1 send")).toBeVisible();
    await history.locator("summary").click();
    await expect(history.getByRole("link", { name: `${KEY} campaign` })).toBeVisible();

    // Activity opens on Tasks for a contact; Notes and History are the other tabs.
    await expect(page.locator('[data-slot="tasks-panel"]')).toBeVisible();
    await expect(page.getByRole("tab", { name: /Notes/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /History/ })).toBeVisible();
    const details = page.getByTestId("person-details");
    await expect(details.getByRole("heading", { level: 2, name: "Details" })).toBeVisible();
    await waitForHydrated(details.getByRole("button", { name: "Edit Email" }));
    await details.getByRole("button", { name: "Edit Email" }).click();
    await expect(details.getByText("A contact needs an email or a LinkedIn profile.")).toBeVisible();
    await details.getByRole("button", { name: "Cancel" }).click();
    // Rhea has an open deal, so the delete row names it and offers no button.
    const deletion = page.getByTestId("contact-delete");
    await expect(deletion.getByTestId("contact-delete-state")).toHaveText("This contact cannot be deleted.");
    await expect(deletion).toContainText(`Rhea Reply ${SUFFIX} has 1 open deal. Close or delete them first.`);
    await expect(deletion.getByRole("link", { name: /, New$/ })).toHaveAttribute("href", new RegExp(`^/crm/deals/${UUID.source}${fromContact}$`));
    await expect(page.getByTestId("person-stop").getByRole("button", { name: "Mark do not contact" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Delete (lead|contact)/ })).toHaveCount(0);
    await history.locator("summary").click();

    // Cora's cancelled enrollment reads "Became a contact"; she has no conversation and no source campaign.
    await page.goto(`/crm/contacts/${w.cora}`);
    await expect(page.getByTestId("contact-summary").getByRole("link", { name: "Open conversation" })).toHaveCount(0);
    await expect(page.getByTestId("contact-source")).toHaveCount(0);
    const coraHistory = page.getByTestId("outreach-history");
    await coraHistory.locator("summary").click();
    await expect(coraHistory.getByRole("row").filter({ hasText: `S36 Autumn ${SUFFIX}` })).toContainText("Became a contact");
  });

  test("a contact with no reply record takes a note and a task", async ({ page }) => {
    await signInAdmin(page);
    const w = await seed(page.request);
    const [records] = await sql()`select count(*)::int as n from records where person_id = ${w.cora}`;
    expect(records.n, "Cora has no reply record").toBe(0);
    await page.goto(`/crm/contacts/${w.cora}`);

    const note = `Prefers email after 3pm ${SUFFIX}`;
    const notesTab = page.getByRole("tab", { name: /Notes/ });
    await waitForHydrated(notesTab);
    await notesTab.click();
    const noteBody = page.getByLabel("Note", { exact: true });
    await noteBody.fill(note);
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByText(note)).toBeVisible();

    await page.getByRole("tab", { name: /Tasks/ }).click();
    const panel = page.locator('[data-slot="tasks-panel"]');
    const task = `Send the pricing sheet ${SUFFIX}`;
    await waitForHydrated(panel.getByLabel("New task"));
    await panel.getByLabel("New task").fill(task);
    await panel.getByRole("button", { name: "Add task" }).click();
    await expect(panel.getByText(task)).toBeVisible();

    await page.reload();
    await expect(page.locator('[data-slot="tasks-panel"]').getByText(task)).toBeVisible();
    await waitForHydrated(page.getByRole("tab", { name: /Notes/ }));
    await page.getByRole("tab", { name: /Notes/ }).click();
    await expect(page.getByText(note)).toBeVisible();
    const [stored] = await sql()`
      select (select count(*)::int from notes where person_id = ${w.cora} and record_id is null and body = ${note}) as notes,
             (select count(*)::int from tasks where person_id = ${w.cora} and record_id is null and name = ${task}) as tasks`;
    expect(stored).toEqual({ notes: 1, tasks: 1 });
  });

  test("a lead id opens the lead page, and unknown or foreign ids are not found", async ({ page, watch }) => {
    await signInAdmin(page);
    const w = await seed(page.request);
    await page.goto(`/crm/contacts/${w.lee}`);
    await expect(page).toHaveURL(new RegExp(`/leads/${w.lee}$`));

    const db = sql();
    const [other] = await db`insert into organizations (name, slug) values ('S36 Other', ${`s36-other-${SUFFIX}`}) returning id`;
    const [stranger] = await db`insert into people (organization_id, email, full_name, lifecycle, converted_at) values (${other.id}, ${`x-${SUFFIX}@other.test`}, 'Stranger', 'contact', now()) returning id`;
    const [foreignCompany] = await db`insert into companies (organization_id, domain, name) values (${other.id}, ${`other-${SUFFIX}.test`}, 'Other Co') returning id`;
    watch.tolerate(/response 404/);
    for (const path of [`/crm/contacts/${stranger.id}`, "/crm/contacts/not-an-id", `/crm/companies/${foreignCompany.id}`, "/crm/companies/not-an-id"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }), path).toHaveText("Page not found");
    }
  });

  test("a company appears once one of its people is a contact, and its page lists contacts and deals", async ({ page }) => {
    await signInAdmin(page);
    const w = await seed(page.request);
    await page.goto(`/crm/companies?q=${SUFFIX}`);
    const companies = page.getByRole("table");
    const orbit = companies.getByRole("row").filter({ hasText: ORBIT });
    await expect(await cellUnder(companies, orbit, "Contacts")).toHaveText("2");
    await expect(await cellUnder(companies, orbit, "Open deals")).toHaveText("2");
    // The deals carry no amount.
    await expect(await cellUnder(companies, orbit, "Open amount")).toHaveText("");
    await expect(await cellUnder(companies, orbit, "Last activity")).not.toHaveText("None yet");
    await expect(page.getByText(NIMBUS)).toHaveCount(0);

    await convert(page.request, w.lee);
    await page.goto(`/crm/companies?q=${SUFFIX}`);
    await expect(await cellUnder(companies, companies.getByRole("row").filter({ hasText: NIMBUS }), "Contacts")).toHaveText("1");
    await expect(page.getByText("2 companies", { exact: true })).toBeVisible();

    await rowOpen(page, `/crm/companies?q=${SUFFIX}`, ORBIT);
    await expect(page).toHaveURL(new RegExp(`/crm/companies/${w.orbit}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(ORBIT);
    await expect(page.getByTestId("company-header")).toContainText(`orbit-${SUFFIX}.test`);
    const contacts = page.getByTestId("company-contacts");
    await expect(contacts.getByRole("link", { name: `Rhea Reply ${SUFFIX}`, exact: true })).toHaveAttribute("href", `/crm/contacts/${w.rhea}?from=${encodeURIComponent(`/crm/companies/${w.orbit}`)}`);
    await expect(contacts.getByRole("link", { name: `Cora Cold ${SUFFIX}`, exact: true })).toBeVisible();
    const deals = page.getByTestId("company-deals");
    await expect(deals.getByText("2 open of 2")).toBeVisible();
    await expect(deals.getByRole("link", { name: `Cora Cold ${SUFFIX}`, exact: true })).toHaveAttribute("href", `/crm/contacts/${w.cora}`);
  });

  test("a company that loses its last contact stays in Companies", async ({ page }) => {
    await signInAdmin(page);
    await seed(page.request);
    const domain = `vega-${SUFFIX}.test`;
    const vega = `S36 Vega ${SUFFIX}`;
    const { personId } = await seedContact(page.request, { firstName: "Vic", lastName: `Vega ${SUFFIX}`, email: `vic@${domain}`, companyDomain: domain, companyName: vega });
    const preview = (await (await page.request.get(`/api/contacts/${personId}/delete-preview`)).json()) as { counts: { deals: { won: number; lost: number }; notes: number; tasks: number; events: number; conversations: number; messages: number; sends: number } };
    const { counts } = preview;
    const query = new URLSearchParams({ deals: String(counts.deals.won + counts.deals.lost), notes: String(counts.notes), tasks: String(counts.tasks), events: String(counts.events), conversations: String(counts.conversations), messages: String(counts.messages), sends: String(counts.sends) });
    expect((await page.request.delete(`/api/contacts/${personId}?${query}`)).status(), "delete the last contact").toBe(200);

    await page.goto(`/crm/companies?q=${encodeURIComponent(vega)}`);
    const companies = page.getByRole("table");
    await expect(await cellUnder(companies, companies.getByRole("row").filter({ hasText: vega }), "Contacts")).toHaveText("0");
  });

  test("the company page edits the LinkedIn page and a company field, and keeps the domain", async ({ page }) => {
    await signInAdmin(page);
    const w = await seed(page.request);
    const field = `Tier ${SUFFIX}`;
    const created = await page.request.post("/api/leads/columns", { data: { entity: "companies", name: field } });
    expect(created.status(), "create the company field").toBe(201);

    await page.goto(`/crm/companies/${w.nimbus}`);
    const form = page.getByTestId("company-details");
    // Each fact saves on its own: the LinkedIn page with Enter, then a value for the company field through Add field.
    await waitForHydrated(form.getByRole("button", { name: "Edit LinkedIn" }));
    await form.getByRole("button", { name: "Edit LinkedIn" }).click();
    await form.getByRole("textbox", { name: "LinkedIn" }).fill("linkedin.com/company/Nimbus-S36");
    await page.keyboard.press("Enter");
    await expect(page.getByText("LinkedIn page saved.")).toBeVisible();
    await expect(form.getByRole("textbox", { name: "LinkedIn" })).toHaveCount(0);
    await form.getByRole("button", { name: "Add field" }).click();
    await form.getByLabel("Field").fill(field);
    await form.getByLabel("Value").fill("Gold");
    await form.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText(`${field} saved.`)).toBeVisible();

    await page.reload();
    // The header carries the domain and LinkedIn links; Details lists the fields.
    const header = page.getByTestId("company-header");
    await expect(header.getByRole("link", { name: "LinkedIn page (opens in a new tab)" })).toHaveAttribute("href", "https://www.linkedin.com/company/nimbus-s36/");
    await expect(header.getByRole("link", { name: `nimbus-${SUFFIX}.test (opens in a new tab)` })).toBeVisible();
    await expect(form.getByText("Gold", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(NIMBUS);
  });
});

async function rowOpen(page: Page, listPath: string, name: string) {
  await page.goto(listPath);
  await page.getByRole("table").getByRole("link", { name, exact: true }).click();
}
