import type { Page } from "@playwright/test";
import { e2eOrganizationId, expect, seedContact, signInAdmin, sql, test, unique, waitForHydrated } from "./support/fixtures";

/*
 * The person form's company group and the conversion dialogs ("Contacts and Companies CRUD" in docs/decisions.md).
 * The form shows an existing company as a link and asks before a move, Keep saves the other edits; Make contact on the lead
 * page; the bulk Create deals asks a second time above 50 leads, with Back; a deal deleted from a contact page returns there.
 * Every person and company here carries this run's tag.
 */

async function companyOf(personId: string): Promise<{ domain: string | null; name: string | null }> {
  const [row] = await sql()`select c.domain, c.name from people p left join companies c on c.id = p.company_id where p.id = ${personId}`;
  return { domain: (row?.domain as string | null) ?? null, name: (row?.name as string | null) ?? null };
}

async function openEditForm(page: Page) {
  const details = page.getByTestId("person-details");
  await waitForHydrated(details.getByRole("button", { name: "Edit" }));
  await details.getByRole("button", { name: "Edit" }).click();
  return details.getByTestId("lead-form-company");
}

test.describe("person form company", () => {
  test("shows the company as a link, asks before a move, and Keep saves the other edits", async ({ page }) => {
    await signInAdmin(page);
    const tag = unique("s40");
    const acme = `${tag}-acme.test`;
    const globex = `${tag}-globex.test`;
    const name = `S40 Mona ${tag}`;
    const { personId } = await seedContact(page.request, { firstName: "S40 Mona", lastName: tag, email: `mona@${acme}`, companyDomain: acme, companyName: `S40 Acme ${tag}` });
    // Another contact holds the second domain, so the move lands on an existing company.
    await seedContact(page.request, { firstName: "S40 Gus", lastName: tag, email: `gus@${globex}`, companyDomain: globex, companyName: `S40 Globex ${tag}` });
    const [acmeRow] = await sql()`select id from companies where domain = ${acme}`;

    await page.goto(`/crm/contacts/${personId}`);
    const company = await openEditForm(page);
    // An existing company reads as a link to its page; the form has no name field for it.
    await expect(company.getByRole("link", { name: `S40 Acme ${tag}` })).toHaveAttribute("href", `/crm/companies/${acmeRow.id}`);
    await expect(company).toContainText(`(${acme})`);
    await expect(company.getByText("Rename the company on its page.")).toBeVisible();
    await expect(company.getByLabel("Company name", { exact: true })).toHaveCount(0);

    // Change company: a new domain asks for the name, a known one joins its company and hides the name field.
    await company.getByRole("button", { name: "Change company" }).click();
    const domain = company.getByLabel("Website or domain");
    await domain.fill(`${tag}-new.test`);
    await expect(company.getByLabel("Company name", { exact: true })).toBeVisible();
    await expect(company.getByText("Names the company when the domain is new.")).toBeVisible();
    await domain.fill(globex);
    await expect(company.getByTestId("company-join")).toContainText(`Joins S40 Globex ${tag} (${globex}).`);
    await expect(company.getByLabel("Company name", { exact: true })).toHaveCount(0);

    // Save asks first. Keep restores the old company and saves the job title.
    await page.getByLabel("Job title").fill("S40 Buyer");
    await page.getByRole("button", { name: "Save changes" }).click();
    const move = page.getByRole("dialog", { name: `Move ${name} to S40 Globex ${tag}?` });
    await expect(move).toContainText(`${name} leaves S40 Acme ${tag}.`);
    await move.getByRole("button", { name: `Keep S40 Acme ${tag}` }).click();
    await expect(move).toBeHidden();
    await expect(page.getByText("Contact saved.")).toBeVisible();
    await expect(page.getByTestId("person-details")).toContainText("S40 Buyer");
    expect(await companyOf(personId)).toEqual({ domain: acme, name: `S40 Acme ${tag}` });

    // Move goes through, and the form sends no name for the existing company, so its name stays.
    const again = await openEditForm(page);
    await again.getByRole("button", { name: "Change company" }).click();
    await again.getByLabel("Website or domain").fill(globex);
    await expect(again.getByTestId("company-join")).toBeVisible();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("dialog", { name: `Move ${name} to S40 Globex ${tag}?` }).getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.getByText("Contact saved.").first()).toBeVisible();
    await expect.poll(() => companyOf(personId)).toEqual({ domain: globex, name: `S40 Globex ${tag}` });

    // Remove company asks with its own title.
    const third = await openEditForm(page);
    await third.getByRole("button", { name: "Remove company" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    const remove = page.getByRole("dialog", { name: `Remove ${name} from S40 Globex ${tag}?` });
    await remove.getByRole("button", { name: "Remove", exact: true }).click();
    await expect.poll(() => companyOf(personId)).toEqual({ domain: null, name: null });
  });
});

test.describe("conversion dialogs", () => {
  test("Make contact on the lead page states the permanence and opens the contact", async ({ page }) => {
    await signInAdmin(page);
    const tag = unique("s40m");
    const name = `S40 Lead ${tag}`;
    const [row] = await sql()`insert into people (organization_id, email, full_name, source) values (${await e2eOrganizationId()}, ${`${tag}@s40.test`}, ${name}, 'manual') returning id`;
    const id = row.id as string;

    await page.goto(`/leads/${id}`);
    const header = page.getByTestId("lead-header");
    // Create deal names the permanence too.
    const create = header.getByRole("button", { name: "Create deal" });
    await waitForHydrated(create);
    await create.click();
    const deal = page.getByRole("dialog", { name: `Create deal for ${name}` });
    await expect(deal).toContainText(`${name} cannot go back to Leads or join a campaign again, even if you delete the deal.`);
    await deal.getByRole("button", { name: "Cancel" }).click();

    await header.getByRole("button", { name: "Make contact" }).click();
    const dialog = page.getByRole("dialog", { name: `Make ${name} a contact?` });
    await expect(dialog).toContainText(`Moves ${name} to Contacts.`);
    await expect(dialog).toContainText(`${name} cannot go back to Leads or join a campaign again.`);
    await dialog.getByRole("button", { name: "Make contact" }).click();
    await expect(page).toHaveURL(new RegExp(`/crm/contacts/${id}$`));
    await expect(page.getByText(`${name} is a contact now.`)).toBeVisible();
    const [person] = await sql()`select lifecycle from people where id = ${id}`;
    expect(person.lifecycle).toBe("contact");
    const [event] = await sql()`select meta->>'reason' as reason from events where person_id = ${id} and event_type = 'lifecycle.converted'`;
    expect(event.reason).toBe("added");
  });

  test("bulk Create deals asks a second time above 50 leads, and Back returns to the form", async ({ page }) => {
    test.setTimeout(120_000);
    await signInAdmin(page);
    const tag = unique("s40b");
    await sql()`
      insert into people (organization_id, email, full_name, source)
      select ${await e2eOrganizationId()}, ${tag} || '-' || n || '@s40.test', ${tag} || ' Person ' || lpad(n::text, 2, '0'), 'manual'
      from generate_series(1, 51) n`;

    // Show contacts too, so the rows and the dialog stay after the leads convert.
    await page.goto(`/leads?q=${tag}&lifecycle=all`);
    const selectAll = page.getByLabel("Select all leads on this page");
    await waitForHydrated(selectAll);
    await selectAll.click();
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Select all 51 matching" }).click();
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Create deals" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("These 51 people cannot go back to Leads or join a campaign again, even if you delete their deals.");
    await dialog.getByRole("button", { name: "Create deals" }).click();
    await expect(dialog).toContainText("Make 51 leads contacts for good?");
    await expect(dialog).toContainText("These 51 leads cannot go back to Leads or join a campaign again. Deleting their deals later does not bring them back.");
    await expect(dialog).toContainText("This cannot be undone.");
    const [{ before }] = await sql()`select count(*)::int as before from people where full_name like ${`${tag} %`} and lifecycle = 'contact'`;
    expect(before, "nothing converts before the second confirm").toBe(0);

    await dialog.getByRole("button", { name: "Back" }).click();
    await expect(dialog.getByRole("button", { name: "Create deals" })).toBeVisible();
    await expect(dialog.getByLabel("Stage")).toBeVisible();
    await dialog.getByRole("button", { name: "Create deals" }).click();
    await dialog.getByRole("button", { name: "Create 51 deals" }).click();
    await expect(dialog.getByRole("status")).toHaveText("Created 51 deals.", { timeout: 60_000 });
  });

  test("a deal deleted from a contact page returns to that contact page", async ({ page }) => {
    await signInAdmin(page);
    const tag = unique("s40d");
    const title = `S40 Deal ${tag}`;
    const { personId, deals } = await seedContact(page.request, { firstName: "S40 Dee", lastName: tag, email: `dee@${tag}.test`, history: { open: [title] } });

    await page.goto(`/crm/contacts/${personId}`);
    await page.getByTestId("contact-deals").getByRole("link", { name: title }).click();
    await expect(page).toHaveURL(new RegExp(`/crm/deals/${deals.open[0]}\\?from=%2Fcrm%2Fcontacts%2F${personId}$`));
    await expect(page.getByRole("link", { name: "Back to Contact" })).toHaveAttribute("href", `/crm/contacts/${personId}`);

    const more = page.getByRole("button", { name: `More actions for ${title}` });
    await waitForHydrated(more);
    await more.click();
    await page.getByRole("menuitem", { name: "Delete deal" }).click();
    await page.getByRole("dialog", { name: `Delete ${title}?` }).getByRole("button", { name: "Delete deal" }).click();
    await expect(page).toHaveURL(new RegExp(`/crm/contacts/${personId}$`));
    await expect(page.getByText(`Deleted ${title}.`)).toBeVisible();
  });
});
