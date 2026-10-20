import { describe, expect, it, vi } from "vitest";
import { assertCredentialVerified, verifyFailureMessage, type VerifyFailure } from "@/contexts/integrations/application/credential-verifier";
import { createEnrichmentVerifier } from "../vendors";

const KEY = "vendor-SECRET-key-0123456789";
const names = { hunter: "Hunter", apollo: "Apollo" } as const;

async function run(vendor: keyof typeof names, fetchStub: typeof fetch) {
  const verifier = createEnrichmentVerifier({ fetch: fetchStub });
  const result = await verifier.verify(vendor, { apiKey: KEY });
  let message = "";
  try {
    await assertCredentialVerified({ verify: async () => result }, { key: vendor, name: names[vendor] }, { apiKey: KEY });
  } catch (error) {
    message = (error as Error).message;
  }
  return { result, message };
}

describe("enrichment vendor key check", () => {
  it.each([
    ["200", 200, null],
    ["401", 401, "rejected"],
    ["403", 403, "rate_limited"],
    ["429", 429, "rate_limited"],
    ["500", 500, "unverifiable"],
  ] as Array<[string, number, VerifyFailure | null]>)("Hunter status %s keeps the key out of the URL", async (_label, status, reason) => {
    const stub = vi.fn(async () => new Response("{}", { status }));
    const { result, message } = await run("hunter", stub as unknown as typeof fetch);
    expect(result).toEqual(reason ? { ok: false, reason } : { ok: true, verified: true });
    expect(message).toBe(reason ? verifyFailureMessage("Hunter", reason) : "");
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.hunter.io/v2/account");
    expect(init.headers).toMatchObject({ "X-API-KEY": KEY });
    expect(init.redirect).toBe("error");
  });

  it.each([
    ["200 logged in", 200, '{"healthy":true,"is_logged_in":true}', null],
    ["200 no flag", 200, "{}", null],
    ["200 HTML page", 200, "<html>Sign in to the network</html>", "unverifiable"],
    ["200 empty body", 200, "", "unverifiable"],
    ["200 JSON null", 200, "null", "unverifiable"],
    ["200 not logged in", 200, '{"healthy":true,"is_logged_in":false}', "rejected"],
    ["401", 401, "Invalid API key", "rejected"],
    ["403", 403, "{}", "rejected"],
    ["429", 429, "{}", "rate_limited"],
    ["500", 500, "{}", "unverifiable"],
  ] as Array<[string, number, string, VerifyFailure | null]>)("Apollo %s keeps the key out of the URL", async (_label, status, body, reason) => {
    const stub = vi.fn(async () => new Response(body, { status }));
    const { result, message } = await run("apollo", stub as unknown as typeof fetch);
    expect(result).toEqual(reason ? { ok: false, reason } : { ok: true, verified: true });
    expect(message).not.toContain(KEY);
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.apollo.io/api/v1/auth/health");
    expect(init.headers).toMatchObject({ "x-api-key": KEY });
    expect(init.method).toBe("GET");
  });

  it("leaves Hunter's body unread", async () => {
    const cancel = vi.fn();
    const stub = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 200 }));
    expect(await createEnrichmentVerifier({ fetch: stub as unknown as typeof fetch }).verify("hunter", { apiKey: KEY })).toEqual({ ok: true, verified: true });
    expect(cancel).toHaveBeenCalled();
  });

  it("makes no call in fake mode, for http and fake providers, or for a key with a line break", async () => {
    const stub = vi.fn(async () => new Response("{}", { status: 500 }));
    const skipping = createEnrichmentVerifier({ fetch: stub as unknown as typeof fetch, skip: () => true });
    expect(await skipping.verify("hunter", { apiKey: KEY })).toEqual({ ok: true, verified: false });
    const verifier = createEnrichmentVerifier({ fetch: stub as unknown as typeof fetch });
    for (const key of ["http", "fake"]) expect(await verifier.verify(key, { apiKey: KEY })).toEqual({ ok: true, verified: false });
    expect(await verifier.verify("hunter", { apiKey: "a\nb" })).toEqual({ ok: false, reason: "rejected" });
    expect(stub).not.toHaveBeenCalled();
  });

  const keys: Array<[string, string]> = [
    ["smart quote", "vendor-“quoted”-0123456789"],
    ["Korean", "vendor-키-0123456789"],
    ["tab", "vendor-\tbad-0123456789"],
    ["DEL", "vendor-\x7fbad-0123456789"],
    ["emoji", "vendor-\u{1F511}-0123456789"],
  ];
  const cases = keys.flatMap(([label, key]) => (["hunter", "apollo"] as const).map((vendor) => [vendor, label, key] as const));

  it.each(cases)("%s with a %s key is rejected without a network call", async (vendor, _label, key) => {
    const stub = vi.fn(async () => new Response("{}", { status: 200 }));
    const verifier = createEnrichmentVerifier({ fetch: stub as unknown as typeof fetch });
    expect(await verifier.verify(vendor, { apiKey: key })).toEqual({ ok: false, reason: "rejected" });
    await expect(assertCredentialVerified(verifier, { key: vendor, name: names[vendor] }, { apiKey: key })).rejects.toThrow(`${names[vendor]} rejected this API key.`);
    expect(stub).not.toHaveBeenCalled();
  });
});
