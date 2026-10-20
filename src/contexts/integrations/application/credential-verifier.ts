import { ValidationError } from "@/shared/errors";

export type VerifyFailure = "unreachable" | "rejected" | "rate_limited" | "unverifiable";
/** `verified` is true only after a live check against the provider. A skipped check (fake mode, http adapter, unknown provider) leaves it false. */
export type VerifyResult = { ok: true; verified?: boolean } | { ok: false; reason: VerifyFailure };

/**
 * Checks a credential against the provider before it is stored. An adapter calls a fixed provider
 * endpoint only. It never receives a host from user input and never puts a value into a message.
 */
export interface CredentialVerifier {
  verify(providerKey: string, values: Record<string, string>, options?: { signal?: AbortSignal }): Promise<VerifyResult>;
}

/** The only texts a failed verification can produce. None of them contains request or response data. */
export function verifyFailureMessage(name: string, reason: VerifyFailure): string {
  switch (reason) {
    case "unreachable":
      return `${name} could not be reached. Check your connection and try again.`;
    case "rejected":
      return `${name} rejected this API key.`;
    case "rate_limited":
      return `${name} rate-limited verification. Try again shortly.`;
    case "unverifiable":
      return `${name} could not verify this account right now. Try again shortly.`;
  }
}

/** Throws a ValidationError (HTTP 422) with the fixed text when the provider does not accept the credential. Returns true only when a live check accepted it. */
export async function assertCredentialVerified(
  verifier: CredentialVerifier | undefined,
  provider: { key: string; name: string },
  values: Record<string, string>,
): Promise<boolean> {
  if (!verifier) return false;
  const result = await verifier.verify(provider.key, values);
  if (!result.ok) throw new ValidationError(verifyFailureMessage(provider.name, result.reason));
  return result.verified === true;
}
