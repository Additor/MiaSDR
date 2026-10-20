import { standardStatus } from "@/contexts/integrations/infrastructure/credential-verifier";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import { isSettled, verificationStatus, type VerificationStatus } from "../../domain/enrichment-contracts";
import { stripLineBreaks } from "../../domain/enrichment-url-policy";
import { parseBody, safeRequest } from "../enrichment-http";
import { answerWith, asRecord, statusError, text, type VendorDefinition } from "./vendor-kit";

// ZeroBounce (https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails, v2-status-codes,
// v2-credit-balance). Docs read 2026-10-20. The key goes in a form body, so it never sits in a URL; the credit check is a
// GET and takes it as a query parameter. The regional hosts (api-us, api-eu) are not offered.
// Run live on 2026-10-20 with an invalid key only: the key check and one call were refused as the code expects.
const VALIDATE_URL = "https://api.zerobounce.net/v2/validate";
const CREDITS_URL = "https://api.zerobounce.net/v2/getcredits";

const STATUS: Record<string, VerificationStatus> = { valid: "valid", invalid: "invalid", "catch-all": "catch_all", unknown: "unknown", spamtrap: "invalid", abuse: "invalid", do_not_mail: "invalid" };

/** do_not_mail covers addresses that exist but should not be mailed; three of its sub-statuses say more than "invalid". */
function zeroBounceStatus(status: unknown, subStatus: string | null): VerificationStatus {
  if (status === "do_not_mail") {
    if (subStatus === "disposable") return "disposable";
    if (subStatus === "role_based") return "valid";
    if (subStatus === "role_based_catch_all") return "catch_all";
  }
  return verificationStatus(status, STATUS);
}

export const zerobounce: VendorDefinition = {
  key: "zerobounce",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = call.credentials.apiKey;
    if (!apiKey) throw new ProviderError("The ZeroBounce API key is missing.", false);
    if (call.action !== "verify-email") throw new ProviderError(`Unknown ZeroBounce action: ${call.action}`, false);
    const email = text(call.inputs.email);
    if (!email) throw new ProviderError("ZeroBounce needs an email.", false);
    const url = new URL(VALIDATE_URL);
    const request = { method: "POST", endpoint: url.pathname, inputKeys: Object.keys(call.inputs) };
    const form = new URLSearchParams({ api_key: stripLineBreaks(apiKey), email, ip_address: "" }).toString();
    const response = await safeRequest(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: form }, call.timeoutMs, net);
    const body = asRecord(parseBody(response));
    if (response.status < 200 || response.status >= 300) throw statusError("ZeroBounce", response, body, request);
    // ZeroBounce answers a bad key and an empty balance with one error body, often with HTTP 200.
    const error = text(body.error);
    if (error) throw new ProviderError(`ZeroBounce refused the request: ${error.slice(0, 300)}`, false, { request, response: { error } });

    const subStatus = text(body.sub_status);
    const status = body.status === undefined || body.status === null ? null : zeroBounceStatus(body.status, subStatus);
    const outputs = {
      email: body.address,
      status,
      providerStatus: body.status,
      score: null,
      subStatus,
      freeEmail: body.free_email,
      role: subStatus === "role_based" || subStatus === "role_based_catch_all",
      didYouMean: body.did_you_mean,
    };
    // ZeroBounce charges nothing for unknown. The ledger keeps the verdict, not the name, gender and place it may add.
    const kept = { address: body.address, status: body.status, sub_status: body.sub_status, free_email: body.free_email, did_you_mean: body.did_you_mean };
    return answerWith(outputs, status, request, kept, { hit: status !== null && isSettled(status), billable: status !== "unknown" });
  },

  // A bad key answers {"Credits": -1}. Two hundred bad-key calls in an hour block the check for a day, so it is never retried.
  checkKey(apiKey, check) {
    const url = `${CREDITS_URL}?${new URLSearchParams({ api_key: apiKey })}`;
    return check({ url, headers: { accept: "application/json" }, map: standardStatus, inspect: (body) => (typeof body.Credits !== "number" ? "unverifiable" : body.Credits < 0 ? "rejected" : null) });
  },
};
