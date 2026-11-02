import "server-only";

import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { jwt, organization } from "better-auth/plugins";
import { db } from "@/platform/db/client";
import * as schema from "@/platform/db/schema";
import { env } from "@/shared/env";
import { CONSENT_PAGE, MCP_OAUTH_SCOPES, MCP_ORG_CLAIM, mcpOAuthAvailable, mcpResourceUrl } from "../domain/mcp-oauth";
import { authEmail, sendAuthEmail } from "./auth-email";
import { e2eRateLimitStorage } from "./e2e-rate-limit";
import { canCreateAccount, canCreateOrganization, initialOrganizationId } from "./signup-facts";

const sendQuietly = (message: Parameters<typeof sendAuthEmail>[0], what: string) =>
  // Not awaited: waiting on delivery would leak, through response timing,
  // whether an address has an account.
  void sendAuthEmail(message).catch((error) => console.error(`[auth] ${what} email failed:`, error));

function refuseBypass(message: string): never {
  throw new APIError("FORBIDDEN", { message });
}

/**
 * The OAuth server for MCP clients. An access token lasts an hour and names the organization the session had active when
 * the person agreed, which is the grant's organization. Consent goes only through `POST /api/oauth/consent`, which
 * records the grant in `mcp_tokens`. The `/token` path stays off: it would hand any session a JWT no one needs.
 */
function mcpOAuthPlugins(e: ReturnType<typeof env>) {
  if (!mcpOAuthAvailable(e.APP_URL, e.MCP_ENABLED)) return [];
  return [
    jwt({ disableSettingJwtHeader: true }),
    mcp({
      resource: mcpResourceUrl(e.APP_URL),
      loginPage: "/sign-in",
      consentPage: CONSENT_PAGE,
      scopes: [...MCP_OAUTH_SCOPES],
      grantTypes: ["authorization_code", "refresh_token"],
      allowDynamicClientRegistration: e.MCP_OAUTH_DCR,
      allowUnauthenticatedClientRegistration: e.MCP_OAUTH_DCR,
      clientRegistrationDefaultApplicationType: "infer",
      postLogin: {
        page: CONSENT_PAGE,
        shouldRedirect: () => false,
        consentReferenceId: ({ session }) => {
          const organizationId = (session as { activeOrganizationId?: string | null }).activeOrganizationId;
          if (!organizationId) throw new APIError("FORBIDDEN", { message: "Join an organization before you connect an app." });
          return organizationId;
        },
      },
      customAccessTokenClaims: ({ referenceId }) => ({ [MCP_ORG_CLAIM]: referenceId }),
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
  ];
}

function createAuth() {
  const e = env();
  const customRateLimitStorage = e2eRateLimitStorage();
  const googleConfigured = Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);

  return betterAuth({
    appName: "MiaSDR",
    baseURL: e.APP_URL,
    secret: e.BETTER_AUTH_SECRET,
    trustedOrigins: [e.APP_URL],
    database: drizzleAdapter(db, { provider: "pg", schema, usePlural: true }),
    advanced: { database: { generateId: "uuid" } },
    // Only the e2e build swaps the store, so the specs can reset the counters between files.
    rateLimit: {
      // Self-registration needs no account, so one address may add only so many clients.
      customRules: { "/oauth2/register": { window: 60 * 60, max: 20 } },
      ...(customRateLimitStorage ? { customStorage: customRateLimitStorage } : {}),
    },

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) =>
        sendQuietly(
          authEmail({
            to: user.email,
            subject: "Reset your MiaSDR password",
            intro: "Someone asked to reset the password for this MiaSDR account.",
            action: "Choose a new password",
            url,
          }),
          "reset",
        ),
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) =>
        sendQuietly(
          authEmail({
            to: user.email,
            subject: "Confirm your email for MiaSDR",
            intro: `Welcome to MiaSDR, ${user.name}. Confirm this is your email address to finish creating your account.`,
            action: "Confirm email",
            url,
          }),
          "verification",
        ),
    },

    socialProviders: googleConfigured
      ? {
          google: {
            clientId: e.GOOGLE_CLIENT_ID!,
            clientSecret: e.GOOGLE_CLIENT_SECRET!,
            prompt: "select_account",
          },
        }
      : {},

    account: { accountLinking: { enabled: true, trustedProviders: ["google"] } },

    // Most requests answer from a signed cookie. A revoked session or role
    // change can take up to this long to apply.
    session: { cookieCache: { enabled: true, maxAge: 2 * 60 } },

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!(await canCreateAccount(user.email))) {
              throw new APIError("FORBIDDEN", {
                message: "Sign-up on this MiaSDR instance is by invitation only. Ask an admin to invite you.",
              });
            }
          },
        },
      },
      session: {
        create: {
          before: async (session) => ({
            data: {
              ...session,
              activeOrganizationId: session.activeOrganizationId ?? (await initialOrganizationId(session.userId)),
            },
          }),
        },
      },
    },

    disabledPaths: ["/token"],

    plugins: [
      // Typed away: their endpoints reach the code only through `mcp-oauth.ts`, and a plugin list that may be empty would hide the organization plugin's session field from every caller.
      ...(mcpOAuthPlugins(e) as []),
      organization({
        allowUserToCreateOrganization: (user) => canCreateOrganization(user.id),
        invitationExpiresIn: 7 * 24 * 60 * 60,
        cancelPendingInvitationsOnReInvite: true,
        // The tenancy use cases never delete an organization through Better Auth, and no tool for it exists yet.
        disableOrganizationDeletion: true,
        // Renames, role changes and removals go through the tenancy use cases, which write to the database
        // directly. These hooks only fire for a call through Better Auth, so a rejection here closes the bypass
        // for server code too, next to the path allow-list in the /api/auth route handler.
        organizationHooks: {
          beforeUpdateOrganization: async () => refuseBypass("Rename the organization from Settings."),
          beforeUpdateMemberRole: async () => refuseBypass("Change roles from the Members page."),
          beforeRemoveMember: async () => refuseBypass("Remove members from the Members page."),
          beforeDeleteOrganization: async () => refuseBypass("Deleting an organization is not available."),
        },
        sendInvitationEmail: async ({ id, email, organization, inviter }) =>
          sendQuietly(
            authEmail({
              to: email,
              subject: `${inviter.user.name} invited you to ${organization.name} on MiaSDR`,
              intro: `${inviter.user.name} (${inviter.user.email}) invited you to join ${organization.name} on MiaSDR.`,
              action: "Accept invitation",
              url: `${e.APP_URL}/accept-invitation/${id}`,
              outro: "This invitation expires in 7 days. If you weren't expecting it, ignore this email.",
            }),
            "invitation",
          ),
      }),
      // Must stay last: lets server actions set Better Auth's cookies.
      nextCookies(),
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;
const globalForAuth = globalThis as unknown as { __miasdrAuth?: Auth };

/** Created on first use so `next build` needs no secrets. */
export function auth(): Auth {
  globalForAuth.__miasdrAuth ??= createAuth();
  return globalForAuth.__miasdrAuth;
}
