import type { APIRequestContext } from "@playwright/test";
import { expect, signInAdmin, test } from "./support/fixtures";

/** A 2026-07-28 discovery request with the token, as an MCP client sends it. */
function discover(request: APIRequestContext, token: string) {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  return request.post("/api/mcp", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "server/discover",
    },
    data: { jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } },
  });
}

test("an admin turns on MCP, creates a token an agent can use once, and revokes it", async ({ page }) => {
  await signInAdmin(page);
  await page.goto("/settings/mcp");
  // The page streams in; read the switch only once it shows.
  await expect(page.getByRole("button", { name: /^Turn (on|off) MCP$/ })).toBeVisible();
  if (await page.getByText("MCP is off.").isVisible()) {
    await page.getByRole("button", { name: "Turn on MCP" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
  await expect(page.getByText("MCP is on.")).toBeVisible();

  await page.getByLabel("Token name").fill("E2E laptop");
  await page.getByRole("radio", { name: "Read and make changes" }).click();
  await page.getByRole("button", { name: "Create token" }).click();
  const secret = page.getByLabel("New token");
  await expect(secret).toHaveValue(/^msdr_pat_[A-Za-z0-9_-]{43}$/);
  const token = await secret.inputValue();
  await expect(page.getByText(`claude mcp add --transport http miasdr`)).toContainText(token);
  expect((await discover(page.request, token)).status()).toBe(200);

  await page.getByRole("button", { name: "I copied it" }).click();
  await expect(secret).toBeHidden();
  const mine = page.getByRole("list", { name: "Your tokens" });
  const row = mine.getByRole("listitem").filter({ hasText: "E2E laptop" });
  await expect(row).toContainText(`…${token.slice(-4)}`);
  await expect(row).toContainText("Makes changes");
  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke token" }).click();
  // The open dialog hides the page from the accessibility tree, so wait for it to close before reading the list.
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Token revoked.")).toBeVisible();
  await expect(row).toBeHidden();
  expect((await discover(page.request, token)).status()).toBe(401);

  await page.getByRole("button", { name: "Turn off MCP" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("MCP is off.")).toBeVisible();
});

test("an admin lets agents send replies, creates a token that sends, and turns agent sending off again", async ({ page }) => {
  await signInAdmin(page);
  await page.goto("/settings/mcp");
  await expect(page.getByRole("button", { name: /^Turn (on|off) MCP$/ })).toBeVisible();
  if (await page.getByText("MCP is off.").isVisible()) {
    await page.getByRole("button", { name: "Turn on MCP" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
  // Agent sending starts off, so a token that sends cannot be chosen yet.
  await expect(page.getByRole("radio", { name: "Read, make changes and send" })).toBeDisabled();

  await page.goto("/settings/organization");
  const card = page.getByRole("region", { name: "Agents can send" });
  await card.getByRole("radio", { name: "Replies", exact: true }).click();
  await card.getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Let agents send" }).click();
  await expect(page.getByText("Agent sending saved.")).toBeVisible();

  await page.goto("/settings/mcp");
  // With agent sending on, owners and admins see what agents sent against the day's limits.
  const sends = page.getByRole("region", { name: "Agent sends" });
  await expect(sends).toContainText("Today: 0 of 100 agent replies, 0 of 200 leads enrolled by agents.");
  // The page says what agents can do here, whatever the organization chose.
  await expect(page.getByText(/Agents with a token that sends can send replies with no one reviewing first/)).toBeVisible();
  await expect(page.getByText("No agent sends email or LinkedIn messages.")).toBeHidden();
  await expect(sends.getByText("No agent replies yet")).toBeVisible();
  await page.getByLabel("Token name").fill("E2E sender");
  await page.getByRole("radio", { name: "Read, make changes and send" }).click();
  await expect(page.getByText(/sends replies as you, with no one reviewing first/)).toBeVisible();
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByLabel("New token")).toHaveValue(/^msdr_pat_/);
  await page.getByRole("button", { name: "I copied it" }).click();
  const row = page.getByRole("list", { name: "Your tokens" }).getByRole("listitem").filter({ hasText: "E2E sender" });
  await expect(row).toContainText("Sends");

  await page.goto("/settings/organization");
  await card.getByRole("radio", { name: "Off", exact: true }).click();
  await card.getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Stop agent sending" }).click();
  await expect(page.getByText("Agent sending saved.")).toBeVisible();

  await page.goto("/settings/mcp");
  await expect(row).toContainText("No longer sends");
  await expect(row).not.toContainText(/\bSends\b/);
  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke token" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Turn off MCP" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("MCP is off.")).toBeVisible();
});
