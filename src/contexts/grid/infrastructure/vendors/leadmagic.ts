import { standardStatus } from "@/contexts/integrations/infrastructure/credential-verifier";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import { stripLineBreaks } from "../../domain/enrichment-url-policy";
import { parseBody, safeRequest } from "../enrichment-http";
import { answerWith, asRecord, statusError, text, type VendorDefinition } from "./vendor-kit";

// LeadMagic (https://leadmagic.io/docs/api-reference/email-finder, openapi.json, docs/v1/making-api-calls, docs/v1/credits).
// Docs read 2026-10-20. A no-match is HTTP 200 with a null email and costs nothing. LeadMagic pauses a key after ten
// rejected-key calls in ten minutes, so the key check is never retried.
// Run live on 2026-10-20 with an invalid key only: the key check and one call were refused as the code expects.
const FINDER_URL = "https://api.leadmagic.io/v1/people/email-finder";
const CREDITS_URL = "https://api.leadmagic.io/v1/credits";

export const leadmagic: VendorDefinition = {
  key: "leadmagic",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = call.credentials.apiKey;
    if (!apiKey) throw new ProviderError("The LeadMagic API key is missing.", false);
    if (call.action !== "find-work-email") throw new ProviderError(`Unknown LeadMagic action: ${call.action}`, false);
    const fullName = text(call.inputs.fullName);
    const domain = text(call.inputs.companyDomain);
    const company = text(call.inputs.companyName);
    if (!fullName || !(domain || company)) throw new ProviderError("LeadMagic needs a full name and a company domain or name.", false);
    const url = new URL(FINDER_URL);
    const request = { method: "POST", endpoint: url.pathname, inputKeys: Object.keys(call.inputs) };
    const response = await safeRequest(
      url,
      { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "X-API-Key": stripLineBreaks(apiKey) }, body: JSON.stringify({ full_name: fullName, ...(domain ? { domain } : { company_name: company }) }) },
      call.timeoutMs,
      net,
    );
    const body = asRecord(parseBody(response));
    if (response.status < 200 || response.status >= 300) {
      const first = asRecord(Array.isArray(body.errors) ? body.errors[0] : undefined);
      throw statusError("LeadMagic", response, { message: text(first.title) ?? text(first.code) ?? body.message }, request);
    }
    const email = text(body.email);
    const status = text(body.status);
    const outputs = { email, confidence: null, verificationStatus: email ? (status === "valid" ? "valid" : "unknown") : null, employmentVerified: body.employment_verified };
    const kept = { email: body.email, status: body.status, credits_consumed: body.credits_consumed, message: body.message, employment_verified: body.employment_verified };
    return answerWith(outputs, email, request, kept, body.credits_consumed === 0 || !email ? { billable: false } : {});
  },

  checkKey(apiKey, check) {
    return check({ url: CREDITS_URL, headers: { "X-API-Key": apiKey, accept: "application/json" }, map: standardStatus, inspect: (body) => (typeof body.credits === "number" ? null : "unverifiable") });
  },
};
