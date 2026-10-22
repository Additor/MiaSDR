import { expect, signInAdmin, sql, test } from "./support/fixtures";

/** LinkedIn account connection, limits editor, delivery replay and the counter reset, against the fake LinkedIn gateway. */
test.describe("linkedin settings and jobs", () => {
  test("connect an account through hosted auth, edit its limits, then replay webhooks and reset counters", async ({ page, watch }) => {
    await signInAdmin(page);
    // Store the Unipile credentials once (the fake gateway accepts any key).
    const saved = await page.request.post("/api/linkedin", { data: { dsn: "api1.unipile.com:13111", apiKey: "e2e-key" } });
    expect([200, 201]).toContain(saved.status());

    // Hosted auth: the fake wizard succeeds at once and sends the browser back with the success flag.
    await page.goto("/settings/linkedin");
    await page.getByRole("button", { name: "Connect a LinkedIn account" }).click();
    await expect(page.getByText("LinkedIn account connected.")).toBeVisible();
    await expect(page).toHaveURL(/\/settings\/linkedin$/);
    await expect(page.getByText("Hosted Seller", { exact: false }).first()).toBeVisible();
    // The link history is collapsed by default; open it to see the pending link.
    await page.getByText("Recent connection links").click();
    await expect(page.getByText("Pending", { exact: true }).first()).toBeVisible();

    // A failed wizard shows a message and connects nothing.
    await page.goto("/settings/linkedin?unipile=failure");
    await expect(page.getByText(/did not connect the account/)).toBeVisible();

    // Limits editor: the warning appears while typing, the value saves, and the API refuses out-of-bound values.
    const card = page.getByTestId("linkedin-account").filter({ hasText: "Hosted Seller" }).first();
    const messages = card.getByLabel("Messages per day");
    await messages.fill("150");
    await expect(card.getByText(/More than 100 messages a day/)).toBeVisible();
    await card.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("linkedin-account").filter({ hasText: "Hosted Seller" }).first().getByLabel("Messages per day")).toHaveValue("150");
    const accounts = (await (await page.request.get("/api/linkedin")).json()) as { accounts: Array<{ id: string; name: string }> };
    const target = accounts.accounts.find((a) => a.name?.startsWith("Hosted Seller"));
    expect(target).toBeTruthy();
    watch.tolerate(/response 422: PATCH/);
    const refused = await page.request.patch(`/api/linkedin/accounts/${target?.id}`, { data: { dailyMessageLimit: 500 } });
    expect(refused.status()).toBe(422);

    // Inbound events: with no failed delivery the replay button is off.
    await page.goto("/settings/inbound-events");
    await expect(page.getByText("No LinkedIn delivery waits.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Replay LinkedIn deliveries" })).toBeDisabled();

    // A dead delivery enables it. Replaying runs it once and the page shows the result.
    const [{ id: org }] = await sql()`select organization_id as id from linkedin_accounts limit 1`;
    await sql()`
      insert into inbound_events (organization_id, provider, provider_event_key, event_type, account_ref, payload, status, attempts)
      values (${org}, 'unipile', ${"e2e-lis-" + Date.now()}, 'message_received', 'no-such-account', ${sql().json({ event: "message_received", account_id: "no-such-account", account_type: "LINKEDIN", message_id: "m1", message: "hi" } as never)}, 'failed', 8)`;
    await page.reload();
    await expect(page.getByText(/LinkedIn: 1 gave up/)).toBeVisible();
    await page.getByRole("button", { name: "Replay LinkedIn deliveries" }).click();
    await expect(page.getByText(/Replayed 1 deliveries/)).toBeVisible();
    // The audit rows live on the Jobs History tab.
    await page.goto("/settings/jobs");
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByText("Replayed failed webhooks").first()).toBeVisible();

    // Reset daily counters sits with the accounts on the LinkedIn page. It asks first, then records who did it.
    await sql()`update linkedin_accounts set search_leads_today = 40, limit_reached_until = now() + interval '1 hour' where organization_id = ${org}`;
    await page.goto("/settings/linkedin");
    await page.getByRole("button", { name: "Reset daily counters" }).click();
    await page.getByRole("dialog", { name: "Reset daily counters?" }).getByRole("button", { name: "Reset counters" }).click();
    await expect(page.getByText(/Reset \d+ account\(s\)/)).toBeVisible();
    await page.goto("/settings/jobs");
    await page.getByRole("tab", { name: "History" }).click();
    await expect(page.getByText("Reset daily counters", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Ada Admin/).first()).toBeVisible();
    const [row] = await sql()`select count(*) filter (where search_leads_today <> 0 or limit_reached_until is not null)::int as left_over from linkedin_accounts where organization_id = ${org}`;
    expect(row.left_over).toBe(0);
    await expect(page.getByText("linkedin.reset-daily-counters")).toBeVisible();
  });
});
