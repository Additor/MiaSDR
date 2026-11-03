import { memberAgentAccess } from "@/contexts/agent-access/infrastructure/member-access-composition";
import { releaseLinkedInAccounts } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import type { MemberDeps } from "@/contexts/tenancy/application/member-management";
import { memberDeps as tenancyMemberDeps } from "@/contexts/tenancy/infrastructure/member-composition";

/** Tenancy's member use cases, with agent access's lock and revoke inside each member change. */
export const memberDeps = (): MemberDeps => tenancyMemberDeps(memberAgentAccess);

/** Removing a member: tenancy deletes the membership, agent access revokes their tokens, and outreach clears the LinkedIn accounts the member owned. */
export const memberRemovalDeps = (): MemberDeps => ({ ...memberDeps(), released: releaseLinkedInAccounts });
