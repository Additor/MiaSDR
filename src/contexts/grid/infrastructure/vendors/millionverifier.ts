import { standardStatus } from "@/contexts/integrations/infrastructure/credential-verifier";
import { ProviderError, type ProviderAnswer } from "../../application/enrichment-ports";
import { isSettled, verificationStatus, type VerificationStatus } from "../../domain/enrichment-contracts";
import { stripLineBreaks } from "../../domain/enrichment-url-policy";
import { parseBody, safeRequest } from "../enrichment-http";
import { answerWith, asRecord, statusError, text, type VendorDefinition } from "./vendor-kit";

// MillionVerifier (https://developer.millionverifier.com/, help.millionverifier.com email-verification-results and
// refund-for-risky-emails). Docs read 2026-10-20. The API takes the key only as the `api` query parameter. The audit
// records the path, and the worker redacts the key in every encoded form.
// Run live on 2026-10-20 with an invalid key only: the key check and one call were refused as the code expects.
const VERIFY_URL = "https://api.millionverifier.com/api/v3/";
const CREDITS_URL = "https://api.millionverifier.com/api/v3/credits";

const STATUS: Record<string, VerificationStatus> = { ok: "valid", invalid: "invalid", catch_all: "catch_all", unknown: "unknown", disposable: "disposable" };

export const millionverifier: VendorDefinition = {
  key: "millionverifier",

  async execute(call, net): Promise<ProviderAnswer> {
    const apiKey = call.credentials.apiKey;
    if (!apiKey) throw new ProviderError("The MillionVerifier API key is missing.", false);
    if (call.action !== "verify-email") throw new ProviderError(`Unknown MillionVerifier action: ${call.action}`, false);
    const email = text(call.inputs.email);
    if (!email) throw new ProviderError("MillionVerifier needs an email.", false);
    const url = new URL(VERIFY_URL);
    url.searchParams.set("api", stripLineBreaks(apiKey));
    url.searchParams.set("email", email);
    url.searchParams.set("timeout", "20");
    const request = { method: "GET", endpoint: url.pathname, inputKeys: Object.keys(call.inputs) };
    const response = await safeRequest(url, { method: "GET", headers: { Accept: "application/json" } }, call.timeoutMs, net);
    const body = asRecord(parseBody(response));
    if (response.status < 200 || response.status >= 300) throw statusError("MillionVerifier", response, body, request);
    // Errors come back with HTTP 200, result "error" and an error text such as "apikey_not_found".
    const error = text(body.error);
    if (error || body.result === "error") throw new ProviderError(`MillionVerifier refused the request: ${(error ?? "error").slice(0, 300)}`, false, { request, response: { result: body.result, error } });

    const status = body.result === undefined || body.result === null ? null : verificationStatus(body.result, STATUS);
    const outputs = { email: body.email, status, providerStatus: body.result, score: null, subStatus: body.subresult, quality: body.quality, freeEmail: body.free, role: body.role, didYouMean: body.didyoumean };
    const kept = { email: body.email, result: body.result, subresult: body.subresult, quality: body.quality, free: body.free, role: body.role, didyoumean: body.didyoumean };
    // MillionVerifier refunds unknown and catch-all results as goodwill credits.
    return answerWith(outputs, status, request, kept, { hit: status !== null && isSettled(status), billable: status !== "unknown" && status !== "catch_all" });
  },

  checkKey(apiKey, check) {
    const url = `${CREDITS_URL}?${new URLSearchParams({ api: apiKey })}`;
    return check({ url, headers: { accept: "application/json" }, map: standardStatus, inspect: (body) => (text(body.error) ? "rejected" : typeof body.credits !== "number" ? "unverifiable" : null) });
  },
};
