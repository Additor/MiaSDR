import { verifyUnsubscribeToken } from "../domain/unsubscribe-token";

/** Port. Suppresses one address in one organization and stops its active sequences. */
export interface SuppressionStore {
  suppressEmail(input: { organizationId: string; email: string; reason: "unsubscribed" | "bounced" | "manual" | "complaint"; note?: string }): Promise<{ stopped: number }>;
}

export class InvalidUnsubscribeToken extends Error {
  constructor() {
    super("This unsubscribe link is invalid or has been altered.");
  }
}

/** Idempotent: unsubscribing twice is fine. */
export async function unsubscribeByToken(deps: { store: SuppressionStore; secret: string }, token: string): Promise<{ email: string }> {
  const verified = verifyUnsubscribeToken(deps.secret, token);
  if (!verified) throw new InvalidUnsubscribeToken();
  await deps.store.suppressEmail({ organizationId: verified.organizationId, email: verified.email, reason: "unsubscribed" });
  return { email: verified.email };
}
