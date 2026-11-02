import { createHash, randomBytes } from "node:crypto";
import type { APIRequestContext, Page, Route } from "@playwright/test";
import { ADMIN, expect, signInAdmin, test, waitForHydrated } from "./support/fixtures";

const REDIRECT = "http://127.0.0.1:54399/callback";

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** Runs an MCP request with a bearer token, as a client on the 2026-07-28 protocol. */
function callMcp(request: APIRequestContext, token: string) {
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
  return request.post("/api/mcp", {
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } },
  });
}

/** Discovers the server the way a client does, starting from the 401, and registers itself. */
async function discoverAndRegister(request: APIRequestContext, baseURL: string) {
  const challenge = await request.post("/api/mcp", { headers: { accept: "application/json, text/event-stream" }, data: {} });
  expect(challenge.status()).toBe(401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers()["www-authenticate"])?.[1] as string;
  expect(metadataUrl).toBe(`${baseURL}/.well-known/oauth-protected-resource/api/mcp`);
  const resource = (await (await request.get(metadataUrl)).json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
  expect(resource.resource).toBe(`${baseURL}/api/mcp`);
  expect(resource.scopes_supported).toEqual(["mcp:read", "mcp:write", "mcp:send", "mcp:spend", "mcp:irreversible"]);
  const issuer = new URL(resource.authorization_servers[0]);
  const server = (await (await request.get(`${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`)).json()) as Record<string, string | string[]>;
  expect(server.code_challenge_methods_supported).toEqual(["S256"]);
  expect(server.dpop_signing_alg_values_supported).toBeUndefined();
  const registered = await request.post(server.registration_endpoint as string, {
    data: { client_name: "E2E Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: "mcp:read mcp:write mcp:send offline_access" },
  });
  expect(registered.status(), await registered.text()).toBeLessThan(300);
  return { server, resource: resource.resource, clientId: ((await registered.json()) as { client_id: string }).client_id };
}

/** Sends the browser to the authorize URL and answers the redirect back to the client with its code. */
async function authorizeUrl(flow: Awaited<ReturnType<typeof discoverAndRegister>>, scope = "mcp:read mcp:write mcp:send offline_access") {
  const verifier = base64url(randomBytes(32));
  const url = new URL(flow.server.authorization_endpoint as string);
  const state = base64url(randomBytes(8));
  url.search = new URLSearchParams({ response_type: "code", client_id: flow.clientId, redirect_uri: REDIRECT, scope, state, resource: flow.resource, code_challenge: base64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256" }).toString();
  return { url: url.toString(), verifier, state };
}

function captureCode(page: Page) {
  return new Promise<URL>((resolve) => {
    void page.route("http://127.0.0.1:54399/**", async (route) => {
      resolve(new URL(route.request().url()));
      await route.fulfill({ status: 200, contentType: "text/html", body: "<title>Back in the app</title>" });
    });
  });
}

async function redeem(request: APIRequestContext, flow: Awaited<ReturnType<typeof discoverAndRegister>>, code: string, verifier: string) {
  const response = await request.post(flow.server.token_endpoint as string, { form: { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: flow.clientId, code_verifier: verifier, resource: flow.resource } });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as { access_token: string; refresh_token: string; scope: string };
}

async function turnOnMcp(page: Page) {
  await page.goto("/settings/mcp");
  await expect(page.getByRole("button", { name: /^Turn (on|off) MCP$/ })).toBeVisible();
  if (await page.getByText("MCP is off.").isVisible()) {
    await page.getByRole("button", { name: "Turn on MCP" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
  await expect(page.getByText("MCP is on.")).toBeVisible();
}

test("an app connects over OAuth, works, refreshes, and stops at once when a person disconnects it", async ({ page, request, baseURL }) => {
  await signInAdmin(page);
  await turnOnMcp(page);
  // `request` holds no session: the app talks to the server as an outside client does.
  const flow = await discoverAndRegister(request, baseURL as string);

  const first = await authorizeUrl(flow);
  const back = captureCode(page);
  await page.goto(first.url);
  await expect(page.getByRole("heading", { name: "Connect E2E Agent?" })).toBeVisible();
  await expect(page.getByText("This app registered itself")).toBeVisible();
  // Sending is off here, so the app cannot get it though it asked. Making changes is the first choice.
  await expect(page.getByRole("radio", { name: /Read, make changes and send/ })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Read and make changes/ })).toBeChecked();
  await page.getByRole("button", { name: "Connect" }).click();
  const callback = await back;
  expect(callback.searchParams.get("state")).toBe(first.state);

  const tokens = await redeem(request, flow, callback.searchParams.get("code") as string, first.verifier);
  expect(tokens.scope.split(" ").sort()).toEqual(["mcp:read", "mcp:write", "offline_access"]);
  const list = await callMcp(request, tokens.access_token);
  expect(list.status(), await list.text()).toBe(200);
  expect(await list.text()).toContain("write_reply_draft");
  expect(await list.text()).not.toContain("send_reply");

  const refreshed = await request.post(flow.server.token_endpoint as string, { form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: flow.clientId, resource: flow.resource } });
  expect(refreshed.status(), await refreshed.text()).toBe(200);
  const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
  expect((await callMcp(request, next.access_token)).status()).toBe(200);

  await page.goto("/settings/mcp");
  const apps = page.getByRole("list", { name: "Connected apps" });
  const row = apps.getByRole("listitem").filter({ hasText: "E2E Agent" });
  await expect(row).toContainText("Makes changes");
  await row.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(row).toBeHidden();

  // The unexpired token stops now, its refresh token is gone, and connecting again asks the person again.
  expect((await callMcp(request, next.access_token)).status()).toBe(401);
  const dead = await request.post(flow.server.token_endpoint as string, { form: { grant_type: "refresh_token", refresh_token: next.refresh_token, client_id: flow.clientId, resource: flow.resource } });
  expect(dead.status()).toBeGreaterThanOrEqual(400);
  const again = await authorizeUrl(flow);
  await page.goto(again.url);
  await expect(page.getByRole("heading", { name: "Connect E2E Agent?" })).toBeVisible();
  await page.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => page.url()).toContain("error=access_denied");
  await page.goto("/settings/mcp");
  await page.getByRole("button", { name: "Turn off MCP" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("MCP is off.")).toBeVisible();
});

test("sending is offered where the organization allows it, and a person has to choose it", async ({ page, request, baseURL }) => {
  await signInAdmin(page);
  await turnOnMcp(page);
  await page.goto("/settings/organization");
  const card = page.getByRole("region", { name: "Agents can send" });
  await card.getByRole("radio", { name: "Replies", exact: true }).click();
  await card.getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Let agents send" }).click();
  await expect(page.getByText("Agent sending saved.")).toBeVisible();

  const flow = await discoverAndRegister(request, baseURL as string);
  const { url, verifier } = await authorizeUrl(flow);
  const back = captureCode(page);
  await page.goto(url);
  await expect(page.getByRole("radio", { name: /Read and make changes/ })).toBeChecked();
  const send = page.getByRole("radio", { name: /Read, make changes and send/ });
  await expect(send).not.toBeChecked();
  await send.click();
  await page.getByRole("button", { name: "Connect" }).click();
  const tokens = await redeem(request, flow, (await back).searchParams.get("code") as string, verifier);
  expect(await (await callMcp(request, tokens.access_token)).text()).toContain("send_reply");

  await page.goto("/settings/organization");
  await card.getByRole("radio", { name: "Off", exact: true }).click();
  await card.getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Stop agent sending" }).click();
  await expect(page.getByText("Agent sending saved.")).toBeVisible();
  // The grant keeps working without sending, as a token does.
  expect(await (await callMcp(request, tokens.access_token)).text()).not.toContain("send_reply");
  await page.goto("/settings/mcp");
  await page.getByRole("button", { name: "Turn off MCP" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("MCP is off.")).toBeVisible();
});

test("a person who is not signed in signs in on the way to the consent page", async ({ browser, page, request, baseURL }) => {
  await signInAdmin(page);
  await turnOnMcp(page);
  const flow = await discoverAndRegister(request, baseURL as string);
  const context = await browser.newContext({ baseURL });
  const fresh = await context.newPage();
  const { url } = await authorizeUrl(flow);
  await fresh.goto(url);
  await expect(fresh).toHaveURL(/\/sign-in\?/);
  await fresh.getByLabel("Email").fill(ADMIN.email);
  await fresh.getByLabel("Password").fill(ADMIN.password);
  await fresh.getByRole("button", { name: /^Sign in$/ }).click();
  await expect(fresh.getByRole("heading", { name: "Connect E2E Agent?" })).toBeVisible();
  await context.close();
  await page.goto("/settings/mcp");
  await page.getByRole("button", { name: "Turn off MCP" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("MCP is off.")).toBeVisible();
});

test("an edited consent request cannot grant more than the app asked for", async ({ page, request, baseURL, watch }) => {
  watch.tolerate(/response 403: POST .*\/api\/oauth\/consent/, /Failed to load resource.*403/);
  await signInAdmin(page);
  await turnOnMcp(page);
  const flow = await discoverAndRegister(request, baseURL as string);
  const { url, verifier } = await authorizeUrl(flow, "mcp:read offline_access");
  await page.goto(url);
  await expect(page.getByRole("radio", { name: /Read and make changes/ })).toHaveCount(0);
  // The page's own request goes out with more access than the page offered.
  const tamper = (access: string) => async (route: Route) => route.continue({ postData: JSON.stringify({ ...(route.request().postDataJSON() as object), access }) });
  for (const access of ["write", "send"]) {
    await page.route("**/api/oauth/consent", tamper(access));
    const refused = page.waitForResponse("**/api/oauth/consent");
    await page.getByRole("button", { name: "Connect" }).click();
    expect((await refused).status()).toBe(403);
    await page.unrouteAll();
  }

  const back = captureCode(page);
  await page.getByRole("button", { name: "Connect" }).click();
  const tokens = await redeem(request, flow, (await back).searchParams.get("code") as string, verifier);
  expect(tokens.scope.split(" ").sort()).toEqual(["mcp:read", "offline_access"]);
  await page.goto("/settings/mcp");
  await page.getByRole("button", { name: "Turn off MCP" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("MCP is off.")).toBeVisible();
});

test("an app gets spending and irreversible actions only when a person ticks them", async ({ page, request, baseURL }) => {
  await signInAdmin(page);
  await turnOnMcp(page);
  await page.goto("/settings/organization");
  const card = page.getByRole("region", { name: "Agents can spend and delete" });
  await waitForHydrated(card.getByRole("button", { name: "Save" }));
  await card.getByLabel("Actions agents cannot undo, per day").fill("3");
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/settings/mcp") && r.request().method() === "PATCH");
  await card.getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save limits" }).click();
  expect((await saved).status()).toBe(200);

  const flow = await discoverAndRegister(request, baseURL as string);
  const all = "mcp:read mcp:write mcp:send mcp:spend mcp:irreversible offline_access";
  const first = await authorizeUrl(flow, all);
  const back = captureCode(page);
  await page.goto(first.url);
  await waitForHydrated(page.getByRole("button", { name: "Connect" }));
  // Spending has no limit here, so it is not offered. The other starts unticked and goes unless a person ticks it.
  await expect(page.getByLabel(/^Spend on enrichment/)).toHaveCount(0);
  const tick = page.getByRole("checkbox", { name: /Complete campaigns and delete records/ });
  await expect(tick).not.toBeChecked();
  await tick.click();
  await page.getByRole("button", { name: "Connect" }).click();
  const tokens = await redeem(request, flow, (await back).searchParams.get("code") as string, first.verifier);
  expect(tokens.scope.split(" ").sort()).toEqual(["mcp:irreversible", "mcp:read", "mcp:write", "offline_access"]);

  await page.unrouteAll();
  await page.goto("/settings/organization");
  await waitForHydrated(card.getByRole("button", { name: "Save" }));
  await card.getByLabel("Actions agents cannot undo, per day").fill("0");
  const zero = page.waitForResponse((r) => r.url().endsWith("/api/settings/mcp") && r.request().method() === "PATCH");
  await card.getByRole("button", { name: "Save" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Save limits" }).click();
  expect((await zero).status()).toBe(200);
  await page.goto("/settings/mcp");
  await page.getByRole("button", { name: "Turn off MCP" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Turn off" }).click();
  await expect(page.getByText("MCP is off.")).toBeVisible();
});
