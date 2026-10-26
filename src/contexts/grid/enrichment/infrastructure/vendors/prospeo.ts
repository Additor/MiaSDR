import { standardStatus } from "@/platform/credentials/key-check";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import { answerWith, apiKeyOf, asRecord, assertAction, rateLimitWaitMs, send, statusError, text, type VendorDefinition } from "./vendor-kit";

// Prospeo (https://prospeo.io/api-docs/enrich-person, person-object, account-information, rate-limits). Docs read
// 2026-10-20. Most errors share HTTP 400 and differ by `error_code`. The request asks for verified emails only, and
// Prospeo charges nothing when it finds no match.
// Run live on 2026-10-20 with an invalid key only: the key check and one call were refused as the code expects.
const ENRICH_URL = "https://api.prospeo.io/enrich-person";
const ACCOUNT_URL = "https://api.prospeo.io/account-information";

export const prospeo: VendorDefinition = {
  key: "prospeo",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = apiKeyOf(call, "Prospeo");
    assertAction(call, "Prospeo", "find-work-email");
    const fullName = text(call.inputs.fullName);
    const domain = text(call.inputs.companyDomain);
    const company = text(call.inputs.companyName);
    if (!fullName || !(domain || company)) throw new ProviderError("Prospeo needs a full name and a company domain or name.", false);
    const sent = await send(call, net, new URL(ENRICH_URL), {
      method: "POST",
      headers: { "X-KEY": apiKey },
      json: { only_verified_email: true, data: { full_name: fullName, ...(domain ? { company_website: domain } : { company_name: company }) } },
    });
    const { request, response } = sent;
    const body = asRecord(sent.body);
    const code = text(body.error_code);
    const audit = { request, response: { error: body.error, error_code: code } };
    const none = { email: null, confidence: null, verificationStatus: null };
    if (code === "NO_MATCH") return answerWith(none, null, request, audit.response, { billable: false });
    if (code === "INVALID_API_KEY") throw new ProviderError("Prospeo returned INVALID_API_KEY. Check the Prospeo API key.", false, audit);
    if (code === "INSUFFICIENT_CREDITS") throw new ProviderError("Prospeo returned INSUFFICIENT_CREDITS. The Prospeo account is out of credits.", false, audit);
    if (code === "INTERNAL_ERROR") throw new ProviderError("Prospeo returned INTERNAL_ERROR.", true, audit);
    if (response.status === 429) throw new ProviderError("Prospeo returned 429: rate limit exceeded.", true, audit, rateLimitWaitMs(response));
    if (code) throw new ProviderError(`Prospeo returned ${code}.`, false, audit);
    if (response.status < 200 || response.status >= 300) throw statusError("Prospeo", response, body, request);

    const person = asRecord(body.person);
    const found = asRecord(person.email);
    const verified = text(found.status)?.toUpperCase() === "VERIFIED";
    // Prospeo sends the address only once it is revealed; an unrevealed one comes back masked ("ada.*****@example.com").
    const address = text(found.email);
    const email = verified && found.revealed !== false && address && !address.includes("*") ? address : null;
    const outputs = { email, confidence: null, verificationStatus: email ? "valid" : null };
    const kept = { free_enrichment: body.free_enrichment, person: { email: { status: found.status, revealed: found.revealed, email: found.email } } };
    return answerWith(outputs, email, request, kept, email && body.free_enrichment !== true ? {} : { billable: false });
  },

  // The account endpoint is free. A bad key answers 400 INVALID_API_KEY.
  checkKey(apiKey, check) {
    return check({ url: ACCOUNT_URL, headers: { "X-KEY": apiKey, accept: "application/json" }, map: (status) => (status === 400 ? "rejected" : standardStatus(status)), inspect: (body) => (body.error === false ? null : "rejected") });
  },
};
