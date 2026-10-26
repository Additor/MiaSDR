import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { MOBILE_DARK, expect, expectNoHorizontalOverflow, openFilters, seedContact, signInAdmin, test, unique, waitForHydrated } from "./support/fixtures";

/**
 * The Contacts list ("Contacts and Companies CRUD" in docs/decisions.md): Export CSV in the toolbar, the selection bar with Export selected,
 * bulk Mark do not contact with a reason and its report, Select all matching, Esc, the Deal owner column and the phone line.
 * Seeds four contacts through Add contact under a unique key; Ada has an open deal and a company.
 */
const KEY = unique("s39");
const SUFFIX = KEY.slice(4);
const NAMES = ["Ada", "Bo", "Cy", "Di"].map((first) => ({ firstName: first, lastName: `S39 ${SUFFIX}`, email: `${first.toLowerCase()}-${SUFFIX}@s39.test` }));
const fullName = (n: (typeof NAMES)[number]) => `${n.firstName} ${n.lastName}`;
const COMPANY = `S39 Lumen ${SUFFIX}`;
const LIST = `/crm/contacts?q=${SUFFIX}`;

let seeded: string[] | null = null;

async function seed(page: Page): Promise<string[]> {
  if (seeded) return seeded;
  const ids: string[] = [];
  for (const [index, person] of NAMES.entries()) {
    const extra = index === 0 ? { companyDomain: `lumen-${SUFFIX}.test`, companyName: COMPANY, history: { open: [`S39 Deal ${SUFFIX}`] } } : {};
    ids.push((await seedContact(page.request, { ...person, ...extra })).personId);
  }
  seeded = ids;
  return ids;
}

const bar = (page: Page) => page.getByTestId("selection-bar");

async function openList(page: Page) {
  await page.goto(LIST);
  await waitForHydrated(page.getByLabel("Select all contacts on this page"));
}

test.describe("contacts list bulk actions", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test("Export CSV sits in the toolbar and exports the filtered list; with no match it says why it is off", async ({ page }) => {
    await signInAdmin(page);
    await seed(page);
    await openList(page);
    const link = page.getByRole("link", { name: "Export filtered CSV" });
    await expect(link).toHaveAttribute("href", `/api/contacts/export?q=${SUFFIX}`);
    const csv = await (await page.request.get(`/api/contacts/export?q=${SUFFIX}`)).text();
    expect(csv.split("\n")[0]).toContain("Name,Email,Phone,LinkedIn,Job title,Company,Company domain,Deal owner,Latest deal,Stage");
    for (const person of NAMES) expect(csv).toContain(person.email);

    await page.goto(`/crm/contacts?q=nobody-${SUFFIX}`);
    const off = page.getByRole("button", { name: "Export filtered CSV" });
    await expect(off).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("No contacts match, so there is nothing to export.")).toBeVisible();
  });

  test("Deal owner names the latest deal's owner, and rows link with the list they came from", async ({ page }) => {
    await signInAdmin(page);
    const ids = await seed(page);
    await openList(page);
    await openFilters(page);
    await expect(page.getByLabel("Deal owner", { exact: true })).toHaveValue("");
    await page.keyboard.press("Escape");
    const header = page.getByRole("columnheader", { name: /Deal owner/ });
    await expect(header).toContainText("Owner of the latest deal");
    await header.locator("[tabindex=\"0\"]").hover();
    await expect(page.locator('[data-slot="tooltip-content"]')).toContainText("Owner of the latest deal");
    const ada = page.getByRole("row").filter({ hasText: fullName(NAMES[0]) });
    await expect(ada.getByRole("link", { name: fullName(NAMES[0]) })).toHaveAttribute("href", `/crm/contacts/${ids[0]}?from=${encodeURIComponent(LIST)}`);
  });

  test("ticking rows shows the bar in order; Export selected saves those rows; Esc clears", async ({ page }) => {
    await signInAdmin(page);
    await seed(page);
    await openList(page);
    await expect(bar(page).getByRole("button")).toHaveCount(0);
    await page.getByLabel(`Select ${fullName(NAMES[0])}`, { exact: true }).click();
    await page.getByLabel(`Select ${fullName(NAMES[1])}`, { exact: true }).click();
    await expect(bar(page).getByRole("status")).toHaveText("2 selected.");
    await expect(bar(page).getByRole("button")).toHaveText(["Export selected", "Mark do not contact", "Clear selection", "More actions"]);

    const download = page.waitForEvent("download");
    await bar(page).getByRole("button", { name: "Export selected" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^contacts-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = await readFile((await file.path())!, "utf8");
    expect(csv).toContain(NAMES[0].email);
    expect(csv).toContain(NAMES[1].email);
    expect(csv).not.toContain(NAMES[2].email);

    await page.getByLabel(`Select ${fullName(NAMES[0])}`, { exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(bar(page).getByRole("button", { name: "Clear selection" })).toHaveCount(0);
    await expect(page.getByLabel(`Select ${fullName(NAMES[0])}`, { exact: true })).not.toBeChecked();
  });

  test("Select all matching, then Mark do not contact asks for a reason and reports what it marked", async ({ page }) => {
    await signInAdmin(page);
    await seed(page);
    await openList(page);
    await page.getByLabel(`Select ${fullName(NAMES[3])}`, { exact: true }).click();
    await bar(page).getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Select all 4 matching" }).click();
    await expect(bar(page).getByRole("status")).toHaveText("4 selected.");
    await expect(bar(page).getByRole("button", { name: "More actions" })).toHaveCount(0);

    await bar(page).getByRole("button", { name: "Mark do not contact" }).click();
    const dialog = page.getByRole("dialog", { name: "Mark 4 people do not contact?" });
    await expect(dialog).toContainText("Stops every channel, ends their campaign enrollments and retires open drafts.");
    await expect(dialog.getByLabel("Reason")).toHaveAttribute("placeholder", "Asked to stop, competitor, wrong person");
    await dialog.getByRole("button", { name: "Mark do not contact" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Type a reason to mark this person do not contact.");
    await dialog.getByLabel("Reason").fill("Asked to stop");
    await dialog.getByRole("button", { name: "Mark do not contact" }).click();
    await expect(dialog.getByTestId("bulk-dnc-report")).toHaveText("Marked 4.");
    await expect(dialog.getByRole("button", { name: "Mark do not contact" })).toBeDisabled();
    await dialog.locator("[data-slot=dialog-footer]").getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect(bar(page).getByRole("button", { name: "Clear selection" })).toHaveCount(0);
    // The list refreshed: every row shows the do not contact mark.
    await expect(page.getByTestId("reach-dnc")).toHaveCount(4);

    // A second pass skips the people already marked and says so.
    await page.getByLabel(`Select ${fullName(NAMES[2])}`, { exact: true }).click();
    await bar(page).getByRole("button", { name: "Mark do not contact" }).click();
    const again = page.getByRole("dialog", { name: "Mark 1 person do not contact?" });
    await again.getByLabel("Reason").fill("Asked to stop");
    await again.getByRole("button", { name: "Mark do not contact" }).click();
    await expect(again.getByTestId("bulk-dnc-report")).toHaveText("Marked 0. Skipped 1: 1 already marked.");
    await again.locator("[data-slot=dialog-footer]").getByRole("button", { name: "Close" }).click();
  });

});

test.describe("contacts list at 390px in the dark theme", () => {
  test.use(MOBILE_DARK);
  test.setTimeout(120_000);

  test("the phone line stands in for the hidden columns, 44px bar targets, no sideways scroll", async ({ page }) => {
    await signInAdmin(page);
    await seed(page);
    await openList(page);
    const ada = page.getByRole("row").filter({ hasText: fullName(NAMES[0]) });
    const line = ada.getByTestId("contact-phone-line");
    await expect(line).toBeVisible();
    await expect(line).toContainText(`${COMPANY} · `);
    for (const name of ["Email", "Company", "Latest deal", "Last activity"]) await expect(page.getByRole("columnheader", { name, exact: true })).toBeHidden();
    await expect(page.getByRole("columnheader", { name: /Deal owner/ })).toBeHidden();
    await expect(page.getByRole("columnheader", { name: "Open deals" })).toBeVisible();

    await page.getByLabel(`Select ${fullName(NAMES[0])}`, { exact: true }).click();
    for (const name of ["Export selected", "Mark do not contact", "Clear selection", "More actions"]) {
      const box = await bar(page).getByRole("button", { name }).boundingBox();
      expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(44);
      expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(44);
    }
    const barBox = await bar(page).boundingBox();
    expect(barBox!.y + barBox!.height, "the bar ends inside the viewport").toBeLessThanOrEqual(844);
    await expectNoHorizontalOverflow(page);
  });
});
