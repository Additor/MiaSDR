import { standardStatus } from "@/contexts/integrations/infrastructure/credential-verifier";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import { answerWith, apiKeyOf, asRecord, assertAction, send, statusError, text, type VendorDefinition } from "./vendor-kit";

// Findymail (https://app.findymail.com/docs/, openapi.yaml). Docs read 2026-10-20. The finder returns verified emails
// only and charges only when it finds one. The docs show no no-match body, so an answer without an email, or a 404,
// reads as a free miss.
// Run live on 2026-10-20 with an invalid key only: the key check and one call were refused as the code expects.
const SEARCH_URL = "https://app.findymail.com/api/search/name";
const CREDITS_URL = "https://app.findymail.com/api/credits";

export const findymail: VendorDefinition = {
  key: "findymail",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = apiKeyOf(call, "Findymail");
    assertAction(call, "Findymail", "find-work-email");
    const name = text(call.inputs.fullName);
    // Findymail's `domain` takes a company domain (best) or a company name.
    const domain = text(call.inputs.companyDomain) ?? text(call.inputs.companyName);
    if (!name || !domain) throw new ProviderError("Findymail needs a full name and a company domain or name.", false);
    const { request, response, body } = await send(call, net, new URL(SEARCH_URL), { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, json: { name, domain } });
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
