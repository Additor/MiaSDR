import { describe, expect, it } from "vitest";
import { cleanError } from "../../domain/enrichment-redact";
import { ask, checkKey, keyForms, VENDOR_KEY } from "./vendor-test-kit";

const noKey = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const form of keyForms) expect(json).not.toContain(form);
};

describe("ZeroBounce", () => {
  // https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails, read 2026-10-20.
  const docValid = { address: "john.doe@zerobounce.net", status: "valid", sub_status: "", free_email: false, catchall_domain: true, did_you_mean: null, account: "johndoe", domain: "zerobounce.net", domain_age_days: "3431", smtp_provider: "g-suite", mx_found: "true", firstname: "john", lastname: "doe", gender: "male", country: null, processed_at: "2026-06-18 07:05:00.033" };
  const verify = (status: number, body: unknown) => ask("zerobounce", status, body, "verify-email", { email: "john.doe@zerobounce.net" });

  it("posts the key in a form body, never the URL, and keeps only the verdict in the audit", async () => {
    const { result, seen } = await verify(200, docValid);
    expect(seen[0].url).toBe("https://api.zerobounce.net/v2/validate");
    expect(seen[0].init.method).toBe("POST");
    expect(new URLSearchParams(String(seen[0].init.body)).get("api_key")).toBe(VENDOR_KEY);
    expect(new URLSearchParams(String(seen[0].init.body)).get("timeout")).toBe("20");
    expect(result).toMatchObject({ outcome: "hit", primary: "valid", outputs: { email: "john.doe@zerobounce.net", status: "valid", providerStatus: "valid", freeEmail: false, role: false } });
    expect(result.request).toEqual({ method: "POST", endpoint: "/v2/validate", inputKeys: ["email"] });
    expect(JSON.stringify(result.response)).not.toContain("\"lastname\"");
    noKey([result.request, result.response]);
  });

  it("stores a blank suggestion or sub-status as empty", async () => {
    const { result } = await verify(200, { ...docValid, did_you_mean: "", sub_status: " " });
    expect(result.outputs).toMatchObject({ didYouMean: null, subStatus: null });
  });

  it.each([
    ["valid", "", "valid", "hit", true],
    ["invalid", "mailbox_not_found", "invalid", "hit", true],
    ["catch-all", "", "catch_all", "miss", true],
    ["unknown", "greylisted", "unknown", "miss", false],
    ["spamtrap", "", "invalid", "hit", true],
    ["abuse", "", "invalid", "hit", true],
    ["do_not_mail", "toxic", "invalid", "hit", true],
    ["do_not_mail", "disposable", "disposable", "hit", true],
    ["do_not_mail", "role_based", "valid", "hit", true],
    ["do_not_mail", "role_based_catch_all", "catch_all", "miss", true],
    // The domain is on ZeroBounce's accept-all list.
    ["valid", "accept_all", "catch_all", "miss", true],
    ["valid", "role_based_accept_all", "catch_all", "miss", true],
  ])("maps %s/%s to %s, a %s", async (raw, sub, status, outcome, billable) => {
    const { result } = await verify(200, { ...docValid, status: raw, sub_status: sub });
    expect(result).toMatchObject({ outcome, primary: status, outputs: { status, providerStatus: raw } });
    expect(result.billable === false).toBe(!billable);
  });

  it("reads the shared bad-key and no-credit body as a permanent error, with HTTP 200 or 400", async () => {
    for (const status of [200, 400]) {
      const { result } = await verify(status, { error: "Invalid API Key or your account ran out of credits" });
      expect(result).toMatchObject({ transient: false });
      expect(result.message).toContain("Invalid API Key or your account ran out of credits");
    }
  });

  it("retries 429 and 5xx and refuses an empty email without a call", async () => {
    expect((await verify(429, {})).result).toMatchObject({ transient: true });
    expect((await verify(503, {})).result).toMatchObject({ transient: true });
    const empty = await ask("zerobounce", 200, docValid, "verify-email", { email: " " });
    expect(empty.result).toMatchObject({ transient: false, message: "ZeroBounce needs an email." });
    expect(empty.seen).toHaveLength(0);
  });

  it("checks a key on the credit balance, where -1 means a bad key", async () => {
    const good = await checkKey("zerobounce", 200, '{"Credits":2375323}');
    expect(good.result).toEqual({ ok: true, verified: true });
    expect(good.url).toBe(`https://api.zerobounce.net/v2/getcredits?api_key=${encodeURIComponent(VENDOR_KEY)}`);
    expect(good.init.redirect).toBe("error");
    expect((await checkKey("zerobounce", 200, '{"Credits":-1}')).result).toEqual({ ok: false, reason: "rejected" });
    expect((await checkKey("zerobounce", 200, "<html></html>")).result).toEqual({ ok: false, reason: "unverifiable" });
  });
});

describe("MillionVerifier", () => {
  // Built from the example values of the schema at https://developer.millionverifier.com/, read 2026-10-20.
  const docInvalid = { email: "bademail@gmal.com", quality: "good", result: "invalid", resultcode: 6, subresult: "bad_domain", free: false, role: false, didyoumean: "bademail@gmail.com", credits: 3454, executiontime: 2, error: "", livemode: true };
  const verify = (status: number, body: unknown) => ask("millionverifier", status, body, "verify-email", { email: "bademail@gmal.com" });

  it("sends the key as the api parameter and leaves it out of the audit", async () => {
    const { result, seen } = await verify(200, docInvalid);
    const url = new URL(seen[0].url);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.millionverifier.com/api/v3/");
    expect(url.searchParams.get("api")).toBe(VENDOR_KEY);
    expect(url.searchParams.get("email")).toBe("bademail@gmal.com");
    expect(result).toMatchObject({ outcome: "hit", primary: "invalid", outputs: { status: "invalid", providerStatus: "invalid", subStatus: "bad_domain", didYouMean: "bademail@gmail.com", quality: "good" } });
    expect(result.request).toEqual({ method: "GET", endpoint: "/api/v3/", inputKeys: ["email"] });
    noKey([result.request, result.response]);
  });

  it.each([
    ["ok", "valid", "hit", true],
    ["invalid", "invalid", "hit", true],
    ["disposable", "disposable", "hit", true],
    ["catch_all", "catch_all", "miss", false],
    ["unknown", "unknown", "miss", false],
  ])("maps %s to %s, a %s", async (raw, status, outcome, billable) => {
    const { result } = await verify(200, { ...docInvalid, result: raw });
    expect(result).toMatchObject({ outcome, primary: status });
    expect(result.billable === false).toBe(!billable);
  });

  // Seen live on 2026-10-20 with the docs' test key API_KEY_FOR_TEST, which answers with livemode false.
  const testKey = { free: false, role: false, didyoumean: "", credits: 0, executiontime: 0, error: "", livemode: false };
  const liveSamples = [
    { email: "user0@example.com", quality: "bad", result: "invalid", resultcode: 6, subresult: "bad_domain", ...testKey },
    { email: "user1@example.com", quality: "risky", result: "unknown", resultcode: 5, subresult: "no_local_ip_available", ...testKey },
    { email: "user2@example.com", quality: "risky", result: "catch_all", resultcode: 2, subresult: "ok", ...testKey },
    { email: "user4@example.com", quality: "bad", result: "disposable", resultcode: 3, subresult: "ok", ...testKey },
  ];

  it.each([
    ["invalid", "hit", "invalid"],
    ["unknown", "miss", "unknown"],
    ["catch_all", "miss", "catch_all"],
    ["disposable", "hit", "disposable"],
  ])("reads the live %s body as a %s with status %s once it is live", async (raw, outcome, status) => {
    const body = { ...liveSamples.find((sample) => sample.result === raw)!, livemode: true };
    const { result } = await verify(200, body);
    expect(result).toMatchObject({ outcome, primary: status, outputs: { status, subStatus: body.subresult, didYouMean: null, quality: body.quality } });
    // The ledger keeps the vendor's own blank.
    expect(result.response).toMatchObject({ didyoumean: "" });
  });

  it.each(liveSamples.map((sample) => [sample.result, sample]))("fails a test-mode %s answer, so a random verdict fills no cell", async (_raw, body) => {
    const { result } = await verify(200, body);
    expect(result).toMatchObject({ transient: false, message: "MillionVerifier answered in test mode, so its verdict is random. Use a live API key." });
  });

  it("reads the live bad-key answer as a permanent error", async () => {
    // Seen live on 2026-10-20 with an invalid key.
    const { result } = await verify(200, { email: "valid@example.com", result: "error", resultcode: 4, error: "Apikey not found" });
    expect(result).toMatchObject({ transient: false, message: "MillionVerifier refused the request: Apikey not found" });
  });

  it("reads an error text in a 200 answer as a permanent error", async () => {
    const { result } = await verify(200, { ...docInvalid, result: "error", resultcode: 4, error: "apikey_not_found" });
    expect(result).toMatchObject({ transient: false });
    expect(result.message).toBe("MillionVerifier refused the request: apikey_not_found");
  });

  it("checks a key on the credits endpoint", async () => {
    const good = await checkKey("millionverifier", 200, '{"credits":12345,"bulk_credits":0,"renewing_credits":0,"plan":4}');
    expect(good.result).toEqual({ ok: true, verified: true });
    expect(good.url).toBe(`https://api.millionverifier.com/api/v3/credits?api=${encodeURIComponent(VENDOR_KEY)}`);
    expect((await checkKey("millionverifier", 200, '{"error":"apikey_not_found"}')).result).toEqual({ ok: false, reason: "rejected" });
  });
});

describe("NeverBounce", () => {
  // https://developers.neverbounce.com/reference/single-check, read 2026-10-20.
  const docValid = { status: "success", result: "valid", flags: ["has_dns", "has_dns_mx"], suggested_correction: "", execution_time: 499 };
  const verify = (status: number, body: unknown) => ask("neverbounce", status, body, "verify-email", { email: "ada@acme.com" });

  it("sends the key as the key parameter and maps flags", async () => {
    const { result, seen } = await verify(200, { ...docValid, flags: ["has_dns", "free_email_host", "role_account"] });
    const url = new URL(seen[0].url);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.neverbounce.com/v4.2/single/check");
    expect(url.searchParams.get("key")).toBe(VENDOR_KEY);
    expect(url.searchParams.get("timeout")).toBe("10");
    expect(result).toMatchObject({ outcome: "hit", primary: "valid", outputs: { email: "ada@acme.com", status: "valid", freeEmail: true, role: true, didYouMean: null } });
    noKey([result.request, result.response]);
  });

  it.each([
    ["valid", "valid", "hit"],
    ["invalid", "invalid", "hit"],
    ["disposable", "disposable", "hit"],
    ["catchall", "catch_all", "miss"],
    ["unknown", "unknown", "miss"],
  ])("maps %s to %s, a %s", async (raw, status, outcome) => {
    expect((await verify(200, { ...docValid, result: raw })).result).toMatchObject({ outcome, primary: status });
  });

  it("echoes the key in its bad-key message, which the worker's cleanError removes", async () => {
    // Seen live on 2026-10-20: NeverBounce repeats the key it was given.
    const { result } = await verify(200, { status: "auth_failure", message: `Invalid API key '${VENDOR_KEY}'`, execution_time: 3 });
    expect(result).toMatchObject({ transient: false });
    const stored = cleanError(String(result.message), [VENDOR_KEY]);
    expect(stored).toBe("NeverBounce returned auth_failure: Invalid API key '[redacted]' Check the NeverBounce API key.");
  });

  it("reads failures that come back with HTTP 200", async () => {
    // https://developers.neverbounce.com/reference/error-handling
    const auth = (await verify(200, { status: "auth_failure", message: "Invalid API key", execution_time: 5 })).result;
    expect(auth).toMatchObject({ transient: false });
    expect(auth.message).toBe("NeverBounce returned auth_failure: Invalid API key Check the NeverBounce API key.");
    expect((await verify(200, { status: "throttle_triggered", message: "Too many requests" })).result).toMatchObject({ transient: true });
    expect((await verify(200, { status: "temp_unavail", message: "Try later" })).result).toMatchObject({ transient: true });
    expect((await verify(200, { status: "general_failure", message: "Missing required parameter 'key'" })).result).toMatchObject({ transient: false });
  });

  it("checks a key on the account endpoint", async () => {
    const good = await checkKey("neverbounce", 200, '{"status":"success","credits_info":{"paid_credits_remaining":9950791},"execution_time":896}');
    expect(good.result).toEqual({ ok: true, verified: true });
    expect(good.url).toBe(`https://api.neverbounce.com/v4.2/account/info?key=${encodeURIComponent(VENDOR_KEY)}`);
    expect((await checkKey("neverbounce", 200, '{"status":"auth_failure","message":"Invalid API key"}')).result).toEqual({ ok: false, reason: "rejected" });
  });
});
