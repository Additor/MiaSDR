import { releaseLinkedInAccounts } from "@/contexts/outreach/linkedin/infrastructure/linkedin-composition";
import type { MemberDeps } from "@/contexts/tenancy/application/member-management";
import { memberDeps } from "@/contexts/tenancy/infrastructure/member-composition";

/** Removing a member: tenancy deletes the membership, and outreach clears the LinkedIn accounts the member owned. */
export const memberRemovalDeps = (): MemberDeps => ({ ...memberDeps(), released: releaseLinkedInAccounts });
