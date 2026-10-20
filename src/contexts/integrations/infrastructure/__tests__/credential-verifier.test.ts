import { describe, expect, it, vi } from "vitest";
import { assertCredentialVerified, verifyFailureMessage, type VerifyFailure } from "../../application/credential-verifier";
import { createCredentialVerifier } from "../credential-verifier";

const KEY = "sk-ant-SECRET-key-0123456789";
const respond = (status: number) => vi.fn(async () => new Response("{}", { status }));
const names = { anthropic: "Anthropic" } as const;

async function run(providerKey: "anthropic", fetchStub: typeof fetch, extra: { timeoutMs?: number } = {}) {
  const verifier = createCredentialVerifier({ fetch: fetchStub, ...extra });
  const result = await verifier.verify(providerKey, { apiKey: KEY });
  let message = "";
  try {
    await assertCredentialVerified({ verify: async () => result }, { key: providerKey, name: names[providerKey] }, { apiKey: KEY });
  } catch (error) {
    message = (error as Error).message;
  }
  return { result, message };
}

describe("credential verifier", () => {
  const table: Array<[string, number, VerifyFailure | null]> = [
    ["200", 200, null],
    ["401", 401, "rejected"],
    ["403", 403, "rejected"],
    ["429", 429, "rate_limited"],
    ["500", 500, "unverifiable"],
    ["404", 404, "unverifiable"],
  ];

  it.each(table)("Anthropic status %s", async (_label, status, reason) => {
    const stub = respond(status);
    const { result, message } = await run("anthropic", stub as unknown as typeof fetch);
    expect(result).toEqual(reason ? { ok: false, reason } : { ok: true, verified: true });
    expect(message).toBe(reason ? verifyFailureMessage("Anthropic", reason) : "");
    expect(message).not.toContain(KEY);
    const [url, init] = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect(init.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01" });
    expect(init.method).toBe("GET");
  });

  it("maps a network error to unreachable without leaking the error text", async () => {
    const stub = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED while sending ${KEY}`);
    });
    const { result, message } = await run("anthropic", stub as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "unreachable" });
    expect(message).toBe("Anthropic could not be reached. Check your connection and try again.");
    expect(message).not.toContain(KEY);
  });

  it("maps a timeout to unreachable", async () => {
    const stub = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const { result } = await run("anthropic", stub as unknown as typeof fetch, { timeoutMs: 20 });
    expect(result).toEqual({ ok: false, reason: "unreachable" });
  });

  it("maps a caller abort to unreachable", async () => {
    const controller = new AbortController();
    const stub = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const pending = createCredentialVerifier({ fetch: stub as unknown as typeof fetch }).verify("anthropic", { apiKey: KEY }, { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: "unreachable" });
  });

  it("uses all four fixed texts", () => {
    expect(verifyFailureMessage("X", "unreachable")).toBe("X could not be reached. Check your connection and try again.");
    expect(verifyFailureMessage("X", "rejected")).toBe("X rejected this API key.");
    expect(verifyFailureMessage("X", "rate_limited")).toBe("X rate-limited verification. Try again shortly.");
    expect(verifyFailureMessage("X", "unverifiable")).toBe("X could not verify this account right now. Try again shortly.");
  });

  it("makes no call for skipped providers or any key but Anthropic's", async () => {
    const stub = respond(500);
    const verifier = createCredentialVerifier({ fetch: stub as unknown as typeof fetch, skip: (key) => key === "anthropic" });
    // Enrichment vendor keys are checked in the grid context.
    for (const key of ["anthropic", "hunter", "apollo", "http", "fake", "other"]) expect(await verifier.verify(key, { apiKey: KEY })).toEqual({ ok: true, verified: false });
    expect(stub).not.toHaveBeenCalled();
  });

  it("marks a live check verified and returns it from assertCredentialVerified", async () => {
    const verifier = createCredentialVerifier({ fetch: respond(200) as unknown as typeof fetch });
    expect(await verifier.verify("anthropic", { apiKey: KEY })).toEqual({ ok: true, verified: true });
    expect(await assertCredentialVerified(verifier, { key: "anthropic", name: "Anthropic" }, { apiKey: KEY })).toBe(true);
    const skipping = createCredentialVerifier({ skip: () => true });
    expect(await assertCredentialVerified(skipping, { key: "anthropic", name: "Anthropic" }, { apiKey: KEY })).toBe(false);
    expect(await assertCredentialVerified(undefined, { key: "anthropic", name: "Anthropic" }, { apiKey: KEY })).toBe(false);
  });

  it("refuses redirects and leaves the body unread", async () => {
    const cancel = vi.fn();
    const stub = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 200 }));
    const verifier = createCredentialVerifier({ fetch: stub as unknown as typeof fetch });
    expect(await verifier.verify("anthropic", { apiKey: KEY })).toEqual({ ok: true, verified: true });
    const [, init] = stub.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.redirect).toBe("error");
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects a key with a line break without a call", async () => {
    const stub = respond(200);
    const verifier = createCredentialVerifier({ fetch: stub as unknown as typeof fetch });
    expect(await verifier.verify("anthropic", { apiKey: "a\nb" })).toEqual({ ok: false, reason: "rejected" });
    expect(stub).not.toHaveBeenCalled();
  });
});

describe("credential verifier, keys outside printable ASCII", () => {
  const keys: Array<[string, string]> = [
    ["smart quote", "sk-ant-“quoted”-0123456789"],
    ["Korean", "sk-ant-키-0123456789"],
    ["tab", "sk-ant-\tbad-0123456789"],
    ["DEL", "sk-ant-\x7fbad-0123456789"],
    ["emoji", "sk-ant-\u{1F511}-0123456789"],
  ];
  const cases = keys.map(([label, key]) => ["anthropic", label, key] as const);

  it.each(cases)("%s with a %s key is rejected without a network call", async (vendor, _label, key) => {
    // A real fetch throws on such header values, which the verifier would report as unreachable.
    const stub = vi.fn(async (_url: unknown, init?: RequestInit) => {
      new Headers(init?.headers);
      return new Response("{}", { status: 200 });
    });
    const verifier = createCredentialVerifier({ fetch: stub as unknown as typeof fetch });
    const result = await verifier.verify(vendor, { apiKey: key });
    expect(result).toEqual({ ok: false, reason: "rejected" });
    expect(stub).not.toHaveBeenCalled();
    const name = names[vendor];
    await expect(assertCredentialVerified(verifier, { key: vendor, name }, { apiKey: key })).rejects.toThrow(`${name} rejected this API key.`);
    expect(stub).not.toHaveBeenCalled();
  });
});
