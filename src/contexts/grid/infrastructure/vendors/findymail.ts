import { standardStatus } from "@/contexts/integrations/infrastructure/credential-verifier";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import { stripLineBreaks } from "../../domain/enrichment-url-policy";
import { parseBody, safeRequest } from "../enrichment-http";
import { answerWith, asRecord, statusError, text, type VendorDefinition } from "./vendor-kit";

// Findymail (https://app.findymail.com/docs/, openapi.yaml). Docs read 2026-10-20. The finder returns verified emails
// only and charges only when it finds one. The docs show no no-match body, so an answer without an email, or a 404,
// reads as a free miss.
// Run live on 2026-10-20 with an invalid key only: the key check and one call were refused as the code expects.
const SEARCH_URL = "https://app.findymail.com/api/search/name";
const CREDITS_URL = "https://app.findymail.com/api/credits";

export const findymail: VendorDefinition = {
  key: "findymail",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = call.credentials.apiKey;
    if (!apiKey) throw new ProviderError("The Findymail API key is missing.", false);
    if (call.action !== "find-work-email") throw new ProviderError(`Unknown Findymail action: ${call.action}`, false);
    const name = text(call.inputs.fullName);
    const domain = text(call.inputs.companyDomain);
    if (!name || !domain) throw new ProviderError("Findymail needs a full name and a company domain.", false);
    const url = new URL(SEARCH_URL);
    const request = { method: "POST", endpoint: url.pathname, inputKeys: Object.keys(call.inputs) };
    const response = await safeRequest(
      url,
      { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${stripLineBreaks(apiKey)}` }, body: JSON.stringify({ name, domain }) },
      call.timeoutMs,
      net,
    );
    const body = parseBody(response);
    const outputs = (email: unknown) => ({ email, confidence: null, verificationStatus: text(email) ? "valid" : null });
    if (response.status === 404) return answerWith(outputs(null), null, request, body, { billable: false });
    if (response.status === 423) throw new ProviderError("Findymail returned 423: the subscription is paused.", false, { request, response: body });
    if (response.status < 200 || response.status >= 300) throw statusError("Findymail", response, body, request);
    const contact = asRecord(asRecord(body).contact);
    const email = text(contact.email);
    return answerWith(outputs(email), email, request, { contact: { email: contact.email, domain: contact.domain } }, email ? {} : { billable: false });
  },

  checkKey(apiKey, check) {
    return check({ url: CREDITS_URL, headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" }, map: standardStatus, inspect: (body) => (typeof body.credits === "number" ? null : "unverifiable") });
  },
};
