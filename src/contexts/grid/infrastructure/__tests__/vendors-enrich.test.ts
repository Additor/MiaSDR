import { describe, expect, it } from "vitest";
import { ask, checkKey, keyForms, VENDOR_KEY } from "./vendor-test-kit";

const noKey = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const form of keyForms) expect(json).not.toContain(form);
};

describe("People Data Labs", () => {
  // Values from https://docs.peopledatalabs.com/docs/example-record, read 2026-10-20, trimmed to the requested fields.
  const docPerson = {
    status: 200,
    likelihood: 10,
    data: { work_email: "kimberly_patton@hall-rios-and-miller.com", job_title: "tax adviser", job_company_name: "hall, rios and miller", linkedin_url: "linkedin.com/in/kimberly_patton" },
  };
  // https://docs.peopledatalabs.com/docs/errors
  const docNotFound = { status: 404, error: { type: "not_found", message: "No records were found matching your request" } };
  const person = (status: number, body: unknown, inputs: Record<string, unknown> = { fullName: "Kimberly Patton", companyDomain: "hall-rios-and-miller.com" }, headers?: Record<string, string>) => ask("peopledatalabs", status, body, "enrich-person", inputs, headers);

  it("matches a name with a company name when the row has no domain", async () => {
    const { seen } = await person(200, docPerson, { fullName: "Kimberly Patton", companyName: "Hall, Rios and Miller" });
    expect(new URL(seen[0].url).searchParams.get("company")).toBe("Hall, Rios and Miller");
    const apollo = await ask("apollo", 200, { person: {} }, "enrich-person", { fullName: "Kimberly Patton", companyName: "Hall, Rios and Miller" });
    expect(new URL(apollo.seen[0].url).searchParams.get("organization_name")).toBe("Hall, Rios and Miller");
  });

  it("reads the billed credits from x-call-credits-spent and waits for x-ratelimit-reset", async () => {
    const json = { "content-type": "application/json" };
    expect((await person(200, docPerson, undefined, { ...json, "x-call-credits-spent": "0" })).result).toMatchObject({ outcome: "hit", billable: false });
    expect((await person(200, docPerson, undefined, { ...json, "x-call-credits-spent": "1" })).result.billable).toBeUndefined();
    const reset = new Date(Date.now() + 45_000).toISOString();
    const limited = await person(429, { status: 429, error: { type: "rate_limit_error", message: "Rate limit exceeded" } }, undefined, { ...json, "x-ratelimit-reset": reset });
    expect(limited.result.transient).toBe(true);
    expect(limited.result.retryAfterMs).toBeGreaterThan(40_000);
    expect(limited.result.retryAfterMs).toBeLessThanOrEqual(46_000);
  });

  it("asks for work fields only, at a likelihood of 6, with the key in a header", async () => {
    const { result, seen } = await person(200, docPerson);
    const url = new URL(seen[0].url);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.peopledatalabs.com/v5/person/enrich");
    expect(Object.fromEntries(url.searchParams)).toEqual({ name: "Kimberly Patton", company: "hall-rios-and-miller.com", min_likelihood: "6", data_include: "work_email,job_title,job_company_name,linkedin_url" });
    expect((seen[0].init.headers as Record<string, string>)["X-Api-Key"]).toBe(VENDOR_KEY);
    expect(result).toMatchObject({
      outcome: "hit",
      primary: "kimberly_patton@hall-rios-and-miller.com",
      outputs: { title: "tax adviser", company: "hall, rios and miller", linkedinUrl: "https://linkedin.com/in/kimberly_patton", likelihood: 10 },
    });
    noKey([result.request, result.response, seen[0].url.replace(VENDOR_KEY, "")]);
  });

  it("never stores personal emails or phones, even when PDL sends them", async () => {
    const leaky = { ...docPerson, data: { ...docPerson.data, personal_emails: ["kimberly_patton@me.com"], mobile_phone: "+15814854381" } };
    const { result } = await person(200, leaky);
    // The request never asks for them; this guards the answer side as well.
    const stored = JSON.stringify([result.outputs, result.response]);
    expect(stored).not.toContain("me.com");
    expect(stored).not.toContain("+15814854381");
  });

  it("matches by email or LinkedIn URL alone and refuses a name without a domain", async () => {
    const byEmail = await person(200, docPerson, { email: "kimberly_patton@hall-rios-and-miller.com" });
    expect(new URL(byEmail.seen[0].url).searchParams.get("email")).toBe("kimberly_patton@hall-rios-and-miller.com");
    const byProfile = await person(200, docPerson, { linkedinUrl: "https://www.linkedin.com/in/kimberly_patton" });
    expect(new URL(byProfile.seen[0].url).searchParams.get("profile")).toBe("https://www.linkedin.com/in/kimberly_patton");
    const nameOnly = await person(200, docPerson, { fullName: "Kimberly Patton" });
    expect(nameOnly.result).toMatchObject({ transient: false });
    expect(nameOnly.seen).toHaveLength(0);
  });

  it("reads a 404 as a free miss and a free-plan boolean as no email", async () => {
    expect((await person(404, docNotFound)).result).toMatchObject({ outcome: "miss", billable: false });
    const freePlan = { ...docPerson, data: { ...docPerson.data, work_email: true } };
    expect((await person(200, freePlan)).result).toMatchObject({ outcome: "miss", primary: null });
  });

  it("reads the documented errors", async () => {
    expect((await person(402, { status: 402, error: { type: "payment_required", message: "You have reached your account maximum (all matches have been used)." } })).result).toMatchObject({ transient: false });
    expect((await person(401, { status: 401, error: { type: "authentication_error", message: "Invalid API key" } })).result.message).toContain("Check the People Data Labs API key.");
    expect((await person(429, { status: 429, error: { type: "rate_limit_error", message: "An error occurred due to requests hitting the API too quick" } })).result).toMatchObject({ transient: true });
    expect((await person(400, { status: 400, error: { type: "invalid_request_error", message: "bad" } })).result).toMatchObject({ transient: false });
  });

  it("enriches a company from the flat company record", async () => {
    // Values from https://docs.peopledatalabs.com/docs/example-company-record, trimmed.
    const docCompany = { status: 200, name: "people data labs", size: "51-200", employee_count: 87, industry: "computer software", website: "peopledatalabs.com", linkedin_url: "linkedin.com/company/peopledatalabs", location: { name: "san francisco, california, united states", locality: "san francisco", region: "california", country: "united states" }, likelihood: 6 };
    const { result, seen } = await ask("peopledatalabs", 200, docCompany, "enrich-company", { companyDomain: "peopledatalabs.com" });
    const url = new URL(seen[0].url);
    expect(url.pathname).toBe("/v5/company/enrich");
    expect(url.searchParams.get("website")).toBe("peopledatalabs.com");
    expect(result).toMatchObject({
      outcome: "hit",
      primary: "people data labs",
      outputs: { industry: "computer software", employeeCount: 87, websiteUrl: "https://peopledatalabs.com", linkedinUrl: "https://linkedin.com/company/peopledatalabs", city: "san francisco", country: "united states", size: "51-200" },
    });
    expect((await ask("peopledatalabs", 404, docNotFound, "enrich-company", { companyDomain: "none.test" })).result).toMatchObject({ outcome: "miss", billable: false });
  });

  it("checks a key on the free autocomplete endpoint", async () => {
    const good = await checkKey("peopledatalabs", 200, '{"status":200,"data":[]}');
    expect(good.result).toEqual({ ok: true, verified: true });
    expect(good.url).toBe("https://api.peopledatalabs.com/v5/autocomplete?field=company&text=a&size=1");
    expect(good.init.headers).toMatchObject({ "X-Api-Key": VENDOR_KEY });
    expect((await checkKey("peopledatalabs", 401, "{}")).result).toEqual({ ok: false, reason: "rejected" });
  });
});
