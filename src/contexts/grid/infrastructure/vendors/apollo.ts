import { standardStatus } from "@/contexts/integrations/infrastructure/credential-verifier";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import { answerWith, apiKeyOf, asRecord, send, statusError, text, type VendorDefinition } from "./vendor-kit";

// Apollo (https://docs.apollo.io/reference/people-enrichment, .../organization-enrichment).
// The caller brings their own key. Docs read 2026-10-16; not exercised against a live key.
const APOLLO_BASE = "https://api.apollo.io/api/v1";
// Apollo lists GET /auth/health in its authentication docs (2026-10-16) without a bad-key status. Not run live.
const APOLLO_HEALTH_URL = "https://api.apollo.io/api/v1/auth/health";

export const apollo: VendorDefinition = {
  key: "apollo",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = apiKeyOf(call, "Apollo");
    const { inputs } = call;
    const url = new URL(APOLLO_BASE);
    let method: "GET" | "POST";
    if (call.action === "enrich-person") {
      const email = text(inputs.email);
      const linkedin = text(inputs.linkedinUrl);
      const name = text(inputs.fullName);
      const domain = text(inputs.companyDomain);
      const company = text(inputs.companyName);
      if (!email && !linkedin && !(name && (domain || company))) throw new ProviderError("Apollo needs an email, a LinkedIn URL, or a full name with a company domain or name.", false);
      method = "POST";
      url.pathname = "/api/v1/people/match";
      if (email) url.searchParams.set("email", email);
      if (linkedin) url.searchParams.set("linkedin_url", linkedin);
      if (name) url.searchParams.set("name", name);
      if (domain) url.searchParams.set("domain", domain);
      else if (company) url.searchParams.set("organization_name", company);
    } else if (call.action === "enrich-company") {
      const domain = text(inputs.companyDomain);
      if (!domain) throw new ProviderError("Apollo needs a company domain.", false);
      method = "GET";
      url.pathname = "/api/v1/organizations/enrich";
      url.searchParams.set("domain", domain);
    } else {
      throw new ProviderError(`Unknown Apollo action: ${call.action}`, false);
    }
    const { request, response, body } = await send(call, net, url, { method, headers: { "Cache-Control": "no-cache", "x-api-key": apiKey } });
    // 403 also covers a key without access to the endpoint (API_INACCESSIBLE).
    if (response.status < 200 || response.status >= 300) throw statusError("Apollo", response, body, request);
    // The ledger keeps the fields read here, not the person's or the company's whole record.
    if (call.action === "enrich-person") {
      const person = asRecord(asRecord(body).person);
      const confidence = text(person.match_confidence);
      // Apollo bills nothing when it finds no one or answers "none", and the fields of a "none" belong to nobody.
      const matched = Object.keys(person).length > 0 && confidence !== "none";
      // A "low" match may be someone else, and its work email would send mail to the wrong person. Like PDL's likelihood
      // floor, it reads as a miss: only Match confidence fills, and a waterfall asks the next vendor. Apollo may still
      // bill it, so the call stays billable.
      const trusted = matched && confidence !== "low";
      // An address nobody on the account has revealed comes back as email_not_unlocked@<domain>.
      const email = text(person.email);
      const outputs = {
        email: trusted && email && !/^email_not_unlocked@/i.test(email) ? email : null,
        emailStatus: trusted ? person.email_status : null,
        title: trusted ? person.title : null,
        company: trusted ? asRecord(person.organization).name : null,
        linkedinUrl: trusted ? person.linkedin_url : null,
        matchConfidence: confidence,
      };
      const kept = trusted
        ? { person: { id: person.id, match_confidence: person.match_confidence, email: person.email, email_status: person.email_status, title: person.title, linkedin_url: person.linkedin_url, organization: { name: asRecord(person.organization).name } } }
        : { person: Object.keys(person).length ? { match_confidence: person.match_confidence } : null };
      return answerWith(outputs, outputs.email, request, kept, matched ? {} : { billable: false });
    }
    const org = asRecord(asRecord(body).organization);
    const outputs = { name: org.name, industry: org.industry, employeeCount: org.estimated_num_employees, websiteUrl: org.website_url, linkedinUrl: org.linkedin_url, city: org.city, country: org.country };
    const kept = { organization: Object.keys(org).length ? { name: org.name, industry: org.industry, estimated_num_employees: org.estimated_num_employees, website_url: org.website_url, linkedin_url: org.linkedin_url, city: org.city, country: org.country } : null };
    // No organization means no match, which Apollo does not bill.
    return answerWith(outputs, org.name, request, kept, Object.keys(org).length ? {} : { billable: false });
  },

  // Only the `is_logged_in` flag is read, and nothing else leaves the check.
  checkKey(apiKey, check) {
    return check({ url: APOLLO_HEALTH_URL, headers: { "x-api-key": apiKey, accept: "application/json" }, map: standardStatus, inspect: (body) => (body.is_logged_in === false ? "rejected" : null) });
  },
};
