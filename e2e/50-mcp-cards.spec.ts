import type { Page } from "@playwright/test";
import { expect, signInAdmin, test } from "./support/fixtures";

const DRAFT_CARD = "ui://miasdr/reply-draft.html";
const LEAD_TEXT = `<img src=x onerror="window.top.__hacked = true">Please call me`;

/** A host as the MCP Apps protocol describes one: a sandboxed frame, the handshake, then the tool's answer. */
async function showCard(page: Page, html: string, result: Record<string, unknown>) {
  // Leave the app first, so its React does not write to a document this replaces.
  await page.goto("about:blank");
  await page.setContent(`<!doctype html><title>Host</title><iframe id="view" sandbox="allow-scripts" style="width:600px;height:500px"></iframe>`);
  await page.evaluate(
    ({ html, result }) => {
      const frame = document.getElementById("view") as HTMLIFrameElement;
      const host = window as unknown as { opened: unknown[] };
      host.opened = [];
      window.addEventListener("message", (event) => {
        const { id, method, params } = event.data;
        const reply = (payload: Record<string, unknown>) => frame.contentWindow?.postMessage({ jsonrpc: "2.0", ...payload }, "*");
        if (method === "ui/initialize") reply({ id, result: { protocolVersion: params.protocolVersion, hostInfo: { name: "e2e", version: "1" }, hostCapabilities: { openLinks: {} }, hostContext: { theme: "light" } } });
        if (method === "ui/notifications/initialized") reply({ method: "ui/notifications/tool-result", params: result });
        if (method === "ui/open-link") {
          host.opened.push(params.url);
          reply({ id, result: {} });
        }
      });
      frame.srcdoc = html;
    },
    { html, result },
  );
  return page.frameLocator("#view");
}

/** Reads the draft card through the endpoint with a new token that makes changes. */
async function readCards(page: Page) {
  await signInAdmin(page);
  await page.goto("/settings/mcp");
  await expect(page.getByRole("button", { name: /^Turn (on|off) MCP$/ })).toBeVisible();
  if (await page.getByText("MCP is off.").isVisible()) {
    await page.getByRole("button", { name: "Turn on MCP" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
  await expect(page.getByText("MCP is on.")).toBeVisible();
  await page.getByLabel("Token name").fill(`E2E cards ${Date.now()}`);
  await page.getByRole("radio", { name: "Read and make changes" }).click();
  await page.getByRole("button", { name: "Create token" }).click();
  const token = await page.getByLabel("New token").inputValue();
  const response = await page.request.post("/api/mcp", {
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "resources/read", "mcp-name": DRAFT_CARD },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: {
        uri: DRAFT_CARD,
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} },
      },
    },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { result: { contents: Array<{ mimeType: string; text: string }> } };
  expect(body.result.contents[0].mimeType).toBe("text/html;profile=mcp-app");
  return body.result.contents[0].text;
}

test("a reply draft card shows a stranger's text as text and opens MiaSDR to review it", async ({ page }) => {
  const html = await readCards(page);
  const view = await showCard(page, html, {
    content: [{ type: "text", text: "Draft ready." }],
    structuredContent: {
      action: "create_manual",
      conversationId: "c1",
      reviewUrl: "https://app.example.com/inbox/c1",
      draft: { draftId: "d1", status: "awaiting_review", revision: 1, subject: "<untrusted_field_ab12>\nRe: pricing\n</untrusted_field_ab12>", text: LEAD_TEXT, truncated: false },
    },
  });
  await expect(view.getByText("Re: pricing")).toBeVisible();
  await expect(view.getByText(LEAD_TEXT)).toBeVisible();
  await expect(view.getByText("awaiting review")).toBeVisible();
  await expect(view.getByText("Nothing has been sent.")).toBeVisible();
  await expect(view.locator("img")).toHaveCount(0);
  await expect(view.getByRole("button")).toHaveCount(1);
  await view.getByRole("button", { name: "Review in MiaSDR" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(["https://app.example.com/inbox/c1"]);
  expect(await page.evaluate(() => (window as unknown as { __hacked?: boolean }).__hacked)).toBeUndefined();
});

test("a card shows a refusal in place of the answer", async ({ page }) => {
  const html = await readCards(page);
  const view = await showCard(page, html, { isError: true, content: [{ type: "text", text: "The draft changed since you opened it." }], structuredContent: { error: { code: "stale_version", message: "The draft changed since you opened it." } } });
  await expect(view.getByText("The draft changed since you opened it.")).toBeVisible();
});
