import { and, eq, isNull } from "drizzle-orm";
import type { DbHandle } from "@/platform/db/client";
import { oauthConsents, oauthRefreshTokens } from "./schema";

/**
 * Ends what lets an app come back after its grant is revoked: its consent and refresh tokens. The app must then ask the
 * person again, rather than refresh into a token that the revoked `mcp_tokens` row refuses.
 */
export async function endOAuthGrantTx(tx: DbHandle, grant: { clientId: string; userId: string; organizationId: string }): Promise<void> {
  const ofGrant = (table: typeof oauthConsents | typeof oauthRefreshTokens) => and(eq(table.clientId, grant.clientId), eq(table.userId, grant.userId), eq(table.referenceId, grant.organizationId));
  await tx.delete(oauthConsents).where(ofGrant(oauthConsents));
  await tx.update(oauthRefreshTokens).set({ revoked: new Date() }).where(and(ofGrant(oauthRefreshTokens), isNull(oauthRefreshTokens.revoked)));
}
