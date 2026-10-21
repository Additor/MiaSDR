import { standardStatus } from "@/contexts/integrations/infrastructure/credential-verifier";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import { isSettled, percentScore, verificationStatus, type VerificationStatus } from "../../domain/enrichment-contracts";
import { answerWith, apiKeyOf, asRecord, errorSnippet, send, statusError, type VendorDefinition } from "./vendor-kit";

// Hunter (https://hunter.io/api-documentation/v2, help.hunter.io/en/articles/12631167). The caller brings their own key.
// Docs read 2026-10-21: 403 is the rate limit, 429 the spent usage quota, and a lookup that finds nothing or a
// verification that ends unknown costs no credit.
const HUNTER_BASE = "https://api.hunter.io/v2";
const HUNTER_ACCOUNT_URL = "https://api.hunter.io/v2/account";

// Hunter's verifier words (https://hunter.io/api-documentation/v2#email-verifier). Webmail only names the host (Gmail,
// Outlook) and carries an arbitrary score of 50, so it does not settle an address.
const STATUS: Record<string, VerificationStatus> = { valid: "valid", invalid: "invalid", accept_all: "catch_all", webmail: "unknown", disposable: "disposable", unknown: "unknown" };

export const hunter: VendorDefinition = {
  key: "hunter",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = apiKeyOf(call, "Hunter");
    const url = new URL(HUNTER_BASE);
    const { inputs } = call;
    if (call.action === "verify-email") {
      url.pathname = "/v2/email-verifier";
      url.searchParams.set("email", String(inputs.email));
    } else if (call.action === "find-emails-by-company") {
      url.pathname = "/v2/domain-search";
      url.searchParams.set("domain", String(inputs.companyDomain));
      url.searchParams.set("limit", "10");
    } else if (call.action === "find-work-email") {
      url.pathname = "/v2/email-finder";
      // Hunter takes a domain or a company name; the domain matches better.
      if (inputs.companyDomain) url.searchParams.set("domain", String(inputs.companyDomain));
      else url.searchParams.set("company", String(inputs.companyName));
      url.searchParams.set("full_name", String(inputs.fullName));
    } else {
      throw new ProviderError(`Unknown Hunter action: ${call.action}`, false);
    }
    const { request, response, body } = await send(call, net, url, { method: "GET", headers: { "X-API-KEY": apiKey } });
    if (response.status === 202) throw new ProviderError("Hunter is still verifying this address. It will be asked again.", true, { request, response: body });
    // 222: the mail server gave Hunter an unexpected answer. Hunter advises asking again later.
    if (response.status === 222) throw new ProviderError("Hunter could not verify this address right now. It will be asked again.", true, { request, response: body });
    if (response.status === 429) throw new ProviderError(`Hunter returned 429: ${errorSnippet(body)} The Hunter account reached its usage limit.`, false, { request, response: body });
    if (response.status === 451) throw new ProviderError("Hunter returned 451: this person asked Hunter not to process their data.", false, { request, response: body });
    // 403 is Hunter's rate limit; it clears on its own.
    if (response.status < 200 || response.status >= 300) throw statusError("Hunter", response, body, request, { forbiddenIsLimit: true });
    // The ledger keeps the fields read here. A domain search lists other people, so only their addresses stay.
    const data = asRecord(asRecord(body).data);
    if (call.action === "verify-email") {
      const status = data.status === undefined || data.status === null ? null : verificationStatus(data.status, STATUS);
      const outputs = { email: data.email, status, providerStatus: data.status, score: percentScore(data.score), acceptAll: data.accept_all, disposable: data.disposable, webmail: data.webmail };
      const kept = { data: { email: data.email, status: data.status, result: data.result, score: data.score, accept_all: data.accept_all, disposable: data.disposable, webmail: data.webmail } };
      return answerWith(outputs, status, request, kept, { hit: status !== null && isSettled(status), billable: data.status !== "unknown" });
    }
    if (call.action === "find-emails-by-company") {
      const emails = Array.isArray(data.emails) ? data.emails : [];
      const firstEmail = asRecord(emails[0]).value;
      const kept = { data: { domain: data.domain, organization: data.organization, pattern: data.pattern, emails: emails.map((e) => ({ value: asRecord(e).value, type: asRecord(e).type, confidence: asRecord(e).confidence })) } };
      return answerWith({ emails, emailCount: emails.length, firstEmail, organization: data.organization, pattern: data.pattern }, firstEmail, request, kept, emails.length ? {} : { billable: false });
    }
    const verification = asRecord(data.verification).status;
    const outputs = {
      email: data.email,
      confidence: percentScore(data.score),
      verificationStatus: verification === undefined || verification === null ? null : verificationStatus(verification, STATUS),
      score: data.score,
      position: data.position,
      linkedinUrl: data.linkedin_url,
    };
    const kept = { data: { email: data.email, score: data.score, position: data.position, linkedin_url: data.linkedin_url, verification: data.verification } };
    return answerWith(outputs, data.email, request, kept, data.email ? {} : { billable: false });
  },

  // Hunter answers 403 for usage limits, which clear on their own. 401 is a bad key.
  checkKey(apiKey, check) {
    return check({ url: HUNTER_ACCOUNT_URL, headers: { "X-API-KEY": apiKey, accept: "application/json" }, map: (status) => (status === 403 ? "rate_limited" : standardStatus(status)) });
  },
};
