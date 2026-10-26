import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const delivered = vi.hoisted(() => [{ to: "lead@acme.test" }]);

vi.mock("@/shared/env", () => ({ env: () => ({ MAILBOX_PROVIDER: "fake", LINKEDIN_PROVIDER: "fake" }) }));
vi.mock("@/contexts/outreach/infrastructure/composition", () => ({ mailboxProvider: () => ({ delivered }) }));
vi.mock("@/contexts/outreach/linkedin/infrastructure/linkedin-composition", () => ({ linkedinGateways: () => ({ forOrganization: async () => ({}) }) }));
vi.mock("@/contexts/conversations/infrastructure/composition", () => ({ receiveInboundLinkedIn: vi.fn() }));
vi.mock("@/contexts/identity/infrastructure/e2e-rate-limit", () => ({ resetE2eRateLimits: () => true }));
vi.mock("@/platform/db/client", () => ({ db: {} }));

import { POST } from "./route";

const call = (authorization?: string) =>
  POST(new Request("http://localhost/api/webhooks/dev-fakes", { method: "POST", headers: authorization ? { authorization } : {}, body: JSON.stringify({ action: "delivered" }) }));

describe("/api/webhooks/dev-fakes bearer check", () => {
  beforeEach(() => {
    vi.stubEnv("E2E_FAKE_CONTROLS", "1");
    vi.stubEnv("CRON_SECRET", "cron-secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("answers the job tick's bearer secret", async () => {
    const response = await call("Bearer cron-secret");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(delivered);
  });

  it("answers 404 for a missing or wrong secret", async () => {
    expect((await call()).status).toBe(404);
    expect((await call("Bearer other")).status).toBe(404);
  });

  it("answers 404 to every header when CRON_SECRET is unset", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    for (const header of ["Bearer undefined", "Bearer ", undefined]) expect((await call(header)).status, String(header)).toBe(404);
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(404);
  });
});
