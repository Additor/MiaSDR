import { memberAgentAccess } from "@/contexts/agent-access/infrastructure/member-access-composition";
import { releaseMiaOfMemberTx } from "@/contexts/mia/infrastructure/drizzle-mia-chat-store";
import { releaseLinkedInAccounts } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import type { MemberDeps } from "@/contexts/tenancy/application/member-management";
import { memberDeps as tenancyMemberDeps } from "@/contexts/tenancy/infrastructure/member-composition";

/** Tenancy's member use cases, with agent access's lock and revoke inside each member change. */
export const memberDeps = (): MemberDeps => tenancyMemberDeps(memberAgentAccess);

/**
 * Removing a member: tenancy deletes the membership, agent access revokes their tokens, outreach clears the LinkedIn
 * accounts the member owned, and Mia deletes their chats and stops the jobs they started.
 */
export const memberRemovalDeps = (): MemberDeps => ({
  ...memberDeps(),
  released: async (tx, organizationId, userId) => {
    await releaseLinkedInAccounts(tx, organizationId, userId);
    await releaseMiaOfMemberTx(tx, organizationId, userId);
  },
});
