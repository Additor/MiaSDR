import { describe, expect, it } from "vitest";
import { ProviderError, type ProviderCall, type ProviderRecord } from "../../application/enrichment-ports";
import { HttpAdapter, createAdapterRegistry } from "../enrichment-adapters";
import { VENDORS } from "../vendors";
import { retryAfterMs } from "../vendors/vendor-kit";
import { SIMPLE_ADAPTER_KEYS } from "../../domain/enrichment-catalog";
import { safeRequest } from "../enrichment-http";

const policy = { allowedHosts: ["api.vendor.test"] };
const publicResolver = async () => ["93.184.216.34"];

const config = {
  adapter: "http",
  auth: { type: "header", name: "X-Api-Key" },
  actions: {
    lookup: {
      name: "Lookup",
      method: "GET",
      path: "/people/{{email}}",
      query: { include: "work", company: "{{company}}" },
      inputs: [{ key: "email", name: "Email", type: "email", required: true }, { key: "company", name: "Company", type: "text", required: false }],
      outputs: { title: "data.title", name: "data.name" },
      primaryOutput: "title",
      costCents: 3,
    },
    create: {
      name: "Create",
      method: "POST",
      path: "/people",
      query: {},
      body: { email: "{{email}}", tags: ["{{company}}"] },
      inputs: [{ key: "email", name: "Email", type: "email", required: true }, { key: "company", name: "Company", type: "text", required: false }],
      outputs: { id: "id" },
      primaryOutput: "id",
      costCents: 0,
    },
  },
};

const provider = (over: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id: "p1", key: "vendor", name: "Vendor", baseUrl: "https://api.vendor.test/v1", defaultCostCents: 0, rateLimitPerMin: null, config, enabled: true, hasCredential: true, createdAt: new Date(), updatedAt: new Date(), ...over,
});

const call = (action: string, inputs: Record<string, unknown>, over: Partial<ProviderRecord> = {}): ProviderCall => ({ action, inputs, credentials: { apiKey: "sk-secret-123456" }, provider: provider(over), timeoutMs: 1000 });

function mockFetch(status: number, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: URL, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { fn, seen };
}

describe("generic HTTP adapter", () => {
  it("encodes tokens in the path, sends the key in the configured header, and reads outputs by path", async () => {
    const { fn, seen } = mockFetch(200, { data: { title: "CTO", name: "Ada" } });
    const adapter = new HttpAdapter(policy, { fetch: fn, resolve: publicResolver });
    const answer = await adapter.execute(call("lookup", { email: "a+b@acme.test", company: "Acme & Co" }));
    expect(seen[0].url).toBe("https://api.vendor.test/v1/people/a%2Bb%40acme.test?include=work&company=Acme+%26+Co");
    expect((seen[0].init.headers as Record<string, string>)["X-Api-Key"]).toBe("sk-secret-123456");
    expect(seen[0].init.redirect).toBe("manual");
    expect(answer).toMatchObject({ outcome: "hit", primary: "CTO", outputs: { title: "CTO", name: "Ada" }, costCents: 3 });
    // The audit request carries the URL without the key.
    expect(JSON.stringify(answer.request)).not.toContain("sk-secret");
  });

  it("reports a miss when the primary output is empty", async () => {
    const { fn } = mockFetch(200, { data: { title: "" } });
    const answer = await new HttpAdapter(policy, { fetch: fn, resolve: publicResolver }).execute(call("lookup", { email: "a@acme.test" }));
    expect(answer.outcome).toBe("miss");
  });

  it("sends a POST body with typed leaves and never templates keys", async () => {
    const { fn, seen } = mockFetch(200, { id: "42" });
    await new HttpAdapter(policy, { fetch: fn, resolve: publicResolver }).execute(call("create", { email: "a@acme.test", company: "Acme" }));
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ email: "a@acme.test", tags: ["Acme"] });
  });

  it("classifies statuses: 4xx permanent, 429 and 5xx transient for GET", async () => {
    const run = async (status: number, action = "lookup") => {
      const { fn } = mockFetch(status, { error: "nope" });
      return new HttpAdapter(policy, { fetch: fn, resolve: publicResolver }).execute(call(action, { email: "a@acme.test" })).catch((e) => e);
    };
    expect(await run(401)).toMatchObject({ transient: false });
    expect(await run(404)).toMatchObject({ transient: false });
    expect(await run(429)).toMatchObject({ transient: true });
    expect(await run(503)).toMatchObject({ transient: true });
    // A POST that failed with a 5xx may have taken effect, so it is not retried.
    expect(await run(503, "create")).toMatchObject({ transient: false });
  });

  it("refuses a base URL that is no longer on the allow-list", async () => {
    const { fn, seen } = mockFetch(200, {});
    const error = await new HttpAdapter({ allowedHosts: [] }, { fetch: fn, resolve: publicResolver }).execute(call("lookup", { email: "a@acme.test" })).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.message).toMatch(/not allowed/);
    expect(seen).toHaveLength(0);
  });

  it("refuses a host that resolves to a private address, even on the allow-list", async () => {
    const { fn, seen } = mockFetch(200, {});
    for (const address of ["169.254.169.254", "10.0.0.5", "127.0.0.1", "::1", "::ffff:192.168.0.1"]) {
      const error = await new HttpAdapter(policy, { fetch: fn, resolve: async () => ["93.184.216.34", address] }).execute(call("lookup", { email: "a@acme.test" })).catch((e) => e);
      expect(error).toMatchObject({ transient: false });
      expect(error.message).toMatch(/private or internal/);
    }
    expect(seen).toHaveLength(0);
  });

  it("does not follow redirects, so a 302 to the metadata address goes nowhere", async () => {
    const { fn, seen } = mockFetch(302, "", { location: "http://169.254.169.254/latest/meta-data" });
    const error = await new HttpAdapter(policy, { fetch: fn, resolve: publicResolver }).execute(call("lookup", { email: "a@acme.test" })).catch((e) => e);
    expect(error.message).toMatch(/redirect/i);
    expect(seen).toHaveLength(1);
  });

  it("rejects dot-segment inputs that would climb out of the base path", async () => {
    const { fn, seen } = mockFetch(200, {});
    const error = await new HttpAdapter(policy, { fetch: fn, resolve: publicResolver }).execute(call("lookup", { email: ".." })).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(seen).toHaveLength(0);
  });

  it("needs a key when auth is configured", async () => {
    const { fn } = mockFetch(200, {});
    const error = await new HttpAdapter(policy, { fetch: fn, resolve: publicResolver }).execute({ ...call("lookup", { email: "a@acme.test" }), credentials: {} }).catch((e) => e);
    expect(error.message).toMatch(/API key/);
  });
});

describe("safeRequest", () => {
  it("refuses plain http and non-loopback IP literals", async () => {
    await expect(safeRequest(new URL("http://api.vendor.test/"), { method: "GET", headers: {} }, 100)).rejects.toThrow(/https/);
    await expect(safeRequest(new URL("https://169.254.169.254/"), { method: "GET", headers: {} }, 100, { fetch: mockFetch(200, {}).fn })).rejects.toThrow(/private/);
    await expect(safeRequest(new URL("http://127.0.0.1:1/"), { method: "GET", headers: {} }, 100, { fetch: mockFetch(200, {}).fn })).rejects.toThrow(/https/);
  });

  it("lets loopback through only when the caller opts in (tests)", async () => {
    const res = await safeRequest(new URL("http://127.0.0.1:1/"), { method: "GET", headers: {} }, 100, { allowLoopback: true, fetch: mockFetch(200, { ok: true }).fn });
    expect(res.status).toBe(200);
  });
});

describe("Hunter adapter", () => {
  const hunter = (fn: typeof fetch) => createAdapterRegistry({ policy, net: { fetch: fn, resolve: publicResolver } }).adapterFor(provider({ config: { adapter: "hunter" } }))!;
  const hunterCall = (action: string, inputs: Record<string, unknown>): ProviderCall => ({ action, inputs, credentials: { apiKey: "hunter-key-987654" }, provider: provider({ key: "hunter", config: { adapter: "hunter" }, baseUrl: "https://api.hunter.io" }), timeoutMs: 1000 });

  it("finds a work email and sends the key in a header, not the URL", async () => {
    const { fn, seen } = mockFetch(200, { data: { email: "ada@acme.com", score: 91, verification: { status: "valid" }, position: "CTO" } });
    const answer = await hunter(fn).execute(hunterCall("find-work-email", { fullName: "Ada Lovelace", companyDomain: "acme.com" }));
    expect(seen[0].url).toBe("https://api.hunter.io/v2/email-finder?domain=acme.com&full_name=Ada+Lovelace");
    expect((seen[0].init.headers as Record<string, string>)["X-API-KEY"]).toBe("hunter-key-987654");
    expect(answer).toMatchObject({ outcome: "hit", primary: "ada@acme.com", outputs: { score: 91, verificationStatus: "valid" } });
  });

  it("answers a miss when Hunter finds nothing", async () => {
    const { fn } = mockFetch(200, { data: { email: null } });
    expect((await hunter(fn).execute(hunterCall("find-work-email", { fullName: "Nobody", companyDomain: "acme.com" }))).outcome).toBe("miss");
  });

  it("treats 202 and 429 as retryable and 401 as permanent", async () => {
    const run = async (status: number) => hunter(mockFetch(status, { errors: [{ details: "x" }] }).fn).execute(hunterCall("verify-email", { email: "a@acme.com" })).catch((e) => e);
    expect(await run(202)).toMatchObject({ transient: true, message: "Hunter is still verifying this address. It will be asked again." });
    expect(await run(429)).toMatchObject({ transient: true });
    expect(await run(401)).toMatchObject({ transient: false, message: "Hunter returned 401: x" });
    expect(await run(403)).toMatchObject({ transient: true });
    // 222 is inside the 2xx range, so it reads as an empty answer today.
    expect(await run(222)).toMatchObject({ outcome: "miss", primary: null });
  });

  it("verifies an email and maps Hunter's fields", async () => {
    const { fn, seen } = mockFetch(200, { data: { email: "ada@acme.com", status: "valid", score: 97, accept_all: false, disposable: false, webmail: false } });
    const answer = await hunter(fn).execute(hunterCall("verify-email", { email: "ada@acme.com" }));
    expect(seen[0].url).toBe("https://api.hunter.io/v2/email-verifier?email=ada%40acme.com");
    expect(answer).toMatchObject({ outcome: "hit", primary: "valid", outputs: { email: "ada@acme.com", status: "valid", score: 97, acceptAll: false, disposable: false, webmail: false } });
  });

  it("finds emails by company domain with a limit of ten", async () => {
    const { fn, seen } = mockFetch(200, { data: { emails: [{ value: "ada@acme.com" }, { value: "bob@acme.com" }], organization: "Acme", pattern: "{first}" } });
    const answer = await hunter(fn).execute(hunterCall("find-emails-by-company", { companyDomain: "acme.com" }));
    expect(seen[0].url).toBe("https://api.hunter.io/v2/domain-search?domain=acme.com&limit=10");
    expect(answer).toMatchObject({ outcome: "hit", primary: "ada@acme.com", outputs: { emailCount: 2, firstEmail: "ada@acme.com", organization: "Acme", pattern: "{first}" } });
  });

  it("records the request as method, endpoint and input keys, and fills missing outputs with null", async () => {
    const { fn } = mockFetch(200, { data: { email: "ada@acme.com" } });
    const answer = await hunter(fn).execute(hunterCall("find-work-email", { fullName: "Ada Lovelace", companyDomain: "acme.com" }));
    expect(answer.request).toEqual({ method: "GET", endpoint: "/v2/email-finder", inputKeys: ["fullName", "companyDomain"] });
    expect(answer.outputs).toEqual({ email: "ada@acme.com", score: null, verificationStatus: null, position: null, linkedinUrl: null });
  });

  it("refuses a missing key and an unknown action without a call", async () => {
    const { fn, seen } = mockFetch(200, {});
    const noKey = await hunter(fn).execute({ ...hunterCall("verify-email", { email: "a@acme.com" }), credentials: {} }).catch((e) => e);
    expect(noKey).toMatchObject({ transient: false, message: "The Hunter API key is missing." });
    const unknown = await hunter(fn).execute(hunterCall("guess", {})).catch((e) => e);
    expect(unknown).toMatchObject({ transient: false, message: "Unknown Hunter action: guess" });
    expect(seen).toHaveLength(0);
  });
});

describe("Apollo adapter", () => {
  const apollo = (fn: typeof fetch) => createAdapterRegistry({ policy, net: { fetch: fn, resolve: publicResolver } }).adapterFor(provider({ config: { adapter: "apollo" } }))!;
  const apolloCall = (action: string, inputs: Record<string, unknown>): ProviderCall => ({ action, inputs, credentials: { apiKey: "apollo-key-987654" }, provider: provider({ key: "apollo", config: { adapter: "apollo" }, baseUrl: "https://api.apollo.io" }), timeoutMs: 1000 });
  const person = { person: { email: "ada@acme.com", email_status: "verified", title: "CTO", linkedin_url: "https://www.linkedin.com/in/ada", match_confidence: "high", organization: { name: "Acme" } } };

  it("matches a person by name and domain with the key in a header and no reveal flags", async () => {
    const { fn, seen } = mockFetch(200, person);
    const answer = await apollo(fn).execute(apolloCall("enrich-person", { fullName: "Ada Lovelace", companyDomain: "acme.com" }));
    expect(seen[0].url).toBe("https://api.apollo.io/api/v1/people/match?name=Ada+Lovelace&domain=acme.com");
    expect(seen[0].init.method).toBe("POST");
    expect((seen[0].init.headers as Record<string, string>)["x-api-key"]).toBe("apollo-key-987654");
    expect(seen[0].url).not.toContain("apollo-key");
    expect(seen[0].url).not.toContain("reveal_");
    expect(JSON.stringify(answer.request)).not.toContain("apollo-key");
    expect(answer).toMatchObject({ outcome: "hit", primary: "ada@acme.com", outputs: { emailStatus: "verified", title: "CTO", company: "Acme", linkedinUrl: "https://www.linkedin.com/in/ada", matchConfidence: "high" } });
  });

  it("matches by email or LinkedIn URL alone and refuses a name without a domain", async () => {
    const { fn, seen } = mockFetch(200, person);
    await apollo(fn).execute(apolloCall("enrich-person", { email: "ada@acme.com" }));
    await apollo(fn).execute(apolloCall("enrich-person", { linkedinUrl: "https://www.linkedin.com/in/ada" }));
    expect(seen[0].url).toBe("https://api.apollo.io/api/v1/people/match?email=ada%40acme.com");
    expect(seen[1].url).toBe("https://api.apollo.io/api/v1/people/match?linkedin_url=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fada");
    const error = await apollo(fn).execute(apolloCall("enrich-person", { fullName: "Ada Lovelace" })).catch((e) => e);
    expect(error).toMatchObject({ transient: false });
    expect(seen).toHaveLength(2);
  });

  it("answers a miss for match_confidence none and for an empty person", async () => {
    const none = await apollo(mockFetch(200, { person: { ...person.person, match_confidence: "none" } }).fn).execute(apolloCall("enrich-person", { email: "a@acme.com" }));
    expect(none).toMatchObject({ outcome: "miss", primary: null, outputs: { email: null, matchConfidence: "none" } });
    expect((await apollo(mockFetch(200, { person: null }).fn).execute(apolloCall("enrich-person", { email: "a@acme.com" }))).outcome).toBe("miss");
  });

  it("enriches a company by domain", async () => {
    const { fn, seen } = mockFetch(200, { organization: { name: "Acme", industry: "software", estimated_num_employees: 120, website_url: "http://acme.com", linkedin_url: "https://www.linkedin.com/company/acme", city: "Berlin", country: "Germany" } });
    const answer = await apollo(fn).execute(apolloCall("enrich-company", { companyDomain: "acme.com" }));
    expect(seen[0].url).toBe("https://api.apollo.io/api/v1/organizations/enrich?domain=acme.com");
    expect(seen[0].init.method).toBe("GET");
    expect(answer).toMatchObject({ outcome: "hit", primary: "Acme", outputs: { industry: "software", employeeCount: 120, city: "Berlin" } });
  });

  it("classifies statuses: 401, 403, 422 permanent; 429, 500 transient; 429 carries retry-after", async () => {
    const run = async (status: number, headers: Record<string, string> = { "content-type": "application/json" }) =>
      apollo(mockFetch(status, { error: "nope" }, headers).fn).execute(apolloCall("enrich-company", { companyDomain: "acme.com" })).catch((e) => e);
    expect(await run(401)).toMatchObject({ transient: false });
    expect(await run(403)).toMatchObject({ transient: false });
    expect(await run(422)).toMatchObject({ transient: false });
    expect(await run(404)).toMatchObject({ transient: false });
    expect(await run(500)).toMatchObject({ transient: true });
    expect(await run(429, { "content-type": "application/json", "retry-after": "45" })).toMatchObject({ transient: true, retryAfterMs: 45_000 });
    expect(await run(429)).toMatchObject({ transient: true, retryAfterMs: 60_000 });
    expect((await run(401)).message).not.toContain("apollo-key");
  });

  it("trims inputs, sends Accept and Cache-Control, and records the request without the key", async () => {
    const { fn, seen } = mockFetch(200, person);
    const answer = await apollo(fn).execute(apolloCall("enrich-person", { email: "  ada@acme.com  " }));
    expect(seen[0].url).toBe("https://api.apollo.io/api/v1/people/match?email=ada%40acme.com");
    expect(seen[0].init.headers).toMatchObject({ Accept: "application/json", "Cache-Control": "no-cache" });
    expect(answer.request).toEqual({ method: "POST", endpoint: "/api/v1/people/match", inputKeys: ["email"] });
  });

  it("fills missing company fields with null", async () => {
    const answer = await apollo(mockFetch(200, { organization: { name: "Acme" } }).fn).execute(apolloCall("enrich-company", { companyDomain: "acme.com" }));
    expect(answer.outputs).toEqual({ name: "Acme", industry: null, employeeCount: null, websiteUrl: null, linkedinUrl: null, city: null, country: null });
  });

  it("refuses a company lookup without a domain and an unknown action, without a call", async () => {
    const { fn, seen } = mockFetch(200, {});
    expect(await apollo(fn).execute(apolloCall("enrich-company", { companyDomain: "  " })).catch((e) => e)).toMatchObject({ transient: false, message: "Apollo needs a company domain." });
    expect(await apollo(fn).execute(apolloCall("guess", {})).catch((e) => e)).toMatchObject({ transient: false, message: "Unknown Apollo action: guess" });
    expect(await apollo(fn).execute({ ...apolloCall("enrich-company", { companyDomain: "acme.com" }), credentials: {} }).catch((e) => e)).toMatchObject({ message: "The Apollo API key is missing." });
    expect(seen).toHaveLength(0);
  });

  it("asks to check the key on 401 and 403", async () => {
    const error = await apollo(mockFetch(401, { error: "Invalid access credentials." }).fn).execute(apolloCall("enrich-company", { companyDomain: "acme.com" })).catch((e) => e);
    expect(error.message).toBe("Apollo returned 401: Invalid access credentials. Check the Apollo API key.");
  });

  it("reads retry-after seconds with a one hour cap", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs("999999")).toBe(3_600_000);
    expect(retryAfterMs("soon")).toBe(60_000);
    expect(retryAfterMs(null)).toBe(60_000);
  });
});

describe("adapter registry", () => {
  it("serves every native vendor in the catalog and nothing else", () => {
    const registry = createAdapterRegistry({ policy });
    const native = SIMPLE_ADAPTER_KEYS.filter((k) => k !== "fake");
    expect(VENDORS.map((v) => v.key).sort()).toEqual([...native].sort());
    for (const key of native) expect(registry.adapterFor(provider({ config: { adapter: key } }))?.adapter).toBe(key);
    expect(registry.adapterFor(provider({ config: { adapter: "zerobounce-legacy" } }))).toBeNull();
    // Without an instance the fake adapter stays off.
    expect(registry.adapterFor(provider({ config: { adapter: "fake" } }))).toBeNull();
  });
});
