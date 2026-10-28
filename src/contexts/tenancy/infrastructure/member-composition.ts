import "server-only";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { auth } from "@/contexts/identity/infrastructure/auth";
import { ValidationError } from "@/shared/errors";
import type { InvitationReader } from "../application/invitation-view";
import type { InvitationGateway, MemberDeps } from "../application/member-management";
import { drizzleInvitationReader } from "./drizzle-invitation-reader";
import { drizzleMemberDirectory } from "./drizzle-member-directory";
import { drizzleMemberStore } from "./drizzle-member-store";

/** Better Auth creates the row, applies its expiry and re-invite rules, and sends the email. */
export const betterAuthInvitations: InvitationGateway = {
  async invite(actor, input) {
    try {
      const created = await auth().api.createInvitation({
        headers: await headers(),
        body: { email: input.email, role: input.role, organizationId: actor.organizationId },
      });
      return { id: created.id };
    } catch (error) {
      if (error instanceof APIError) throw new ValidationError(error.message || "Could not create the invitation.");
      throw error;
    }
  },
};

export const memberDeps = (): MemberDeps => ({ members: drizzleMemberStore, invitations: betterAuthInvitations });

/** Reads one invitation for the accept page and its API route. */
export const invitationViewDeps = (): { invitations: InvitationReader } => ({ invitations: drizzleInvitationReader });

/** Owner and assignee pickers: the organization's members by name. */
export const memberDirectoryDeps = () => ({ directory: drizzleMemberDirectory });
