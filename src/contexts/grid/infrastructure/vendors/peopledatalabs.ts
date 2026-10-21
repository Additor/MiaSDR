import { standardStatus } from "@/contexts/integrations/infrastructure/credential-verifier";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import type { SafeResponse } from "../enrichment-http";
import { answerWith, apiKeyOf, asRecord, send, statusError, text, withScheme, type VendorDefinition } from "./vendor-kit";

// People Data Labs (https://docs.peopledatalabs.com/docs/reference-person-enrichment-api, input-parameters-person-
// enrichment-api, reference-company-enrichment-api, errors, usage-limits). Docs read 2026-10-20. PDL charges per match,
// so a 404 is a free miss.
// Run live on 2026-10-20 with an invalid key only: the key check and one call were refused as the code expects.
const BASE = "https://api.peopledatalabs.com";
const AUTOCOMPLETE_URL = `${BASE}/v5/autocomplete?field=company&text=a&size=1`;

/**
 * PDL's default likelihood of 2 means a 10 to 30 percent chance the record is the right person; PDL suggests 6 or
 * more when accuracy matters, and a wrong person's details are worse than none.
 */
export const PDL_MIN_LIKELIHOOD = "6";

/**
 * The only person fields requested. Personal emails, phone numbers and addresses are never asked for, so they never
 * reach the cells or the ledger. On a free plan contact fields come back as true or false; a non-string reads as empty.
 */
const PERSON_FIELDS = "work_email,job_title,job_company_name,linkedin_url";
const COMPANY_FIELDS = "name,industry,employee_count,website,linkedin_url,location";

/** PDL reports the credits it billed in `x-call-credits-spent`; a 0 there is free whatever the answer. */
const creditsSpent = (response: SafeResponse): number | null => {
  const raw = response.headers?.get("x-call-credits-spent")?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
/** The answer with PDL's own credit count, which also decides whether it was billed. */
const withCredits = (answer: ProviderAnswer, response: SafeResponse): ProviderAnswer => {
  const credits = creditsSpent(response);
  return credits === null ? answer : { ...answer, credits, ...(credits === 0 ? { billable: false } : {}) };
};

export const peopledatalabs: VendorDefinition = {
  key: "peopledatalabs",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = apiKeyOf(call, "People Data Labs");
    const { inputs } = call;
    const url = new URL(BASE);
    if (call.action === "enrich-person") {
      const email = text(inputs.email);
      const profile = text(inputs.linkedinUrl);
      const name = text(inputs.fullName);
      // PDL's `company` takes a domain or a name; the domain matches better.
      const company = text(inputs.companyDomain) ?? text(inputs.companyName);
      if (!email && !profile && !(name && company)) throw new ProviderError("People Data Labs needs an email, a LinkedIn URL, or a full name with a company domain or name.", false);
      url.pathname = "/v5/person/enrich";
      if (email) url.searchParams.set("email", email);
      if (profile) url.searchParams.set("profile", profile);
      if (name && company) {
        url.searchParams.set("name", name);
        url.searchParams.set("company", company);
      }
      url.searchParams.set("min_likelihood", PDL_MIN_LIKELIHOOD);
      url.searchParams.set("data_include", PERSON_FIELDS);
    } else if (call.action === "enrich-company") {
      const domain = text(inputs.companyDomain);
      if (!domain) throw new ProviderError("People Data Labs needs a company domain.", false);
      url.pathname = "/v5/company/enrich";
      url.searchParams.set("website", domain);
      url.searchParams.set("data_include", COMPANY_FIELDS);
    } else {
      throw new ProviderError(`Unknown People Data Labs action: ${call.action}`, false);
    }
    const sent = await send(call, net, url, { method: "GET", headers: { "X-Api-Key": apiKey } });
    const { request, response } = sent;
    const body = asRecord(sent.body);
    if (call.action === "enrich-person") {
      const none = { email: null, title: null, company: null, linkedinUrl: null, likelihood: null };
      if (response.status === 404) return answerWith(none, null, request, { status: 404 }, { billable: false });
      if (response.status < 200 || response.status >= 300) throw statusError("People Data Labs", response, body, request);
      const data = asRecord(body.data);
      const outputs = { email: text(data.work_email), title: text(data.job_title), company: text(data.job_company_name), linkedinUrl: withScheme(data.linkedin_url), likelihood: body.likelihood };
      // The ledger keeps the requested fields only, in case PDL ever sends more. A match without a work email is still billed.
      const kept = Object.fromEntries(PERSON_FIELDS.split(",").map((field) => [field, data[field] ?? null]));
      return withCredits(answerWith(outputs, outputs.email, request, { status: body.status, likelihood: body.likelihood, data: kept }), response);
    }
    const none = { name: null, industry: null, employeeCount: null, websiteUrl: null, linkedinUrl: null, city: null, country: null, size: null };
    if (response.status === 404) return answerWith(none, null, request, { status: 404 }, { billable: false });
    if (response.status < 200 || response.status >= 300) throw statusError("People Data Labs", response, body, request);
    // The company record sits at the top level of the answer, not under `data`.
    const location = asRecord(body.location);
    const outputs = {
      name: text(body.name),
      industry: text(body.industry),
      employeeCount: typeof body.employee_count === "number" ? body.employee_count : null,
      websiteUrl: withScheme(body.website),
      linkedinUrl: withScheme(body.linkedin_url),
      city: text(location.locality),
      country: text(location.country),
      size: text(body.size),
    };
    return withCredits(answerWith(outputs, outputs.name, request, { status: body.status, likelihood: body.likelihood, ...outputs }), response);
  },

  // Autocomplete is free for every active key.
  checkKey(apiKey, check) {
    return check({ url: AUTOCOMPLETE_URL, headers: { "X-Api-Key": apiKey, accept: "application/json" }, map: standardStatus });
  },
};
