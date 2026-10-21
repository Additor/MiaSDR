import { standardStatus } from "@/contexts/integrations/infrastructure/credential-verifier";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import { isSettled, verificationStatus, type VerificationStatus } from "../../domain/enrichment-contracts";
import { stripLineBreaks } from "../../domain/enrichment-url-policy";
import { parseBody, safeRequest } from "../enrichment-http";
import { answerWith, asRecord, statusError, text, type VendorDefinition } from "./vendor-kit";

// NeverBounce (https://developers.neverbounce.com/reference/single-check, account-info, error-handling,
// usage-guidelines). Docs read 2026-10-20. The key goes in the `key` query parameter, and a bad-key message repeats it,
// which the worker's cleanError removes. NeverBounce asks that single checks not loop over a whole list; a table run is
// one check per cell the person queued.
// Run live on 2026-10-20 with an invalid key only: the key check and one call were refused as the code expects.
const CHECK_URL = "https://api.neverbounce.com/v4.2/single/check";
const ACCOUNT_URL = "https://api.neverbounce.com/v4.2/account/info";

const STATUS: Record<string, VerificationStatus> = { valid: "valid", invalid: "invalid", disposable: "disposable", catchall: "catch_all", unknown: "unknown" };

export const neverbounce: VendorDefinition = {
  key: "neverbounce",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = call.credentials.apiKey;
    if (!apiKey) throw new ProviderError("The NeverBounce API key is missing.", false);
    if (call.action !== "verify-email") throw new ProviderError(`Unknown NeverBounce action: ${call.action}`, false);
    const email = text(call.inputs.email);
    if (!email) throw new ProviderError("NeverBounce needs an email.", false);
    const url = new URL(CHECK_URL);
    url.searchParams.set("key", stripLineBreaks(apiKey));
    url.searchParams.set("email", email);
    // NeverBounce advises about ten seconds and reads a timeout as unknown, which moves a waterfall on.
    url.searchParams.set("timeout", "10");
    const request = { method: "GET", endpoint: url.pathname, inputKeys: Object.keys(call.inputs) };
    const response = await safeRequest(url, { method: "GET", headers: { Accept: "application/json" } }, call.timeoutMs, net);
    const body = asRecord(parseBody(response));
    if (response.status < 200 || response.status >= 300) throw statusError("NeverBounce", response, body, request);
    // API errors come back with HTTP 200 and a status other than "success".
    if (body.status !== "success") {
      const audit = { request, response: { status: body.status, message: body.message } };
      const message = `NeverBounce returned ${String(body.status ?? "no status")}: ${(text(body.message) ?? "request failed").slice(0, 300)}`;
      if (body.status === "auth_failure") throw new ProviderError(`${message} Check the NeverBounce API key.`, false, audit);
      throw new ProviderError(message, body.status === "temp_unavail" || body.status === "throttle_triggered", audit);
    }
    const flags = Array.isArray(body.flags) ? body.flags.filter((f): f is string => typeof f === "string") : [];
    const status = body.result === undefined || body.result === null ? null : verificationStatus(body.result, STATUS);
    const outputs = { email, status, providerStatus: body.result, score: null, flags, freeEmail: flags.includes("free_email_host"), role: flags.includes("role_account"), didYouMean: text(body.suggested_correction) };
    const kept = { status: body.status, result: body.result, flags, suggested_correction: body.suggested_correction };
    return answerWith(outputs, status, request, kept, { hit: status !== null && isSettled(status) });
  },

  checkKey(apiKey, check) {
    const url = `${ACCOUNT_URL}?${new URLSearchParams({ key: apiKey })}`;
    return check({ url, headers: { accept: "application/json" }, map: standardStatus, inspect: (body) => (body.status === "success" ? null : body.status === "auth_failure" ? "rejected" : "unverifiable") });
  },
};
