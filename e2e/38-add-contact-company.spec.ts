import type { Page } from "@playwright/test";
import { MOBILE_DARK, expect, expectNoHorizontalOverflow, importLeads, seedCompanyAlias, seedUnlistedCompany, signInAdmin, sql, test, unique, waitForHydrated } from "./support/fixtures";

/**
 * Add contact and Add company ("Contacts and Companies CRUD" in docs/decisions.md). Each run uses its own suffix:
 *   Acme      a listed company, added through `POST /api/companies`, which the live lookup finds
 *   Lena      an imported lead whose email Add contact meets, so the dialog offers to make her a contact
 *   Newco     added through the dialog, then given another domain (Oldco) as a merge leaves it
 *   Leadsonly a company with leads only, which Add company lists
 */
const KEY = unique("s38");
const S = KEY.slice(4);
const ACME = { domain: `acme-${S}.test`, name: `S38 Acme ${S}` };
const NEWCO = { domain: `newco-${S}.test`, name: `S38 Newco ${S}` };
const OLDCO = `oldco-${S}.test`;
const LEADSONLY = { domain: `leadsonly-${S}.test`, name: `S38 Leadsonly ${S}` };
const LENA = { email: `lena-${S}@s38.test`, firstName: "Lena", lastName: `Lead ${S}` };
const LENA_NAME = `${LENA.firstName} ${LENA.lastName}`;
const UUID = "[0-9a-f-]{36}";

let acmeAdded = false;

/** Acme exists once per run, so each test can run alone after the first. */
async function ensureAcme(page: Page): Promise<void> {
  if (acmeAdded) return;
  const res = await page.request.post("/api/companies", { data: ACME });
  expect([200, 201], "add Acme").toContain(res.status());
  acmeAdded = true;
}

async function openAddContact(page: Page) {
  await page.goto("/crm/contacts");
  const open = page.locator("header").first().getByRole("button", { name: "Add contact", exact: true });
  await waitForHydrated(open);
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Add contact" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openAddCompany(page: Page) {
  await page.goto("/crm/companies");
  const open = page.locator("header").first().getByRole("button", { name: "Add company", exact: true });
  await waitForHydrated(open);
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Add company" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("add contact and add company", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test("Add contact without a deal: the live lookup joins a known company and drops a typed name", async ({ page }) => {
    await signInAdmin(page);
    await ensureAcme(page);
    const dialog = await openAddContact(page);
    await dialog.getByLabel("First name").fill("Ann");
    await dialog.getByLabel("Last name").fill(`Add ${S}`);
    await dialog.getByLabel("Email").fill(`ann-${S}@s38.test`);
    await dialog.getByLabel("Job title").fill("Head of Ops");
    await expect(dialog.getByText("Add a phone number and custom fields on the contact page.")).toBeVisible();

    // A new domain asks for the company's name.
    await dialog.getByLabel("Website or domain").fill(`fresh-${S}.test`);
    await expect(dialog.getByLabel("Company name")).toBeVisible();
    await dialog.getByLabel("Company name").fill("Typed Co");

    // Acme's domain turns the name field into the join line, and the typed name goes.
    await dialog.getByLabel("Website or domain").fill(`https://www.${ACME.domain}/about`);
    const join = dialog.getByTestId("company-join");
    await expect(join).toContainText(`Joins ${ACME.name} (${ACME.domain}).`);
    await expect(join.getByRole("link", { name: ACME.name })).toHaveAttribute("href", new RegExp(`/crm/companies/${UUID}$`));
    await expect(join).toContainText(`MiaSDR drops the name you typed. Rename ${ACME.name} on its company page.`);
    await expect(dialog.getByLabel("Company name")).toHaveCount(0);

    await dialog.getByRole("button", { name: "Add contact", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/crm/contacts/${UUID}$`));
    await expect(page.getByText(`Added Ann Add ${S}.`, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Ann Add ${S}`);
    await expect(page.getByRole("link", { name: ACME.name }).first()).toBeVisible();
  });

  test("Add contact with a deal opens the deal page", async ({ page }) => {
    await signInAdmin(page);
    const dialog = await openAddContact(page);
    await dialog.getByLabel("First name").fill("Dee");
    await dialog.getByLabel("Last name").fill(`Deal ${S}`);
    await dialog.getByLabel("Email").fill(`dee-${S}@s38.test`);
    await dialog.getByRole("checkbox", { name: "Also create a deal" }).click();
    // The deal title follows the typed name until someone edits it.
    await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue(`Dee Deal ${S}`);
    const confirm = dialog.getByRole("button", { name: "Add contact and deal" });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page).toHaveURL(new RegExp(`/crm/deals/${UUID}$`));
    await expect(page.getByText(`Added Dee Deal ${S} with a deal.`, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Dee Deal ${S}`);
  });

  test("a matching lead turns Add contact into the lead step, with Back and Make contact", async ({ page, watch }) => {
    watch.tolerate(/response 409: POST .*\/api\/contacts$/, /Failed to load resource.*409/);
    await signInAdmin(page);
    await importLeads(page.request, [LENA]);
    const [lena] = await sql()`select id from people where lower(email) = ${LENA.email}`;
    expect(lena, "the imported lead").toBeTruthy();

    const dialog = await openAddContact(page);
    await dialog.getByLabel("First name").fill("Typed");
    await dialog.getByLabel("Email").fill(LENA.email);
    await dialog.getByRole("button", { name: "Add contact", exact: true }).click();

    const step = dialog.getByTestId("add-contact-lead");
    await expect(dialog.getByText(`${LENA_NAME} (${LENA.email}) is already a lead.`)).toBeVisible();
    await expect(step).toContainText(`Moves ${LENA_NAME} to Contacts.`);
    await expect(step).toContainText(`${LENA_NAME} cannot go back to Leads or join a campaign again.`);
    await expect(step).toContainText(`MiaSDR keeps ${LENA_NAME}'s saved details and drops what you typed here. Edit them on the contact page.`);
    await expect(step.getByRole("link", { name: "Open lead" })).toHaveAttribute("href", `/leads/${lena.id}`);

    // Back keeps what you typed.
    await dialog.getByRole("button", { name: "Back" }).click();
    await expect(dialog.getByLabel("First name")).toHaveValue("Typed");
    await expect(dialog.getByLabel("Email")).toHaveValue(LENA.email);

    await dialog.getByRole("button", { name: "Add contact", exact: true }).click();
    await dialog.getByRole("button", { name: `Make ${LENA_NAME} a contact` }).click();
    await expect(page).toHaveURL(new RegExp(`/crm/contacts/${lena.id}$`));
    await expect(page.getByText(`${LENA_NAME} is a contact now.`, { exact: true })).toBeVisible();
    // The lead kept its own details.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(LENA_NAME);

    // Now a contact holds the email: the dialog links to her and waits for a change.
    const again = await openAddContact(page);
    await again.getByLabel("Email").fill(LENA.email);
    const confirm = again.getByRole("button", { name: "Add contact", exact: true });
    await confirm.click();
    await expect(again.getByText(`${LENA_NAME} (${LENA.email}) is already a contact.`)).toBeVisible();
    await expect(again.getByRole("link", { name: "Open contact" })).toHaveAttribute("href", `/crm/contacts/${lena.id}`);
    await expect(confirm).toBeDisabled();
    await again.getByLabel("Email").fill(`other-${S}@s38.test`);
    await expect(confirm).toBeEnabled();
  });

  test("Add company adds a new company, lists a company with leads only, and refuses a domain in use", async ({ page }) => {
    await signInAdmin(page);
    await seedUnlistedCompany({ domain: LEADSONLY.domain, name: LEADSONLY.name, leads: [{ email: `lo-${S}@${LEADSONLY.domain}`, fullName: `Lo Lead ${S}` }] });

    // New.
    let dialog = await openAddCompany(page);
    await dialog.getByLabel("Website or domain").fill(NEWCO.domain);
    await expect(dialog.getByLabel("Name")).toHaveAttribute("placeholder", NEWCO.domain);
    await dialog.getByLabel("Name").fill(NEWCO.name);
    await dialog.getByLabel("LinkedIn page").fill(`https://www.linkedin.com/company/newco-${S}`);
    await dialog.getByRole("button", { name: "Add company", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/crm/companies/${UUID}$`));
    await expect(page.getByText(`Added ${NEWCO.name}.`, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(NEWCO.name);

    // Leads only: Add company lists it.
    dialog = await openAddCompany(page);
    await dialog.getByLabel("Website or domain").fill(LEADSONLY.domain);
    await expect(dialog.getByText(`${LEADSONLY.name} has leads and is not in Companies yet. Add company lists it.`)).toBeVisible();
    await expect(dialog.getByLabel("Name")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Add company", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/crm/companies/${UUID}$`));
    await expect(page.getByText(`Added ${LEADSONLY.name} to Companies.`, { exact: true })).toBeVisible();

    // Listed: the domain is in use.
    dialog = await openAddCompany(page);
    await dialog.getByLabel("Website or domain").fill(NEWCO.domain);
    await expect(dialog.getByText(`${NEWCO.name} already uses ${NEWCO.domain}.`)).toBeVisible();
    await expect(dialog.getByRole("link", { name: `Open ${NEWCO.name}` })).toHaveAttribute("href", new RegExp(`/crm/companies/${UUID}$`));
    await expect(dialog.getByRole("button", { name: "Add company", exact: true })).toBeDisabled();

    // Another domain of a company, as a merge leaves it.
    await seedCompanyAlias({ companyDomain: NEWCO.domain, alias: OLDCO, mergedName: `S38 Oldco ${S}` });
    await dialog.getByLabel("Website or domain").fill(OLDCO);
    await expect(dialog.getByText(`${OLDCO} is another domain of ${NEWCO.name}.`)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Add company", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // Both stay in Companies with no contact.
    await page.goto(`/crm/companies?q=${S}`);
    const table = page.getByRole("table");
    await expect(table.getByRole("row").filter({ hasText: NEWCO.name }).getByRole("cell").nth(2)).toHaveText("0");
    await expect(table.getByRole("row").filter({ hasText: LEADSONLY.name }).getByRole("cell").nth(2)).toHaveText("0");
  });
});

test.describe("add contact and companies at 390px in the dark theme", () => {
  test.use(MOBILE_DARK);
  test.setTimeout(120_000);

  test("the Add contact confirm stays on screen with a deal, and the Companies rows carry a phone line", async ({ page }) => {
    await signInAdmin(page);
    await ensureAcme(page);
    const dialog = await openAddContact(page);
    await dialog.getByRole("checkbox", { name: "Also create a deal" }).click();
    await expect(dialog.getByLabel("Expected close (optional)")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Add contact and deal" })).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.goto(`/crm/companies?q=${S}`);
    const acme = page.getByRole("row").filter({ hasText: ACME.name });
    await expect(acme.getByRole("cell").first()).toContainText(ACME.domain);
    // Ann joins Acme in the first test; run alone, this test finds Acme with no contact.
    await expect(acme.getByRole("cell").first()).toContainText(/\d+ contacts? · 0 open deals/);
    await expect(page.getByRole("columnheader", { name: "Domain" })).toBeHidden();
    await expect(page.getByRole("columnheader", { name: "Last activity" })).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });
});
