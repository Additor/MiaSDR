/**
 * transient: worth another attempt later (rate limit, timeout, malformed answer).
 * permanent: retrying cannot help (bad key, rejected request, content refused).
 */
export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: "transient" | "permanent",
    /** `shape`: the provider answered, but not in the requested form. Retries may help, so it is transient until the attempts run out. */
    readonly reason?: "shape",
  ) {
    super(message);
  }
}
