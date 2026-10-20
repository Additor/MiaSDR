import type { Locator, Page } from "@playwright/test";
import { e2eOrganizationId, expect, signInAdmin, sql, test, unique, waitForHydrated } from "./support/fixtures";

/**
 * The lead list's selection bar: Add to campaign leads, Create deals and the deletes sit in the More actions menu, the bar sticks to the
 * bottom of the viewport without moving the table, Esc clears the selection, and the targets and the destructive
 * button hold up at 390px and in the dark theme. Seeds 60 leads named "S33 Lead NN".
 */
async function seed() {
  const db = sql();
  const org = { id: await e2eOrganizationId() };
  await db`delete from people where organization_id = ${org.id} and full_name like 'S33 Lead %'`;
  await db`
    insert into people (organization_id, email, full_name, title, source, created_at, updated_at)
    select ${org.id}, 's33-' || n || '@s33.test', 'S33 Lead ' || lpad(n::text, 2, '0'), 'Engineer', 'manual',
      timestamptz '2024-03-01 10:00:00+00' + (n || ' minutes')::interval, timestamptz '2024-03-01 10:00:00+00' + (n || ' minutes')::interval
    from generate_series(1, 60) n`;
}

const bar = (page: Page) => page.getByTestId("selection-bar");
const rowBox = (page: Page, name: string) => page.getByRole("row").filter({ has: page.getByLabel(`Select ${name}`, { exact: true }) }).boundingBox();

async function pickRow(page: Page, name: string) {
  const box = page.getByLabel(name, { exact: true });
  await box.scrollIntoViewIfNeeded();
  await box.click();
}

/** Contrast of an element's text against the background layers behind it. oklch tokens resolve through a canvas pixel. */
async function contrastOf(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const rgba = (css: string): [number, number, number, number] => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    // Layers from the element up to the root, composited over the page background.
    const layers: Array<[number, number, number, number]> = [];
    for (let node: Element | null = el; node; node = node.parentElement) layers.push(rgba(getComputedStyle(node).backgroundColor));
    let bg: [number, number, number] = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse()) bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
    const text = rgba(getComputedStyle(el).color);
    const [hi, lo] = [lum(text), lum(bg)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  });
}

test.describe("lead list selection bar", () => {
  test("Add to campaign leads, deletes live in the menu, the bar sticks without moving the table", async ({ page }) => {
    await signInAdmin(page);
    await seed();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto("/leads?q=S33+Lead");
    await expect(page.getByText("60 leads, page 1 of 2")).toBeVisible();
    await waitForHydrated(page.getByLabel("Select all leads on this page"));

    // Ticking the first row does not move the table.
    const before = await rowBox(page, "S33 Lead 60");
    await pickRow(page, "Select S33 Lead 60");
    await expect(page.getByRole("status").filter({ hasText: "1 selected" })).toBeVisible();
    const after = await rowBox(page, "S33 Lead 60");
    expect(after?.y).toBe(before?.y);

    // Order, weight and count. Add to campaign is first and solid; no delete control in the bar; at most 4 controls.
    const controls = bar(page).locator("button, a[href]");
    await expect(controls.first()).toHaveText("Add to campaign");
    expect(await controls.count()).toBeLessThanOrEqual(4);
    await expect(controls).toHaveText(["Add to campaign", "Export selected", "Clear selection", "More actions"]);
    expect(await controls.first().evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await expect(bar(page).getByRole("button", { name: /Delete/ })).toHaveCount(0);

    // Sticky: after ticking a row far down the page (pickRow scrolls to it), the bar stays in the viewport.
    await pickRow(page, "Select S33 Lead 15");
    await expect(page.getByRole("status").filter({ hasText: "2 selected" })).toBeVisible();
    const box = await bar(page).boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(720);
    expect(box!.y + box!.height).toBeGreaterThan(700);

    // The menu lists the select-all item first, then Create deals, and the destructive items last, after a separator.
    await page.getByRole("button", { name: "More actions" }).click();
    const items = page.getByRole("menuitem");
    await expect(items).toHaveText([/^Select all 60 matching$/, "Create deals", "Delete selected", /^Delete all 60 matching$/]);
    await expect(page.getByRole("separator")).toHaveCount(1);

    // Delete selected asks first, with the count, and Cancel keeps both leads.
    await page.getByRole("menuitem", { name: "Delete selected" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Delete 2 selected leads?" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("60 leads, page 1 of 2")).toBeVisible();

    // Delete all matching names the count too.
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: /Delete all 60 matching/ }).click();
    await expect(dialog.getByRole("heading", { name: "Delete 60 matching leads?" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // Confirming Delete selected removes the two leads.
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Delete selected" }).click();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("58 leads, page 1 of 2")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "selected" })).toHaveCount(0);
  });

  test("Esc in the table clears the selection", async ({ page }) => {
    await signInAdmin(page);
    await seed();
    await page.goto("/leads?q=S33+Lead");
    await waitForHydrated(page.getByLabel("Select all leads on this page"));
    await pickRow(page, "Select S33 Lead 59");
    await expect(page.getByRole("status").filter({ hasText: "1 selected" })).toBeVisible();
    await page.getByLabel("Select S33 Lead 59", { exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(bar(page).getByRole("button", { name: "Clear selection" })).toHaveCount(0);
    await expect(page.getByLabel("Select S33 Lead 59", { exact: true })).not.toBeChecked();
  });

  test("390px: 44px targets in the thumb zone, and the destructive button holds contrast in both themes", async ({ page }) => {
    await signInAdmin(page);
    await seed();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/leads?q=S33+Lead");
    await waitForHydrated(page.getByLabel("Select all leads on this page"));
    await pickRow(page, "Select S33 Lead 58");
    await expect(page.getByRole("status").filter({ hasText: "1 selected" })).toBeVisible();

    for (const name of ["Add to campaign", "Export selected", "Clear selection", "More actions"]) {
      const target = bar(page).getByRole(name === "Export selected" ? "link" : "button", { name });
      const box = await target.boundingBox();
      expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(44);
      expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(44);
    }
    const barBox = await bar(page).boundingBox();
    expect(barBox!.y, "bar sits in the lower half").toBeGreaterThan(844 / 2);
    expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(844);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

    await page.getByRole("button", { name: "More actions" }).click();
    for (const item of await page.getByRole("menuitem").all()) {
      // The menu zooms in for 100ms, and a box measured on the way is a few percent short. Wait for it to settle.
      await expect.poll(async () => (await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    // The confirm button is a solid destructive fill with white text that passes 4.5:1, light and dark.
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.reload();
      await waitForHydrated(page.getByLabel("Select all leads on this page"));
      await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /dark/ : /^(?!.*dark)/);
      await pickRow(page, "Select S33 Lead 58");
      await page.getByRole("button", { name: "More actions" }).click();
      const item = page.getByRole("menuitem", { name: "Delete selected" });
      expect(await contrastOf(item), `${scheme} menu item`).toBeGreaterThanOrEqual(4.5);
      await item.click();
      const confirm = page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true });
      expect(await contrastOf(confirm), `${scheme} confirm button`).toBeGreaterThanOrEqual(4.5);
      // A disabled destructive button stays readable (3:1) and no longer looks like a faded red fill.
      await confirm.evaluate((el) => ((el as HTMLButtonElement).disabled = true));
      expect(await contrastOf(confirm), `${scheme} disabled confirm button`).toBeGreaterThanOrEqual(3);
      await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    }
  });
});

test.describe("bulk Create deals", () => {
  test.setTimeout(240_000);

  test("450 people with 20 contacts under Leads and contacts: chunks of 200, and created plus skipped add up", async ({ page }) => {
    await signInAdmin(page);
    const db = sql();
    const org = { id: await e2eOrganizationId() };
    const tag = unique("s33d");
    // 450 people; numbers 1 to 20 are contacts already, the rest are leads.
    await db`
      insert into people (organization_id, email, full_name, source, lifecycle, converted_at)
      select ${org.id}, ${tag} || '-' || n || '@s33.test', ${tag} || ' Person ' || lpad(n::text, 3, '0'), 'manual',
        case when n <= 20 then 'contact' else 'lead' end, case when n <= 20 then now() else null end
      from generate_series(1, 450) n`;

    const converts: number[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/leads/convert") converts.push((request.postDataJSON() as { ids: string[] }).ids.length);
    });

    await page.goto(`/leads?q=${tag}&lifecycle=all`);
    await expect(page.getByText("450 people, page 1 of 9")).toBeVisible();
    const selectAll = page.getByLabel("Select all leads on this page");
    await waitForHydrated(selectAll);
    await selectAll.click();
    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Select all 450 matching" }).click();
    await expect(page.getByRole("status").filter({ hasText: "450 selected, across pages." })).toBeVisible();

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Create deals" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Create deals for 450 leads" })).toBeVisible();
    await expect(dialog).toContainText("Moves 430 leads to Contacts.");
    await expect(dialog).toContainText("Skips 20 people who are already contacts.");
    await dialog.getByRole("button", { name: "Create deals" }).click();
    // Above 50 leads the dialog asks a second time.
    await dialog.getByRole("button", { name: "Create 430 deals" }).click();

    await expect(dialog.getByRole("status")).toHaveText("Created 430 deals. Skipped 20: 20 were already contacts.", { timeout: 180_000 });
    expect(converts).toEqual([200, 200, 50]);
    const [{ deals }] = await db`select count(*)::int as deals from deals d join people p on p.id = d.person_id where p.full_name like ${`${tag} %`}`;
    const [{ contacts }] = await db`select count(*)::int as contacts from people where full_name like ${`${tag} %`} and lifecycle = 'contact'`;
    expect(deals).toBe(430);
    expect(contacts).toBe(450);
    // The footer button; the corner X shares the name.
    await dialog.getByRole("button", { name: "Close" }).first().click();

    // The default list no longer holds any of them.
    await page.goto(`/leads?q=${tag}`);
    await expect(page.getByText("No leads match", { exact: true })).toBeVisible();
  });
});
