import { request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { ADMIN, cronSecret, ensureMailbox, expect, test } from "./support/fixtures";

/**
 * M3: the test-only routes stay 404 in the production image.
 *
 * The runner builds a second copy of the app with the Dockerfile's build flags (no E2E_BUILD), starts it with
 * the Dockerfile's runner ENV (NODE_ENV=production) and sets every runtime helper variable to "on":
 * E2E_DEV_HELPERS=1, E2E_FAKE_CONTROLS=1, fake providers and a valid CRON_SECRET. The routes must still answer 404.
 * The same requests against the test build answer 200, so the check can tell the two apart.
 * src/architecture/dockerfile.test.ts keeps the Dockerfile's build flags free of E2E_ switches.
 */
const prodUrl = process.env.E2E_PROD_URL ?? "";
const prodSecret = process.env.E2E_PROD_CRON_SECRET ?? "";

async function signedIn(baseURL: string): Promise<APIRequestContext> {
  const api = await playwrightRequest.newContext({ baseURL });
  const setup = await api.post("/api/setup", { data: { name: ADMIN.name, email: ADMIN.email, password: ADMIN.password, organizationName: ADMIN.organization, timeZone: "UTC" } });
  expect([201, 409]).toContain(setup.status());
  const login = await api.post("/api/auth/sign-in/email", { data: { email: ADMIN.email, password: ADMIN.password } });
  expect(login.status(), "sign in").toBe(200);
  return api;
}

const inboundBody = { mailbox: "sdr@e2e-corp.test", fromEmail: "lead@example.test", subject: "Re: hi", bodyText: "hello" };

test.describe("the production image keeps the test routes off", () => {
  test("/api/dev/inbound is 404 with a session and every runtime helper variable on", async () => {
    expect(prodUrl, "E2E_PROD_URL").not.toBe("");
    const api = await signedIn(prodUrl);
    const res = await api.post("/api/dev/inbound", { data: inboundBody });
    expect(res.status()).toBe(404);
    await api.dispose();
  });

  test("/api/webhooks/dev-fakes is 404 with the valid bearer secret and every runtime helper variable on", async () => {
    const api = await playwrightRequest.newContext({ baseURL: prodUrl });
    // The secret is valid: the job tick on the same server accepts it.
    const tick = await api.post("/api/jobs/tick", { headers: { authorization: `Bearer ${prodSecret}` } });
    expect(tick.status(), "the secret is accepted by the job tick").toBe(200);
    for (const action of ["delivered", "liState", "mailBehavior", "resetRateLimits"]) {
      const res = await api.post("/api/webhooks/dev-fakes", { headers: { authorization: `Bearer ${prodSecret}` }, data: { action, mode: "ok" } });
      expect(res.status(), action).toBe(404);
    }
    await api.dispose();
  });

  test("the same requests work on the test build, so the check can fail", async ({ request, baseURL }) => {
    expect(baseURL).not.toBe(prodUrl);
    const api = await signedIn(baseURL ?? "");
    await ensureMailbox(api, inboundBody.mailbox);
    expect((await api.post("/api/dev/inbound", { data: inboundBody })).status()).toBe(200);
    await api.dispose();
    const fakes = await request.post("/api/webhooks/dev-fakes", { headers: { authorization: `Bearer ${cronSecret()}` }, data: { action: "delivered" } });
    expect(fakes.status()).toBe(200);
  });
});
