import { describe, expect, it } from "vitest";
import { ask, checkKey, keyForms, VENDOR_KEY } from "./vendor-test-kit";

const inputs = { fullName: "John Doe", companyDomain: "website.com" };
const noKey = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const form of keyForms) expect(json).not.toContain(form);
};

describe("Findymail", () => {
  // https://app.findymail.com/docs/openapi.yaml, read 2026-10-20.
  const find = (status: number, body: unknown) => ask("findymail", status, body, "find-work-email", inputs);

  it("posts name and domain with a bearer key and reads the contact", async () => {
    const { result, seen } = await find(200, { contact: { name: "John Doe", domain: "website.com", email: "john@website.com" } });
    expect(seen[0].url).toBe("https://app.findymail.com/api/search/name");
    expect(seen[0].init.method).toBe("POST");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ name: "John Doe", domain: "website.com" });
    expect((seen[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${VENDOR_KEY}`);
    expect(result).toMatchObject({ outcome: "hit", primary: "john@website.com", outputs: { email: "john@website.com", confidence: null, verificationStatus: "valid" } });
    expect(result).not.toHaveProperty("billable");
    noKey([result.request, result.response]);
  });

  it("reads a missing contact and a 404 as a free miss", async () => {
    expect((await find(200, { contact: null })).result).toMatchObject({ outcome: "miss", billable: false });
    expect((await find(404, { message: "Not found" })).result).toMatchObject({ outcome: "miss", billable: false });
  });

  it("reads the documented errors", async () => {
    expect((await find(402, { error: "Not enough credits" })).result).toMatchObject({ transient: false, message: "Findymail returned 402: Not enough credits The Findymail account is out of credits." });
    expect((await find(423, { error: "Subscription is paused" })).result).toMatchObject({ transient: false });
    expect((await find(401, { message: "Unauthenticated." })).result).toMatchObject({ transient: false, message: "Findymail returned 401: Unauthenticated. Check the Findymail API key." });
    expect((await find(429, { message: "Too Many Attempts." })).result).toMatchObject({ transient: true });
  });

  it("refuses a call without a domain", async () => {
    const { result, seen } = await ask("findymail", 200, {}, "find-work-email", { fullName: "John Doe" });
    expect(result).toMatchObject({ transient: false });
    expect(seen).toHaveLength(0);
  });

  it("checks a key on the credits endpoint", async () => {
    const good = await checkKey("findymail", 200, '{"credits":150,"verifier_credits":100}');
    expect(good.result).toEqual({ ok: true, verified: true });
    expect(good.url).toBe("https://app.findymail.com/api/credits");
    expect(good.init.headers).toMatchObject({ Authorization: `Bearer ${VENDOR_KEY}` });
    expect((await checkKey("findymail", 401, '{"message":"Unauthenticated."}')).result).toEqual({ ok: false, reason: "rejected" });
  });
});

describe("Prospeo", () => {
  // https://prospeo.io/api-docs/enrich-person, read 2026-10-20 (excerpt of the documented answer).
  const docHit = { error: false, free_enrichment: false, person: { full_name: "Eva Kiegler", email: { status: "VERIFIED", revealed: true, email: "eva@intercom.com", verification_method: "BOUNCEBAN", email_mx_provider: "Google" } }, company: { name: "Intercom" } };
  const find = (status: number, body: unknown) => ask("prospeo", status, body, "find-work-email", inputs);

  it("asks for verified emails only with the key in X-KEY", async () => {
    const { result, seen } = await find(200, docHit);
    expect(seen[0].url).toBe("https://api.prospeo.io/enrich-person");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ only_verified_email: true, data: { full_name: "John Doe", company_website: "website.com" } });
    expect((seen[0].init.headers as Record<string, string>)["X-KEY"]).toBe(VENDOR_KEY);
    expect(result).toMatchObject({ outcome: "hit", primary: "eva@intercom.com", outputs: { verificationStatus: "valid" } });
    expect(JSON.stringify(result.response)).not.toContain("Kiegler");
    noKey([result.request, result.response]);
  });

  it("reads NO_MATCH, an unverified email and a free enrichment as free answers", async () => {
    expect((await find(400, { error: true, error_code: "NO_MATCH" })).result).toMatchObject({ outcome: "miss", billable: false });
    const unverified = { ...docHit, person: { email: { status: "UNAVAILABLE", email: null } } };
    expect((await find(200, unverified)).result).toMatchObject({ outcome: "miss", billable: false });
    expect((await find(200, { ...docHit, free_enrichment: true })).result).toMatchObject({ outcome: "hit", billable: false });
  });

  it.each([
    ["INVALID_API_KEY", false, "Check the Prospeo API key."],
    ["INSUFFICIENT_CREDITS", false, "out of credits"],
    ["INVALID_DATAPOINTS", false, "INVALID_DATAPOINTS"],
    ["INTERNAL_ERROR", true, "INTERNAL_ERROR"],
  ])("reads the 400 error code %s", async (code, transient, text) => {
    const { result } = await find(400, { error: true, error_code: code });
    expect(result).toMatchObject({ transient });
    expect(result.message).toContain(text);
  });

  it("retries a 429 after retry-after", async () => {
    const { result } = await ask("prospeo", 429, { error: true }, "find-work-email", inputs, { "content-type": "application/json", "retry-after": "30" });
    expect(result).toMatchObject({ transient: true, retryAfterMs: 30_000 });
  });

  it("checks a key on the free account endpoint", async () => {
    const good = await checkKey("prospeo", 200, '{"error":false,"response":{"current_plan":"STARTER","remaining_credits":99}}');
    expect(good.result).toEqual({ ok: true, verified: true });
    expect(good.url).toBe("https://api.prospeo.io/account-information");
    expect(good.init.headers).toMatchObject({ "X-KEY": VENDOR_KEY });
    expect((await checkKey("prospeo", 400, '{"error":true,"error_code":"INVALID_API_KEY"}')).result).toEqual({ ok: false, reason: "rejected" });
  });
});

describe("LeadMagic", () => {
  // https://leadmagic.io/docs/api-reference/email-finder, read 2026-10-20.
  const docHit = { email: "john.doe@company.com", status: "valid", credits_consumed: 1, message: "Valid email found.", first_name: "John", last_name: "Doe", domain: "company.com", mx_provider: "Google Workspace", employment_verified: true, company_name: "Company Inc" };
  const docNone = { email: null, status: null, credits_consumed: 0, message: "No email found for this person at this company.", first_name: "John", last_name: "Doe", domain: "company.com" };
  const find = (status: number, body: unknown) => ask("leadmagic", status, body, "find-work-email", inputs);

  it("posts full name and domain with the key in X-API-Key", async () => {
    const { result, seen } = await find(200, docHit);
    expect(seen[0].url).toBe("https://api.leadmagic.io/v1/people/email-finder");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ full_name: "John Doe", domain: "website.com" });
    expect((seen[0].init.headers as Record<string, string>)["X-API-Key"]).toBe(VENDOR_KEY);
    expect(result).toMatchObject({ outcome: "hit", primary: "john.doe@company.com", outputs: { verificationStatus: "valid", employmentVerified: true } });
    noKey([result.request, result.response]);
  });

  it("reads the documented no-match as a free miss", async () => {
    expect((await find(200, docNone)).result).toMatchObject({ outcome: "miss", primary: null, billable: false });
  });

  it("reads problem-detail errors", async () => {
    const invalid = { success: false, errors: [{ type: "https://api.leadmagic.io/errors/invalid_api_key", title: "Invalid API key. The key does not exist or is incorrect.", status: 401, code: "invalid_api_key" }] };
    const { result } = await find(401, invalid);
    expect(result).toMatchObject({ transient: false, message: "LeadMagic returned 401: Invalid API key. The key does not exist or is incorrect. Check the LeadMagic API key." });
    expect((await find(402, { success: false, errors: [{ code: "insufficient_credits" }] })).result).toMatchObject({ transient: false });
    expect((await find(504, { success: false, errors: [{ code: "request_timeout" }] })).result).toMatchObject({ transient: true });
  });

  it("checks a key on the credits endpoint", async () => {
    const good = await checkKey("leadmagic", 200, '{"credits":2200}');
    expect(good.result).toEqual({ ok: true, verified: true });
    expect(good.url).toBe("https://api.leadmagic.io/v1/credits");
    expect((await checkKey("leadmagic", 401, "{}")).result).toEqual({ ok: false, reason: "rejected" });
  });
});
