import { standardStatus } from "@/contexts/integrations/infrastructure/credential-verifier";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import { stripLineBreaks } from "../../domain/enrichment-url-policy";
import { parseBody, safeRequest } from "../enrichment-http";
import { answerWith, asRecord, retryAfterMs, statusError, text, type VendorDefinition } from "./vendor-kit";

// Prospeo (https://prospeo.io/api-docs/enrich-person, person-object, account-information, rate-limits). Docs read
// 2026-10-20; not exercised against a live key. Most errors share HTTP 400 and differ by `error_code`. The request asks
// for verified emails only, and Prospeo charges nothing when it finds no match.
const ENRICH_URL = "https://api.prospeo.io/enrich-person";
const ACCOUNT_URL = "https://api.prospeo.io/account-information";

export const prospeo: VendorDefinition = {
  key: "prospeo",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = call.credentials.apiKey;
    if (!apiKey) throw new ProviderError("The Prospeo API key is missing.", false);
    if (call.action !== "find-work-email") throw new ProviderError(`Unknown Prospeo action: ${call.action}`, false);
    const fullName = text(call.inputs.fullName);
    const domain = text(call.inputs.companyDomain);
    if (!fullName || !domain) throw new ProviderError("Prospeo needs a full name and a company domain.", false);
    const url = new URL(ENRICH_URL);
    const request = { method: "POST", endpoint: url.pathname, inputKeys: Object.keys(call.inputs) };
    const response = await safeRequest(
      url,
      { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "X-KEY": stripLineBreaks(apiKey) }, body: JSON.stringify({ only_verified_email: true, data: { full_name: fullName, company_website: domain } }) },
      call.timeoutMs,
      net,
    );
    const body = asRecord(parseBody(response));
    const code = text(body.error_code);
    const audit = { request, response: { error: body.error, error_code: code } };
    const none = { email: null, confidence: null, verificationStatus: null };
    if (code === "NO_MATCH") return answerWith(none, null, request, audit.response, { billable: false });
    if (code === "INVALID_API_KEY") throw new ProviderError("Prospeo returned INVALID_API_KEY. Check the Prospeo API key.", false, audit);
    if (code === "INSUFFICIENT_CREDITS") throw new ProviderError("Prospeo returned INSUFFICIENT_CREDITS. The Prospeo account is out of credits.", false, audit);
    if (code === "INTERNAL_ERROR") throw new ProviderError("Prospeo returned INTERNAL_ERROR.", true, audit);
    if (response.status === 429) throw new ProviderError("Prospeo returned 429: rate limit exceeded.", true, audit, retryAfterMs(response.retryAfter));
    if (code) throw new ProviderError(`Prospeo returned ${code}.`, false, audit);
    if (response.status < 200 || response.status >= 300) throw statusError("Prospeo", response, body, request);

    const person = asRecord(body.person);
    const found = asRecord(person.email);
    const verified = text(found.status)?.toUpperCase() === "VERIFIED";
    const email = verified ? text(found.email) : null;
    const outputs = { email, confidence: null, verificationStatus: email ? "valid" : null };
    const kept = { free_enrichment: body.free_enrichment, person: { email: { status: found.status, email: found.email } } };
    return answerWith(outputs, email, request, kept, email && body.free_enrichment !== true ? {} : { billable: false });
  },

  // The account endpoint is free. A bad key answers 400 INVALID_API_KEY.
  checkKey(apiKey, check) {
    return check({ url: ACCOUNT_URL, headers: { "X-KEY": apiKey, accept: "application/json" }, map: (status) => (status === 400 ? "rejected" : standardStatus(status)), inspect: (body) => (body.error === false ? null : "rejected") });
  },
};
