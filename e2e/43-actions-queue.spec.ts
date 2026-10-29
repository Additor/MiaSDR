import { MOBILE_DARK, e2eOrganizationId, expect, expectNoHorizontalOverflow, seedReply, signInAdmin, sql, test, waitForHydrated } from "./support/fixtures";

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

  test("applied AI picks the AI was sure of are marked as looked at in one step", async ({ page }) => {
    await signInAdmin(page);
    // Two replies the AI files on its own at 90%, so the file runs alone as well as after the other specs. A decline needs
    // no reply and settles its record; putting the record back in the queue leaves the unreviewed pick to look at. Not now
    // is seeded with Check skip, so an admin sets it to Check after through the API before the replies come, and the
    // finally block puts the seeded rule back for the specs after this one.
    const [notNow] = await sql()`select rt.id, rt.check_mode from reply_types rt join reply_type_sets s on s.id = rt.reply_type_set_id
      where s.organization_id = ${await e2eOrganizationId()} and s.is_default and rt.key = 'not_required_right_now'`;
    const setCheck = async (checkMode: string) => expect((await page.request.patch(`/api/reply-types/${notNow.id}`, { data: { checkMode } })).status()).toBe(200);
    await setCheck("after");
    try {
      for (const [key, name, text] of [
        ["S43C", "Ola", "No thanks, not interested."],
        ["S43D", "Max", "Not now, thanks."],
      ] as const) {
        const email = `${name.toLowerCase()}@s43-sure.test`;
        const [seeded] = await sql()`select 1 from people where email = ${email}`;
        if (!seeded) await seedReply(page.request, { key, mailbox: `sdr${key.toLowerCase()}@e2e-corp.test`, lead: { email, firstName: name, lastName: "Sure", company: "S43 Sure" }, reply: { bodyText: text } });
        await sql()`update records set workflow_state = 'action_required' where person_id = (select id from people where email = ${email})`;
      }
    } finally {
      await setCheck(notNow.check_mode);
    }
    await page.goto("/actions");
    // The row names the type alone; the channel is a mark.
    const ola = page.getByTestId("queue-item").filter({ hasText: "Ola Sure" });
    await expect(ola.getByTestId("queue-type")).toHaveText("Not now");
    await expect(ola).toContainText(/AI applied Not now, 9\d% confident/);
    await expect(ola.getByTestId("settle")).toHaveText("Looks right");
    const bulk = page.getByTestId("mark-confident");
    await expect(bulk).toHaveText(/^Looks right: \d+ sure picks$/);
    await waitForHydrated(page.getByTestId("queue-item").first());
    await bulk.click();
    // The bulk step names every row it marks before it marks them, and Keep for review is the way out.
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("mark-confident-list")).toContainText("Ola Sure");
    await dialog.getByRole("button", { name: /^Mark \d+ as looked at$/ }).click();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: /^Marked \d+ AI picks as looked at\.$/ })).toBeVisible();
    await expect(page.getByTestId("queue-item").filter({ hasText: /AI applied .*9\d% confident/ })).toHaveCount(0);
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
      // A list with work is a jump link; which ones hold work depends on the specs that ran before.
      const jump = jumps.getByRole("link").filter({ hasNotText: "Problems" }).first();
      const target = (await jump.getAttribute("href")) ?? "";
      await jump.click();
      await expect(page).toHaveURL(new RegExp(`${target}$`));
    } finally {
      await db`update records set workflow_state = 'action_required' where id = ${recordId}`;
    }
  });

  test("the strip links every list with work, and names the empty ones on one muted line with no section", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/actions");
    const jumps = page.getByTestId("queue-jumps");
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
    await expect(page.getByText("Drafts waiting for your review. Nothing is sent until you approve.", { exact: true })).toHaveCount(0);
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
