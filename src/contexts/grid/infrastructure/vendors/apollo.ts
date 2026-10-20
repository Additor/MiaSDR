import { standardStatus } from "@/contexts/integrations/infrastructure/credential-verifier";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import { stripLineBreaks } from "../../domain/enrichment-url-policy";
import { isTransientStatus, parseBody, safeRequest } from "../enrichment-http";
import { answerWith, asRecord, errorSnippet, retryAfterMs, text, type VendorDefinition } from "./vendor-kit";

// Apollo (https://docs.apollo.io/reference/people-enrichment, .../organization-enrichment).
// The caller brings their own key. Docs read 2026-10-16; not exercised against a live key.
const APOLLO_BASE = "https://api.apollo.io/api/v1";
// Apollo lists GET /auth/health in its authentication docs (2026-10-16) without a bad-key status. Not run live.
const APOLLO_HEALTH_URL = "https://api.apollo.io/api/v1/auth/health";

export const apollo: VendorDefinition = {
  key: "apollo",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = call.credentials.apiKey;
    if (!apiKey) throw new ProviderError("The Apollo API key is missing.", false);
    const { inputs } = call;
    const url = new URL(APOLLO_BASE);
    let method: "GET" | "POST";
    if (call.action === "enrich-person") {
      const email = text(inputs.email);
      const linkedin = text(inputs.linkedinUrl);
      const name = text(inputs.fullName);
      const domain = text(inputs.companyDomain);
      if (!email && !linkedin && !(name && domain)) throw new ProviderError("Apollo needs an email, a LinkedIn URL, or a full name with a company domain.", false);
      method = "POST";
      url.pathname = "/api/v1/people/match";
      if (email) url.searchParams.set("email", email);
      if (linkedin) url.searchParams.set("linkedin_url", linkedin);
      if (name) url.searchParams.set("name", name);
      if (domain) url.searchParams.set("domain", domain);
    } else if (call.action === "enrich-company") {
      const domain = text(inputs.companyDomain);
      if (!domain) throw new ProviderError("Apollo needs a company domain.", false);
      method = "GET";
      url.pathname = "/api/v1/organizations/enrich";
      url.searchParams.set("domain", domain);
    } else {
      throw new ProviderError(`Unknown Apollo action: ${call.action}`, false);
    }
    const request = { method, endpoint: url.pathname, inputKeys: Object.keys(inputs) };
    const response = await safeRequest(url, { method, headers: { Accept: "application/json", "Cache-Control": "no-cache", "x-api-key": stripLineBreaks(apiKey) } }, call.timeoutMs, net);
    const body = parseBody(response);
    if (response.status < 200 || response.status >= 300) {
      const detail = `Apollo returned ${response.status}: ${errorSnippet(body)}`;
      if (response.status === 401 || response.status === 403) throw new ProviderError(`${detail} Check the Apollo API key.`, false, { request, response: body });
      if (response.status === 429) throw new ProviderError(detail, true, { request, response: body }, retryAfterMs(response.retryAfter));
      throw new ProviderError(detail, isTransientStatus(response.status), { request, response: body });
    }
    if (call.action === "enrich-person") {
      const person = asRecord(asRecord(body).person);
      const confidence = text(person.match_confidence);
      // Apollo bills nothing for "none", and its fields then belong to nobody.
      const matched = confidence !== "none";
      const outputs = {
        email: matched ? person.email : null,
        emailStatus: matched ? person.email_status : null,
        title: matched ? person.title : null,
        company: matched ? asRecord(person.organization).name : null,
        linkedinUrl: matched ? person.linkedin_url : null,
        matchConfidence: confidence,
      };
      return answerWith(outputs, outputs.email, request, body);
    }
    const org = asRecord(asRecord(body).organization);
    const outputs = { name: org.name, industry: org.industry, employeeCount: org.estimated_num_employees, websiteUrl: org.website_url, linkedinUrl: org.linkedin_url, city: org.city, country: org.country };
    return answerWith(outputs, org.name, request, body);
  },

  // Only the `is_logged_in` flag is read, and nothing else leaves the check.
  checkKey(apiKey, check) {
    return check({ url: APOLLO_HEALTH_URL, headers: { "x-api-key": apiKey, accept: "application/json" }, map: standardStatus, inspect: (body) => (body.is_logged_in === false ? "rejected" : null) });
  },
};
