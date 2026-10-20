import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { MOBILE_DARK, expect, expectNoHorizontalOverflow, seedContact, seedUnlistedCompany, signInAdmin, sql, test, unique, waitForHydrated } from "./support/fixtures";

/*
 * Contact delete, company merge and company delete ("Contacts and Companies CRUD" in docs/decisions.md). The contact
 * page says before any click whether the contact can go; the dialog counts what goes with it and how each channel stays reachable;
 * a delete lands where the contact was opened from. A merge finds a company with leads only, previews and keeps the other domain;
 * a company with people cannot be deleted, an empty one can. Every person and company carries this run's tag.
 */

/** Moves a deal to the pipeline's first lost stage. */
async function loseDeal(request: APIRequestContext, dealId: string) {
  const { stages } = (await (await request.get("/api/deal-stages")).json()) as { stages: Array<{ id: string | null; kind: string }> };
  const lost = stages.find((s) => s.kind === "lost");
  const deal = (await (await request.get(`/api/deals/${dealId}`)).json()) as { version: number };
  const res = await request.post(`/api/deals/${dealId}/stage`, { data: { stageId: lost!.id, expectedVersion: deal.version, lostReason: "Went quiet" } });
  expect(res.status(), "mark the deal lost").toBe(200);
}

async function openDeleteDialog(page: Page): Promise<Locator> {
  const button = page.getByTestId("contact-delete").getByRole("button", { name: "Delete contact" });
  await waitForHydrated(button);
  await button.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("contact-delete-body")).toBeVisible();
  return dialog;
}

async function expectInViewport(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box, "the element has a box").not.toBeNull();
  expect(box!.y + box!.height, "the element ends inside the viewport").toBeLessThanOrEqual(viewport.height);
  expect(box!.y, "the element starts inside the viewport").toBeGreaterThanOrEqual(0);
}

test.describe("contact delete", () => {
  test("an open deal blocks the delete; once closed, the dialog counts what goes and the delete returns to Contacts", async ({ page }) => {
    await signInAdmin(page);
    const tag = unique("s41c");
    const name = `S41 Cleo ${tag}`;
    const email = `cleo@${tag}.test`;
    const open = `S41 Open ${tag}`;
    const { personId, deals } = await seedContact(page.request, {
      firstName: "S41 Cleo",
      lastName: tag,
      email,
      history: { notes: 1, tasks: 2, open: [open], won: [`S41 Won ${tag}`], lost: [`S41 Lost ${tag}`] },
    });

    await page.goto(`/crm/contacts/${personId}`);
    const row = page.getByTestId("contact-delete");
    await expect(row.getByTestId("contact-delete-state")).toHaveText("This contact cannot be deleted.");
    await expect(row).toContainText(`${name} has 1 open deal. Close or delete them first.`);
    await expect(row.getByRole("link", { name: `${open}, New` })).toHaveAttribute("href", new RegExp(`^/crm/deals/${deals.open[0]}\\?from=%2Fcrm%2Fcontacts%2F${personId}$`));
    await expect(row.getByRole("button", { name: "Delete contact" })).toHaveCount(0);

    await loseDeal(page.request, deals.open[0]);
    await page.reload();
    await expect(row.getByTestId("contact-delete-state")).toHaveText("This contact can be deleted.");
    let dialog = await openDeleteDialog(page);
    await expect(dialog.getByRole("heading", { name: `Delete ${name}?` })).toBeVisible();
    await expect(dialog).toContainText(`This deletes ${name} and cannot be undone.`);
    await expect(dialog).toContainText("It also deletes:");
    const counts = dialog.getByTestId("contact-delete-counts").getByRole("listitem");
    await expect(counts.nth(0)).toHaveText(`1 won deal and 2 lost deals. They leave the Pipeline and its totals. Won: S41 Won ${tag}.`);
    await expect(counts.nth(1)).toHaveText("1 note");
    await expect(counts.nth(2)).toHaveText("2 tasks");
    await expect(counts.nth(3)).toHaveText(/^\d+ history lines$/);
    await expect(counts).toHaveCount(4);
    const reach = dialog.getByTestId("contact-delete-reach");
    await expect(reach).toContainText(`Deleting does not block ${email}. A later import can add ${name} to a campaign. To stop outreach, mark them do not contact instead.`);
    await expect(reach).toContainText(`A re-import, a table handoff or a new message brings ${name} back as a lead.`);
    await expect(dialog.getByRole("button", { name: "Keep contact" })).toBeVisible();

    // "mark them do not contact" closes the dialog and opens the control with the Reason field focused.
    await reach.getByRole("button", { name: "mark them do not contact" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("person-stop").getByLabel("Reason")).toBeFocused();
    await page.getByTestId("person-stop").getByRole("button", { name: "Cancel" }).click();

    dialog = await openDeleteDialog(page);
    await dialog.getByRole("button", { name: "Delete contact" }).click();
    await expect(page).toHaveURL(/\/crm\/contacts$/);
    await expect(page.getByText(`Deleted ${name}.`)).toBeVisible();
    const [left] = await sql()`select count(*)::int as n from people where id = ${personId}`;
    expect(left.n, "the person is gone").toBe(0);
  });

  test("a marked contact keeps its email suppressed, and a delete from a company page returns there", async ({ page }) => {
    await signInAdmin(page);
    const tag = unique("s41s");
    const domain = `${tag}-sol.test`;
    const company = `S41 Sol ${tag}`;
    const email = `sam@${domain}`;
    const { personId } = await seedContact(page.request, { firstName: "S41 Sam", lastName: tag, email, companyDomain: domain, companyName: company });
    const marked = await page.request.post(`/api/crm/people/${personId}/dnc`, { data: { enabled: true, reason: "Asked to stop" } });
    expect(marked.status(), "mark do not contact").toBe(200);
    const [row] = await sql()`select id from companies where domain = ${domain}`;
    const companyId = row.id as string;

    await page.goto(`/crm/companies/${companyId}`);
    await page.getByTestId("company-contacts").getByRole("link", { name: `S41 Sam ${tag}` }).click();
    await expect(page).toHaveURL(new RegExp(`/crm/contacts/${personId}\\?from=%2Fcrm%2Fcompanies%2F${companyId}$`));
    const dialog = await openDeleteDialog(page);
    await expect(dialog.getByTestId("contact-delete-reach")).toContainText(`${email} stays Email suppressed.`);
    await expect(dialog.getByTestId("contact-delete-reach")).not.toContainText("Deleting does not block");
    await dialog.getByRole("button", { name: "Delete contact" }).click();

    await expect(page).toHaveURL(new RegExp(`/crm/companies/${companyId}$`));
    await expect(page.getByText(`Deleted S41 Sam ${tag}.`)).toBeVisible();

    // The company keeps its place with no contacts, and Add contact leads the header.
    const contacts = page.getByTestId("company-contacts");
    await expect(contacts).toContainText(`No contacts at ${company}`);
    await expect(contacts).toContainText(`${company} stays in Companies until you delete it or merge it into another company.`);
    await expect(contacts.getByRole("link", { name: "Find its leads" })).toHaveAttribute("href", `/leads?q=${encodeURIComponent(domain)}`);
    const add = page.getByTestId("company-header").getByRole("button", { name: "Add contact" });
    await waitForHydrated(add);
    await add.click();
    await expect(page.getByRole("dialog").getByLabel("Website or domain")).toHaveValue(domain);
  });
});

test.describe("company merge and delete", () => {
  test("merges a company with leads only into this one and keeps its domain as another domain", async ({ page }) => {
    await signInAdmin(page);
    const tag = unique("s41m");
    const keptDomain = `${tag}-kept.test`;
    const otherDomain = `${tag}-other.test`;
    const kept = `S41 Kept ${tag}`;
    const other = `S41 Other ${tag}`;
    await seedContact(page.request, { firstName: "S41 Kim", lastName: tag, email: `kim@${keptDomain}`, companyDomain: keptDomain, companyName: kept });
    await seedUnlistedCompany({ domain: otherDomain, name: other, leads: [{ email: `lou@${otherDomain}`, fullName: `S41 Lou ${tag}` }] });
    const [row] = await sql()`select id from companies where domain = ${keptDomain}`;

    await page.goto(`/crm/companies/${row.id}`);
    const more = page.getByRole("button", { name: `More actions for ${kept}` });
    await waitForHydrated(more);
    await more.click();
    await page.getByRole("menuitem", { name: "Merge with another company" }).click();
    const dialog = page.getByRole("dialog", { name: `Merge ${kept} with another company` });
    await expect(dialog.getByRole("button", { name: "Preview merge" })).toBeDisabled();

    await dialog.getByLabel("Company to merge").fill(`nobody-${tag}`);
    await dialog.getByRole("button", { name: "Search" }).click();
    await expect(dialog).toContainText(`No company matches "nobody-${tag}". Try a domain.`);

    await dialog.getByLabel("Company to merge").fill(tag);
    await dialog.getByRole("button", { name: "Search" }).click();
    const match = dialog.getByRole("list", { name: "Matching companies" }).getByRole("listitem");
    await expect(match).toHaveCount(1);
    await expect(match).toContainText("Leads only");
    await match.getByRole("radio").check();
    const keep = dialog.getByRole("group", { name: "Company to keep" });
    await expect(keep.getByRole("radio", { name: `${kept} (${keptDomain}), 1 contact` })).toBeChecked();
    await expect(keep.getByRole("radio", { name: `${other} (${otherDomain}), 0 contacts` })).not.toBeChecked();
    await dialog.getByRole("button", { name: "Preview merge" }).click();

    const preview = dialog.getByTestId("merge-preview");
    await expect(preview.getByText(`${other} (${otherDomain}) merges into ${kept} (${keptDomain}).`)).toBeFocused();
    await expect(preview).toContainText(`1 lead moves to ${kept}.`);
    await expect(preview).toContainText(`${otherDomain} becomes another domain of ${kept}. Imports and person forms with ${otherDomain} attach people to ${kept}.`);
    await expect(preview).toContainText("This cannot be undone.");

    // Back keeps the choice.
    await dialog.getByRole("button", { name: "Back" }).click();
    await expect(keep.getByRole("radio", { name: `${kept} (${keptDomain}), 1 contact` })).toBeChecked();
    await dialog.getByRole("button", { name: "Preview merge" }).click();
    await dialog.getByRole("button", { name: "Merge companies" }).click();

    await expect(page.getByText(`Merged ${other} into ${kept}.`)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/crm/companies/${row.id}$`));
    await expect(page.getByTestId("company-other-domains")).toHaveText(`${otherDomain} (was ${other})`);
    const [moved] = await sql()`select count(*)::int as n from people where company_id = ${row.id}`;
    expect(moved.n, "Kim and Lou share the kept company").toBe(2);
  });

  test("a company with people cannot be deleted, an empty one can", async ({ page }) => {
    await signInAdmin(page);
    const tag = unique("s41d");
    const busyDomain = `${tag}-busy.test`;
    const busy = `S41 Busy ${tag}`;
    await seedContact(page.request, { firstName: "S41 Bea", lastName: tag, email: `bea@${busyDomain}`, companyDomain: busyDomain, companyName: busy });
    const [busyRow] = await sql()`select id from companies where domain = ${busyDomain}`;
    await sql()`insert into people (organization_id, email, full_name, company_id, source) select organization_id, ${`ben@${busyDomain}`}, ${`S41 Ben ${tag}`}, id, 'manual' from companies where id = ${busyRow.id}`;

    await page.goto(`/crm/companies/${busyRow.id}`);
    let more = page.getByRole("button", { name: `More actions for ${busy}` });
    await waitForHydrated(more);
    await more.click();
    await page.getByRole("menuitem", { name: "Delete company" }).click();
    let dialog = page.getByRole("dialog", { name: `Delete ${busy}?` });
    await expect(dialog).toContainText(`${busy} still has 1 contact and 1 lead. Merge it into another company, or move those people first.`);
    await expect(dialog.getByRole("link", { name: "Find its leads" })).toHaveAttribute("href", `/leads?q=${encodeURIComponent(busyDomain)}`);
    await expect(dialog.getByRole("button", { name: "Delete company" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close" }).first().click();
    await expect(dialog).toHaveCount(0);

    const emptyDomain = `${tag}-empty.test`;
    const empty = `S41 Empty ${tag}`;
    const added = await page.request.post("/api/companies", { data: { domain: emptyDomain, name: empty } });
    expect(added.status(), "add the empty company").toBe(201);
    const { companyId } = (await added.json()) as { companyId: string };
    await page.goto(`/crm/companies/${companyId}`);
    more = page.getByRole("button", { name: `More actions for ${empty}` });
    await waitForHydrated(more);
    await more.click();
    await page.getByRole("menuitem", { name: "Delete company" }).click();
    dialog = page.getByRole("dialog", { name: `Delete ${empty}?` });
    await expect(dialog).toContainText(
      `${empty} has no contacts or leads. Deleting it removes its details, its custom field values and its other domains. Imports with ${emptyDomain} or its other domains create a new company. This cannot be undone.`,
    );
    await expect(dialog.getByRole("button", { name: "Keep company" })).toBeVisible();
    await dialog.getByRole("button", { name: "Delete company" }).click();
    await expect(page).toHaveURL(/\/crm\/companies$/);
    await expect(page.getByText(`Deleted ${empty}.`)).toBeVisible();
    const [gone] = await sql()`select count(*)::int as n from companies where id = ${companyId}`;
    expect(gone.n).toBe(0);
  });
});

test.describe("delete and merge at 390px in the dark theme", () => {
  test.use(MOBILE_DARK);

  test("the dialogs keep their confirm on screen and the pages do not scroll sideways", async ({ page }) => {
    await signInAdmin(page);
    const tag = unique("s41p");
    const domain = `${tag}-phone.test`;
    const company = `S41 Phone ${tag}`;
    const { personId } = await seedContact(page.request, { firstName: "S41 Pia", lastName: tag, email: `pia@${domain}`, companyDomain: domain, companyName: company, history: { notes: 2, tasks: 1, won: [`S41 Won ${tag}`] } });
    const otherDomain = `${tag}-twin.test`;
    await seedUnlistedCompany({ domain: otherDomain, name: `S41 Twin ${tag}`, leads: [{ email: `tom@${otherDomain}`, fullName: `S41 Tom ${tag}` }] });
    const [row] = await sql()`select id from companies where domain = ${domain}`;

    await page.goto(`/crm/contacts/${personId}`);
    await expect(page.getByTestId("contact-delete")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const dialog = await openDeleteDialog(page);
    await expectInViewport(page, dialog.getByRole("button", { name: "Delete contact" }));
    await dialog.getByRole("button", { name: "Keep contact" }).click();

    await page.goto(`/crm/companies/${row.id}`);
    await expect(page.getByTestId("company-header")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const more = page.getByRole("button", { name: `More actions for ${company}` });
    await waitForHydrated(more);
    await more.click();
    await page.getByRole("menuitem", { name: "Merge with another company" }).click();
    const merge = page.getByRole("dialog");
    await merge.getByLabel("Company to merge").fill(otherDomain);
    await merge.getByRole("button", { name: "Search" }).click();
    await merge.getByRole("list", { name: "Matching companies" }).getByRole("radio").check();
    await merge.getByRole("button", { name: "Preview merge" }).click();
    await expect(merge.getByTestId("merge-preview")).toBeVisible();
    await expectInViewport(page, merge.getByRole("button", { name: "Merge companies" }));
    await expectNoHorizontalOverflow(page);
  });
});
