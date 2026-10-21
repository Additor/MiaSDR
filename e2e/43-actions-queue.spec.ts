import { MOBILE_DARK, expect, expectNoHorizontalOverflow, seedReply, signInAdmin, sql, test, waitForHydrated } from "./support/fixtures";

const DINA = { email: "dina@s43-group.test", firstName: "Dina", lastName: "Park", title: "COO", company: "S43 Group" };
const ELI = { email: "eli@s43-group.test", firstName: "Eli", lastName: "Moss", title: "CTO", company: "S43 Group" };

test.describe("the Actions queue as a list to work through", () => {
  test.describe.configure({ mode: "serial" });

  test("a row names who is waiting, what they wrote and for how long, and the thread goes back and on", async ({ page }) => {
    await signInAdmin(page);
    await seedReply(page.request, { key: "S43A", mailbox: "sdr43a@e2e-corp.test", lead: DINA, reply: { bodyText: "We need pricing for forty seats before Friday." } });
    await seedReply(page.request, { key: "S43B", mailbox: "sdr43b@e2e-corp.test", lead: ELI, reply: { bodyText: "Send the security questionnaire when you can." } });

    await page.goto("/actions");
    const row = page.getByTestId("queue-item").filter({ hasText: "Dina Park" });
    await expect(row).toBeVisible();
    await expect(row.getByText("We need pricing for forty seats before Friday.")).toBeVisible();
    await expect(row.getByTestId("queue-waiting")).toHaveText(/^(Waiting|Overdue|Failed) /);
    // One link per row, named after the person with what opening it does.
    await expect(row.getByRole("link")).toHaveCount(1);
    await expect(row.getByRole("link")).toHaveAccessibleName(/^Dina Park\s*, .+, (Waiting|Overdue|Failed) /);
    await expect(page.getByTestId("queue-oldest")).toHaveText(/^The oldest has waited .+\.$/);

    // A click anywhere on the row opens the thread, here in the middle of it, and the thread knows where it came from.
    await row.click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}\?.*from=actions/);
    const thread = page.url();
    await expect(page.getByRole("link", { name: "Back to Actions" })).toHaveAttribute("href", /^\/actions\?scope=mine/);

    // Next in queue opens another item of the same queue and keeps the view.
    const next = page.getByTestId("next-in-queue");
    await expect(next).toBeVisible();
    await next.click();
    await expect(page).not.toHaveURL(thread);
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}\?.*from=actions/);

    await page.getByRole("link", { name: "Back to Actions" }).click();
    await expect(page).toHaveURL(/\/actions\?scope=mine/);
    await expect(page.getByRole("link", { name: /^Mine \d+/ })).toHaveAttribute("aria-current", "true");
  });

  test("j and k move through the rows and Enter opens the one in focus", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/actions");
    const rows = page.getByTestId("queue-item");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(1);
    // The keys listen from the moment the rows hydrate. A key pressed before that does nothing.
    await waitForHydrated(rows.first());

    await page.keyboard.press("j");
    await expect(rows.first()).toHaveAttribute("data-active", "true");
    await page.keyboard.press("j");
    await expect(rows.nth(1)).toHaveAttribute("data-active", "true");
    await expect(rows.first()).not.toHaveAttribute("data-active", "true");
    await page.keyboard.press("k");
    await expect(rows.first()).toHaveAttribute("data-active", "true");

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}\?.*from=actions/);
  });

  test("the row shows the draft, and a reply is sent and followed by the next item from the keyboard", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/actions");
    const row = page.getByTestId("queue-item").filter({ hasText: "Dina Park" });
    // What the person judges is the draft, not the subject that repeats the thread's.
    await expect(row.getByText(/^Draft: /)).toBeVisible();
    await row.click();
    const body = page.locator("#draft-body");
    await expect(body).toBeVisible();
    await waitForHydrated(body);
    await body.click();
    await page.keyboard.press("Control+Enter");

    // The status region says it was sent, and the primary step is the next item of the queue.
    await expect(page.getByTestId("reply-status")).toContainText("The reply was sent");
    const next = page.getByTestId("sent-next");
    await expect(next).toHaveText(/^Next: /);
    const here = page.url();
    await page.keyboard.press("]");
    await expect(page).not.toHaveURL(here);
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}\?.*from=actions/);
  });

  test("a held suggestion is accepted in its row, and the person stays on the queue", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/actions");
    const suggested = page.getByTestId("queue-item").filter({ hasText: "Eli Moss" }).filter({ hasText: /AI suggests/ });
    await expect(suggested).toHaveCount(1);
    await waitForHydrated(suggested);
    await suggested.getByTestId("settle").click();
    // The click settles the row where it stands: no thread opens, and the suggestion is not asked for again.
    await expect(page).toHaveURL(/\/actions/);
    await expect(page.getByTestId("queue-item").filter({ hasText: "Eli Moss" }).filter({ hasText: /AI suggests/ })).toHaveCount(0);
  });

  test("applied changes the AI was sure of are marked as looked at in one step", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/actions");
    const bulk = page.getByTestId("mark-confident");
    await expect(bulk).toHaveText(/^Mark \d+ sure changes as looked at$/);
    await waitForHydrated(page.getByTestId("queue-item").first());
    await bulk.click();
    await expect(page.getByTestId("queue-item").filter({ hasText: /AI set .*9\d% confident/ })).toHaveCount(0);
    await expect(bulk).toHaveCount(0);
  });

  test("a problem leads the page, and the top line names the oldest wait and jumps to each list", async ({ page }) => {
    await signInAdmin(page);
    const db = sql();
    const [{ id: recordId }] = await db`select r.id from records r join people p on p.id = r.person_id where p.email = 'eli@s43-group.test'`;
    await db`update records set workflow_state = 'error' where id = ${recordId}`;
    try {
      await page.goto("/actions");
      const groups = page.locator('[data-slot="queue-group"]');
      await expect(groups.first()).toHaveAttribute("data-group", "problem");
      await expect(groups.first().getByTestId("queue-item").filter({ hasText: "Eli Moss" })).toBeVisible();

      const oldest = page.getByTestId("queue-oldest-link");
      await expect(oldest).toHaveAttribute("href", /\/inbox\/[0-9a-f-]{36}\?.*from=actions/);
      const jumps = page.getByTestId("queue-jumps");
      await expect(jumps.getByRole("link", { name: /^Problems \d+$/ })).toBeVisible();
      await jumps.getByRole("link", { name: /^Replies/ }).click();
      await expect(page).toHaveURL(/#group-reply$/);
    } finally {
      await db`update records set workflow_state = 'action_required' where id = ${recordId}`;
    }
  });

  test("everything with nothing in it folds into one line", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/actions");
    const folded = page.getByTestId("queue-quiet");
    await expect(folded).toHaveText(/^Nothing in .+\.$/);
    // A group named in the folded line has no section of its own.
    const groupsShown = await page.locator('[data-slot="queue-group"]').count();
    expect(groupsShown).toBeGreaterThan(0);
    expect(groupsShown).toBeLessThan(5);
  });
});

test.describe("smoke at 390x844 in dark mode", () => {
  test.use(MOBILE_DARK);

  test("rows keep their time on screen and are tall enough to touch", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/actions");
    // The list streams in behind a skeleton, and for a moment the streamed copy and the shown one are both in the page.
    // Measure the shown rows only.
    const rows = page.getByTestId("queue-item").filter({ visible: true });
    await expect(rows.first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    for (const row of await rows.all()) {
      const box = await row.boundingBox();
      expect(box?.height ?? 0, "row height in px").toBeGreaterThanOrEqual(44);
      const time = await row.getByTestId("queue-waiting").boundingBox();
      expect((time?.x ?? 0) + (time?.width ?? 0), "right edge of the waiting time").toBeLessThanOrEqual(390);
    }
  });
});
