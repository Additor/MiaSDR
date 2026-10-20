import { devFakes, expect, signInAdmin, sql, test } from "./support/fixtures";

/*
 * LinkedIn conversation replies. The lead's message is filed through the dev-fakes helper action `liInbound`, which
 * runs the real inbox ingest on the fake gateway's demo account (see src/app/api/webhooks/dev-fakes/route.ts).
 * Nothing here calls Unipile.
 */
interface LiState {
  messages: Array<{ text: string; chat: string }>;
}

async function organizationId(): Promise<string> {
  const [row] = await sql()`select id from organizations order by created_at limit 1`;
  return row.id as string;
}

async function seedLead(request: Parameters<typeof devFakes>[0], key: string, name: string, text: string) {
  return devFakes<{ outcome: { status: string }; accountId: string }>(request, {
    action: "liInbound",
    organizationId: await organizationId(),
    chat: `chat-${key}`,
    messageId: `msg-${key}`,
    slug: `lead-${key}`,
    name,
    text,
  });
}

/** Two tests send from one account within seconds. The default 8 second gap between replies would refuse the second. */
async function turnOffReplyGap(): Promise<void> {
  const org = await organizationId();
  await sql()`insert into channel_settings (organization_id, channel, values) values (${org}, 'linkedin', ${sql().json({ replyGapSeconds: 0 })})
    on conflict (organization_id, channel) do update set values = channel_settings.values || excluded.values`;
}

const badge = (page: import("@playwright/test").Page) => page.getByTestId("inbox-unread");
const badgeCount = async (page: import("@playwright/test").Page) => ((await badge(page).count()) === 0 ? 0 : Number((await badge(page).first().innerText()).replace(/\D/g, "")));

test.describe("LinkedIn replies from the inbox", () => {
  test("a reply is typed, sent once through the gateway, shown in the thread, and the unread badge drops", async ({ page }) => {
    await signInAdmin(page);
    await turnOffReplyGap();
    await devFakes(page.request, { action: "liBehavior", kind: "message", mode: "ok" });
    const seeded = await seedLead(page.request, "e19a", "Lia Reyes", "Interested, can you send details?");
    expect(seeded.outcome.status).toBe("created");

    await page.goto("/inbox");
    const before = await badgeCount(page);
    expect(before).toBeGreaterThan(0);
    await page.getByRole("link", { name: /Lia Reyes/ }).click();
    await expect(page).toHaveURL(/\/inbox\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("paragraph").filter({ hasText: "Interested, can you send details?" })).toBeVisible();

    // Opening the thread marks it read, and the sidebar count follows.
    await expect.poll(() => badgeCount(page)).toBe(before - 1);

    await expect(page.getByTestId("linkedin-reply-panel")).toBeVisible();
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeDisabled();
    await page.getByLabel(/^Message/).fill("Thanks Lia. Here are the details you asked for.");
    await send.click();
    await expect(page.getByText("Thanks Lia. Here are the details you asked for.").first()).toBeVisible();
    await expect(page.getByLabel(/^Message/)).toHaveValue("");

    const state = await devFakes<LiState>(page.request, { action: "liState" });
    expect(state.messages.filter((m) => m.text === "Thanks Lia. Here are the details you asked for.")).toHaveLength(1);

    await page.reload();
    await expect(page.getByText("Thanks Lia. Here are the details you asked for.").first()).toBeVisible();
  });

  test("a send whose outcome is unknown is not repeated and waits for a person", async ({ page }) => {
    await signInAdmin(page);
    await turnOffReplyGap();
    await seedLead(page.request, "e19b", "Marco Silva", "Can we talk Thursday?");
    await page.goto("/inbox");
    await page.getByRole("link", { name: /Marco Silva/ }).click();
    await expect(page.getByTestId("linkedin-reply-panel")).toBeVisible();

    await devFakes(page.request, { action: "liBehavior", kind: "message", mode: "timeout-after-accept" });
    await page.getByLabel(/^Message/).fill("Thursday works. Does 10:00 suit you?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("uncertain-box")).toBeVisible();
    await expect(page.getByTestId("draft-status")).toHaveText("Delivery not confirmed");

    const state = await devFakes<LiState>(page.request, { action: "liState" });
    expect(state.messages.filter((m) => m.text === "Thursday works. Does 10:00 suit you?")).toHaveLength(1);
    // The composer is gone: there is nothing to click that could send it again.
    await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);

    await page.getByLabel("How did you check?").fill("Saw it in the LinkedIn chat.");
    await page.getByRole("button", { name: "Confirm delivered" }).click();
    await expect(page.getByTestId("uncertain-box")).toHaveCount(0);
    await expect(page.getByText("Thursday works. Does 10:00 suit you?").first()).toBeVisible();
    await devFakes(page.request, { action: "liBehavior", kind: "message", mode: "ok" });
  });
});
