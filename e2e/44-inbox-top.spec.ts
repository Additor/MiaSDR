import type { Page } from "@playwright/test";
import { MOBILE_DARK, expect, expectNoHorizontalOverflow, seedReply, signInAdmin, sql, test, waitForHydrated } from "./support/fixtures";

const UMA = { email: "uma@s44-group.test", firstName: "Uma", lastName: "Reed", title: "CFO", company: "S44 Group" };

/**
 * Signs in and makes sure the Inbox holds an unread reply that waits in Actions: Uma's, seeded once per database.
 */
async function openWithReply(page: Page) {
  await signInAdmin(page);
  const [seeded] = await sql()`select 1 from messages m join conversations c on c.id = m.conversation_id join records r on r.id = c.record_id join people p on p.id = r.person_id where p.email = ${UMA.email} and m.direction = 'inbound' limit 1`;
  if (!seeded) await seedReply(page.request, { key: "S44", mailbox: "sdr44@e2e-corp.test", lead: UMA, reply: { bodyText: "Can you share the rollout timeline?" } });
}

test.describe("the top of the Inbox is about conversations", () => {
  test.describe.configure({ mode: "serial" });

  test("two sections, one row of views, and no work to do in the list", async ({ page }) => {
    await openWithReply(page);
    await page.goto("/inbox");
    const sections = page.getByRole("navigation", { name: "Inbox sections" });
    await expect(sections.getByRole("link", { name: "Conversations" })).toHaveAttribute("aria-current", "page");
    await expect(sections.getByRole("link", { name: "Scheduled" })).toBeVisible();

    const views = page.getByRole("group", { name: "Conversation views" });
    await expect(views.getByRole("link")).toHaveText(["All", "Unread", "Important"]);
    await expect(views.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "true");
    await expect(page.getByTestId("more-views")).toHaveText("More");

    // Work that waits on a person lives in Actions: no such view, no such badge in the list.
    await expect(page.getByText("Needs action")).toHaveCount(0);
    await expect(page.getByText("Draft ready")).toHaveCount(0);
    // An unread conversation shows a dot named after its count, and the name is bold.
    await expect(page.getByRole("img", { name: /^\d+ unread$/ }).first()).toBeVisible();
  });

  test("every row fits the width, says when the conversation last moved, and lines its names up", async ({ page }) => {
    await signInAdmin(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/inbox");
    const rows = page.locator("li[data-list-row]");
    await expect(rows.first()).toBeVisible();
    // The list is a list: nothing scrolls sideways inside it or around it.
    await expect(page.locator('[data-slot="table-container"]')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    // Under Today the clock is enough, under older days the date is, and the day is a heading.
    await expect(rows.first().locator("time")).toHaveText(/^(\d{2}:\d{2}|\d{4}-\d{2}-\d{2})$/);
    const box = await rows.first().locator("time").boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0), "right edge of the time").toBeLessThanOrEqual(1280);
    await expect(page.getByRole("heading", { name: /^(Today|Yesterday|This week|Earlier)$/ }).first()).toBeVisible();
    // The unread dot has its own gutter, so a row with one does not push its name sideways.
    const xs = await rows.locator("a").evaluateAll((links) => links.slice(0, 10).map((link) => Math.round(link.getBoundingClientRect().x)));
    expect(new Set(xs).size, `name x positions ${xs.join(",")}`).toBe(1);
  });

  test("More holds Sent, Replied, Out of office and Automated, and names the one in force", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/inbox");
    const more = page.getByTestId("more-views");
    await waitForHydrated(more);
    await more.click();
    await expect(page.getByRole("menuitem")).toHaveText(["Sent", "Replied", "Out of office", "Automated"]);
    await page.getByRole("menuitem", { name: "Sent" }).click();
    await expect(page).toHaveURL(/view=sent/);
    await expect(page.getByTestId("more-views")).toHaveText("Sent");
    // The chips row does not mark All while a view behind More is open.
    await expect(page.getByRole("group", { name: "Conversation views" }).getByRole("link", { name: "All" })).not.toHaveAttribute("aria-current", "true");
  });

  test("the line says how much waits in Actions and links there", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/inbox");
    const waiting = page.getByTestId("waiting-in-actions");
    await expect(waiting).toHaveText(/^\d+ waiting in Actions$/);
    // The number is the one the sidebar shows beside Actions.
    await expect(page.getByTestId("actions-pending")).toHaveText(new RegExp(`^${(await waiting.innerText()).split(" ")[0]}\\b`));
    await waiting.click();
    await expect(page).toHaveURL(/\/actions$/);
  });

  test("Scheduled drops the views, and the search and Filters share a line", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/inbox?view=scheduled");
    await expect(page.getByRole("group", { name: "Conversation views" })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "Inbox sections" }).getByRole("link", { name: "Scheduled" })).toHaveAttribute("aria-current", "page");

    await page.goto("/inbox");
    const search = page.getByRole("searchbox", { name: "Search inbox" });
    const toggle = page.getByTestId("inbox-filters-toggle");
    const [s, t] = [await search.boundingBox(), await toggle.boundingBox()];
    expect(Math.abs((s?.y ?? 0) + (s?.height ?? 0) / 2 - ((t?.y ?? 0) + (t?.height ?? 0) / 2)), "vertical centers differ by px").toBeLessThan(8);
    await waitForHydrated(toggle);
    await toggle.click();
    await expect(page.getByRole("form", { name: "Inbox filters" })).toBeVisible();
    await toggle.click();
    await expect(page.getByRole("form", { name: "Inbox filters" })).toHaveCount(0);
  });
});

test.describe("a list that does not load", () => {
  test("the Inbox keeps its top and says what happened, and loads again once the fault is gone", async ({ page }) => {
    await openWithReply(page);
    // The list reads messages.body_text. Renaming the column makes every list query fail until it is put back.
    const db = sql();
    await db`alter table messages rename column body_text to body_text_hidden`;
    try {
      await page.goto("/inbox");
      const failed = page.getByTestId("inbox-load-failed");
      await expect(failed).toBeVisible();
      await expect(failed.getByText("The conversations did not load")).toBeVisible();
      // The page is still the Inbox: sections, views and search stay, and there is no empty state under the failure.
      await expect(page.getByRole("navigation", { name: "Inbox sections" })).toBeVisible();
      await expect(page.getByRole("group", { name: "Conversation views" })).toBeVisible();
      await expect(page.getByRole("searchbox", { name: "Search inbox" })).toBeVisible();
      await expect(page.getByText("No replies yet")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Something went wrong" })).toHaveCount(0);
    } finally {
      await db`alter table messages rename column body_text_hidden to body_text`;
    }
    await page.getByRole("link", { name: "Try again" }).click();
    await expect(page.getByTestId("inbox-load-failed")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Uma Reed/ }).first()).toBeVisible();
  });
});

test.describe("smoke at 390x844 in dark mode", () => {
  test.use(MOBILE_DARK);

  test("the views, the filter button and the Actions line fit the phone", async ({ page }) => {
    await openWithReply(page);
    await page.goto("/inbox");
    // The list streams in behind a skeleton. Measure once it is there.
    await expect(page.getByTestId("waiting-in-actions")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const targets = {
      more: page.getByTestId("more-views"),
      filters: page.getByTestId("inbox-filters-toggle"),
      unread: page.getByRole("group", { name: "Conversation views" }).getByRole("link", { name: "Unread" }),
    };
    for (const [name, target] of Object.entries(targets)) {
      await expect(target, name).toBeVisible();
      const box = await target.boundingBox();
      expect(box?.height ?? 0, `${name}: target height in px`).toBeGreaterThanOrEqual(44);
    }
    // A row keeps its time on screen and is tall enough to touch.
    const first = page.locator("li[data-list-row]").first();
    const row = await first.boundingBox();
    expect(row?.height ?? 0, "row height in px").toBeGreaterThanOrEqual(44);
    const time = await first.locator("time").boundingBox();
    expect((time?.x ?? 0) + (time?.width ?? 0), "right edge of the time").toBeLessThanOrEqual(390);
  });
});
