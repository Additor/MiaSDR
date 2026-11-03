import { MOBILE_DARK, expect, expectNoHorizontalOverflow, seedReply, signInAdmin, sql, test, waitForHydrated } from "./support/fixtures";

const DINA = { email: "dina@s43-group.test", firstName: "Dina", lastName: "Park", title: "COO", company: "S43 Group" };
const ELI = { email: "eli@s43-group.test", firstName: "Eli", lastName: "Moss", title: "CTO", company: "S43 Group" };
const FAY = { email: "fay@s43-group.test", firstName: "Fay", lastName: "Stone", title: "CFO", company: "S43 Group" };

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
    await expect(page.getByTestId("queue-oldest")).toHaveText(/^Oldest wait .+/);

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

  test("a held AI pick is accepted in its row, and the person stays on the queue", async ({ page }) => {
    await signInAdmin(page);
    // A second AI pick row, so a row moves up into the accepted one's place.
    const [seeded] = await sql()`select 1 from people where email = ${FAY.email}`;
    if (!seeded) await seedReply(page.request, { key: "S43E", mailbox: "sdr43e@e2e-corp.test", lead: FAY, reply: { bodyText: "Please stop emailing me." } });
    await page.goto("/actions");
    await expect(page.getByTestId("queue-item").filter({ hasText: "Fay Stone" })).toBeVisible();
    const suggested = page.getByTestId("queue-item").filter({ hasText: "Eli Moss" }).filter({ hasText: /AI picked/ });
    await expect(suggested).toHaveCount(1);
    await waitForHydrated(suggested);
    const total = page.getByTestId("queue-total-classification");
    const before = Number(await total.textContent());
    await suggested.getByTestId("settle").click();
    // The click settles the row where it stands: no thread opens, and the suggestion is not asked for again.
    await expect(page).toHaveURL(/\/actions/);
    await expect(page.getByTestId("queue-item").filter({ hasText: "Eli Moss" }).filter({ hasText: /AI picked/ })).toHaveCount(0);
    // The page's one live region says whose pick was accepted.
    await expect(page.getByTestId("queue-notice")).toHaveText("AI pick accepted: Eli Moss.");
    // The row stays as one muted line that says what happened, with the way to the conversation.
    const settled = page.getByTestId("queue-settled").filter({ hasText: "Eli Moss" });
    await expect(settled).toHaveText(/^Accepted .+ for Eli Moss\.Open conversation$/);
    await expect(settled.getByRole("link", { name: "Open conversation" })).toHaveAttribute("href", /\/inbox\/[0-9a-f-]{36}\?.*from=actions/);
    // Once the refresh brings the new total, focus is still on the row that moved up, and j goes on from it.
    await expect(total).toHaveText(String(before - 1));
    const focused = page.getByTestId("queue-item").filter({ has: page.locator("a:focus") });
    await expect(focused).toHaveCount(1);
    const from = await focused.getAttribute("data-list-row");
    const ids = await page.locator("[data-list-row]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-list-row")));
    await page.keyboard.press("j");
    await expect(page.locator("[data-list-row][data-active=true]")).toHaveAttribute("data-list-row", ids[Math.min(ids.indexOf(from) + 1, ids.length - 1)] ?? "");
  });

  test("a stop request is its own row: Review stop request opens the thread with Stop contacting, and nothing is accepted", async ({ page }) => {
    await signInAdmin(page);
    const [seeded] = await sql()`select 1 from people where email = ${FAY.email}`;
    if (!seeded) await seedReply(page.request, { key: "S43E", mailbox: "sdr43e@e2e-corp.test", lead: FAY, reply: { bodyText: "Please stop emailing me." } });
    await page.goto("/actions");
    const row = page.getByTestId("queue-item").filter({ hasText: "Fay Stone" });
    await expect(row).toContainText("Possible stop request. Nothing stops until you choose.");
    // The channel is a mark with its name, not a word in the meta line.
    await expect(row.getByRole("img", { name: "Email" })).toBeVisible();
    // No one-click Accept: the only step is the review, a link to the thread.
    await expect(row.getByTestId("settle")).toHaveCount(0);
    const review = row.getByRole("link", { name: "Review stop request: Fay Stone" });
    await expect(review).toHaveAttribute("href", /\/inbox\/[0-9a-f-]{36}\?.*from=actions.*&stop=1$/);
    await waitForHydrated(row);
    await review.click();
    await expect(page).toHaveURL(/stop=1/);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio", { name: "Every channel" })).toBeChecked();
    // Closing it stops nothing: the row still waits.
    await page.keyboard.press("Escape");
    await page.goto("/actions");
    await expect(page.getByTestId("queue-item").filter({ hasText: "Fay Stone" })).toContainText("Possible stop request.");
  });

  test("a sure pick that writes no draft applies at once and leaves nothing in the queue", async ({ page }) => {
    await signInAdmin(page);
    const email = "ola@s43-sure.test";
    const [seeded] = await sql()`select 1 from people where email = ${email}`;
    if (!seeded) await seedReply(page.request, { key: "S43C", mailbox: "sdrs43c@e2e-corp.test", lead: { email, firstName: "Ola", lastName: "Sure", company: "S43 Sure" }, reply: { bodyText: "No thanks, not interested." } });
    const [record] = await sql()`select r.workflow_state, t.name from conversations r join people p on p.id = r.person_id join reply_types t on t.id = r.reply_type_id where p.email = ${email}`;
    expect(record).toMatchObject({ workflow_state: "idle", name: "Not now" });
    await page.goto("/actions");
    await expect(page.getByTestId("queue-item").first()).toBeVisible();
    await expect(page.getByTestId("queue-item").filter({ hasText: "Ola Sure" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Looks right/ })).toHaveCount(0);
  });

  test("a problem leads the page, and the top line names the oldest wait and jumps to each list", async ({ page }) => {
    await signInAdmin(page);
    const db = sql();
    const [{ id: conversationId }] = await db`select r.id from conversations r join people p on p.id = r.person_id where p.email = 'eli@s43-group.test'`;
    await db`update conversations set workflow_state = 'error' where id = ${conversationId}`;
    try {
      await page.goto("/actions");
      const groups = page.locator('[data-slot="queue-group"]');
      await expect(groups.first()).toHaveAttribute("data-group", "problem");
      await expect(groups.first().getByTestId("queue-item").filter({ hasText: "Eli Moss" })).toBeVisible();

      const oldest = page.getByTestId("queue-oldest-link");
      await expect(oldest).toHaveAttribute("href", /\/inbox\/[0-9a-f-]{36}\?.*from=actions/);
      const jumps = page.getByTestId("queue-jumps");
      await expect(jumps.getByRole("link", { name: /^Problems \d+$/ })).toBeVisible();
      // A list with work is a jump link; which ones hold work depends on the specs that ran before.
      const jump = jumps.getByRole("link").filter({ hasNotText: "Problems" }).first();
      const target = (await jump.getAttribute("href")) ?? "";
      await jump.click();
      await expect(page).toHaveURL(new RegExp(`${target}$`));
    } finally {
      await db`update conversations set workflow_state = 'action_required' where id = ${conversationId}`;
    }
  });

  test("the strip links every list with work, and names the empty ones on one muted line with no section", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/actions");
    const jumps = page.getByTestId("queue-jumps");
    // allTextContents does not wait, so the strip has to be on the page before it is read.
    await expect(jumps).toBeVisible();
    const linked = await jumps.getByRole("link", { name: /^(Problems|Replies|Follow-ups|AI picks|Next steps|Tasks) \d+$/ }).allTextContents();
    const empty = (await jumps.getByTestId("queue-jumps-empty").allTextContents()).join("");
    // Each of the six lists shows once: as a link with its count, or by name on the "Nothing in" line.
    for (const name of ["Problems", "Replies", "Follow-ups", "AI picks", "Next steps", "Tasks"]) {
      const shown = linked.filter((text) => text.startsWith(`${name} `)).length + (new RegExp(`(^Nothing in |, )${name}(,|\\.$)`).test(empty) ? 1 : 0);
      expect(shown, name).toBe(1);
    }
    // An empty list has no section of its own.
    const groupsShown = await page.locator('[data-slot="queue-group"]').count();
    expect(groupsShown).toBeGreaterThan(0);
    expect(groupsShown).toBeLessThan(5);
    expect(linked.length).toBeLessThan(6);
    // Help sits on info marks, and only where a group's name needs it.
    await expect(page.getByText("Drafts waiting for your review before anyone sends them.", { exact: true })).toHaveCount(0);
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
