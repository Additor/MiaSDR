import { standardStatus } from "@/contexts/integrations/infrastructure/credential-verifier";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import { isSettled, percentScore, verificationStatus, type VerificationStatus } from "../../domain/enrichment-contracts";
import { stripLineBreaks } from "../../domain/enrichment-url-policy";
import { isTransientStatus, parseBody, safeRequest } from "../enrichment-http";
import { answerWith, asRecord, errorSnippet, type VendorDefinition } from "./vendor-kit";

// Hunter (https://hunter.io/api-documentation/v2). The caller brings their own key.
const HUNTER_BASE = "https://api.hunter.io/v2";
const HUNTER_ACCOUNT_URL = "https://api.hunter.io/v2/account";

// Hunter's verifier words (https://hunter.io/api-documentation/v2#email-verifier). A webmail address exists.
const STATUS: Record<string, VerificationStatus> = { valid: "valid", invalid: "invalid", accept_all: "catch_all", webmail: "valid", disposable: "disposable", unknown: "unknown" };

export const hunter: VendorDefinition = {
  key: "hunter",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = call.credentials.apiKey;
    if (!apiKey) throw new ProviderError("The Hunter API key is missing.", false);
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
      url.searchParams.set("domain", String(inputs.companyDomain));
      url.searchParams.set("full_name", String(inputs.fullName));
    } else {
      throw new ProviderError(`Unknown Hunter action: ${call.action}`, false);
    }
    const request = { method: "GET", endpoint: url.pathname, inputKeys: Object.keys(inputs) };
    const response = await safeRequest(url, { method: "GET", headers: { Accept: "application/json", "X-API-KEY": stripLineBreaks(apiKey) } }, call.timeoutMs, net);
    const body = parseBody(response);
    if (response.status === 202) throw new ProviderError("Hunter is still verifying this address. It will be asked again.", true, { request, response: body });
    // 222: the mail server gave Hunter an unexpected answer. Hunter advises asking again later.
    if (response.status === 222) throw new ProviderError("Hunter could not verify this address right now. It will be asked again.", true, { request, response: body });
    if (response.status < 200 || response.status >= 300) {
      // 403 is Hunter's usage and rate limit; it clears on its own.
      const transient = response.status === 403 || isTransientStatus(response.status);
      throw new ProviderError(`Hunter returned ${response.status}: ${errorSnippet(body)}`, transient, { request, response: body });
    }
    const data = asRecord(asRecord(body).data);
    if (call.action === "verify-email") {
      const status = data.status === undefined || data.status === null ? null : verificationStatus(data.status, STATUS);
      const outputs = { email: data.email, status, providerStatus: data.status, score: percentScore(data.score), acceptAll: data.accept_all, disposable: data.disposable, webmail: data.webmail };
      return answerWith(outputs, status, request, body, { hit: status !== null && isSettled(status) });
    }
    if (call.action === "find-emails-by-company") {
      const emails = Array.isArray(data.emails) ? data.emails : [];
      const firstEmail = asRecord(emails[0]).value;
      return answerWith({ emails, emailCount: emails.length, firstEmail, organization: data.organization, pattern: data.pattern }, firstEmail, request, body);
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
    return answerWith(outputs, data.email, request, body);
  },

  // Hunter answers 403 for usage limits, which clear on their own. 401 is a bad key.
  checkKey(apiKey, check) {
    return check({ url: HUNTER_ACCOUNT_URL, headers: { "X-API-KEY": apiKey, accept: "application/json" }, map: (status) => (status === 403 ? "rate_limited" : standardStatus(status)) });
  },
};
