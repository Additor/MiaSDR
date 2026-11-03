import type { MemberAgentAccess } from "@/contexts/tenancy/application/member-management";
import { recordAudit } from "@/contexts/tenancy/infrastructure/audit";
import { lockAgentSend, revokeMcpTokensTx } from "./agent-send-lock";

/** Tenancy's member changes take the agent-send lock first, and a removal revokes the member's tokens and audits it. */
export const memberAgentAccess: MemberAgentAccess = {
  async lock(tx, organizationId) {
    await lockAgentSend(tx, organizationId);
  },
  async memberRemoved(tx, { organizationId, userId, actorUserId }) {
    const revoked = await revokeMcpTokensTx(tx, organizationId, { userId });
    if (revoked > 0) await recordAudit(tx, { organizationId, actorUserId, action: "mcp.member_tokens_revoked", entityType: "user", entityId: userId, meta: { count: revoked } });
  },
};
