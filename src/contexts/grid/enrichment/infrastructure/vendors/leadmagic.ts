import { standardStatus } from "@/platform/credentials/key-check";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import { answerWith, apiKeyOf, asRecord, assertAction, send, statusError, text, type VendorDefinition } from "./vendor-kit";

// LeadMagic (https://leadmagic.io/docs/api-reference/email-finder, openapi.json, docs/v1/making-api-calls, docs/v1/credits).
// Docs read 2026-10-20. A no-match is HTTP 200 with a null email and costs nothing. LeadMagic pauses a key after ten
// rejected-key calls in ten minutes, so the key check is never retried.
// Run live on 2026-10-20 with an invalid key only: the key check and one call were refused as the code expects.
const FINDER_URL = "https://api.leadmagic.io/v1/people/email-finder";
const CREDITS_URL = "https://api.leadmagic.io/v1/credits";

export const leadmagic: VendorDefinition = {
  key: "leadmagic",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = apiKeyOf(call, "LeadMagic");
    assertAction(call, "LeadMagic", "find-work-email");
    const fullName = text(call.inputs.fullName);
    const domain = text(call.inputs.companyDomain);
    const company = text(call.inputs.companyName);
    if (!fullName || !(domain || company)) throw new ProviderError("LeadMagic needs a full name and a company domain or name.", false);
    const sent = await send(call, net, new URL(FINDER_URL), { method: "POST", headers: { "X-API-Key": apiKey }, json: { full_name: fullName, ...(domain ? { domain } : { company_name: company }) } });
    const { request, response } = sent;
    const body = asRecord(sent.body);
    if (response.status < 200 || response.status >= 300) {
      const first = asRecord(Array.isArray(body.errors) ? body.errors[0] : undefined);
      throw statusError("LeadMagic", response, { message: text(first.title) ?? text(first.code) ?? body.message }, request);
    }
    const email = text(body.email);
    const status = text(body.status);
    const outputs = { email, confidence: null, verificationStatus: email ? (status === "valid" ? "valid" : "unknown") : null, employmentVerified: body.employment_verified };
    const kept = { email: body.email, status: body.status, credits_consumed: body.credits_consumed, message: body.message, employment_verified: body.employment_verified };
    const answer = answerWith(outputs, email, request, kept, body.credits_consumed === 0 || !email ? { billable: false } : {});
    return typeof body.credits_consumed === "number" ? { ...answer, credits: body.credits_consumed } : answer;
  },

  checkKey(apiKey, check) {
    return check({ url: CREDITS_URL, headers: { "X-API-Key": apiKey, accept: "application/json" }, map: standardStatus, inspect: (body) => (typeof body.credits === "number" ? null : "unverifiable") });
  },
};
