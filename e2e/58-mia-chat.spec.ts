import { expect, importLeads, signInAdmin, test, unique } from "./support/fixtures";

/**
 * Mia's chat with `AI_PROVIDER=fake`: the fake searches the question's last word, or the latest leads when the question
 * says "leads", and answers with links to what it found. "slowly" makes it write for about ten seconds.
 */

test.describe("Mia chat", () => {
  test("a person asks about a lead, follows the link, reloads mid-answer and stops it", async ({ page }) => {
    await signInAdmin(page);
    const tag = unique("chat");
    await importLeads(page.request, [{ email: `nora-${tag}@chat-e2e.test`, firstName: "Nora", lastName: `Narwhal${tag}`, title: "VP Sales" }]);

    await page.goto("/mia");
    await page.getByRole("textbox", { name: "Ask Mia", exact: true }).fill(`Who is Narwhal${tag}?`);
    await page.getByRole("button", { name: "Ask" }).click();
    await expect(page).toHaveURL(/\/mia\/[0-9a-f-]{36}$/);
    const answer = page.getByTestId("mia-answer").last();
    await expect(answer).toHaveAttribute("data-status", "complete");
    await expect(answer).toContainText("I found 1:");
    await expect(page.getByRole("navigation", { name: "Chats" }).first()).toContainText(`Who is Narwhal${tag}?`);

    // What Mia read is folded under the answer, with its link.
    await answer.getByText("Searched leads").click();
    await answer.getByRole("link", { name: `Nora Narwhal${tag}` }).last().click();
    await expect(page).toHaveURL(/\/leads\/[0-9a-f-]{36}/);
    await page.goBack();

    // A long answer keeps going through a reload, and Stop keeps what it wrote.
    await page.getByRole("textbox", { name: "Ask Mia", exact: true }).fill("Tell me slowly about the leads");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("mia-answer").last()).toContainText("I found");
    await page.reload();
    await expect(page.getByTestId("mia-answer").last()).toHaveAttribute("data-status", "streaming");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByTestId("mia-answer").last()).toHaveAttribute("data-status", "stopped", { timeout: 10_000 });
    await expect(page.getByTestId("mia-answer").last()).toContainText("Stopped.");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("a person asks from a lead's page, and deletes the chat after", async ({ page, browser }) => {
    await signInAdmin(page);
    const tag = unique("ask");
    await importLeads(page.request, [{ email: `omar-${tag}@chat-e2e.test`, firstName: "Omar", lastName: `Orca${tag}`, title: "Head of Sales" }]);
    await page.goto(`/leads?q=${tag}`);
    await page.getByRole("link", { name: `Omar Orca${tag}` }).click();
    await page.getByRole("link", { name: "Ask Mia about this lead" }).click();
    await expect(page.getByRole("textbox", { name: "Ask Mia about this lead" })).toBeVisible();
    await page.getByRole("textbox", { name: "Ask Mia about this lead" }).fill(`Is Orca${tag} a fit?`);
    await page.getByRole("button", { name: "Ask" }).click();
    await expect(page.getByTestId("mia-answer").last()).toHaveAttribute("data-status", "complete");
    const url = page.url();

    // Only a signed-in person reaches a chat; `mia-chat.integration.test.ts` keeps it from a colleague too.
    const response = await page.request.get(url.replace("/mia/", "/api/mia/threads/"));
    expect(response.status()).toBe(200);
    const stranger = await browser.newContext();
    expect((await stranger.request.get(url.replace("/mia/", "/api/mia/threads/"))).status()).toBe(401);
    await stranger.close();

    await page.getByRole("button", { name: "Delete chat" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete chat" }).click();
    await expect(page).toHaveURL(/\/mia$/);
    expect((await page.request.get(url.replace("/mia/", "/api/mia/threads/"))).status()).toBe(404);
  });
});
