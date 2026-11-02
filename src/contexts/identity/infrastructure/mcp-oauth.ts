import "server-only";

import { oauthProviderAuthServerMetadata, verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { env } from "@/shared/env";
import { MCP_ORG_CLAIM, mcpIssuerUrl, mcpOAuthAvailable, mcpResourceUrl } from "../domain/mcp-oauth";
import { auth } from "./auth";

export interface McpAccessClaims {
  userId: string;
  organizationId: string;
  clientId: string;
  scopes: string[];
}

/** A signed token has three dot-separated parts. Anything else costs no key lookup. */
export const looksLikeJwt = (token: string): boolean => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);

/**
 * The claims of an access token this server issued for its MCP endpoint, or null. Issuer, audience and type are all
 * checked, so a session JWT or a token for another resource does not pass. A token bound to a DPoP key is refused: this
 * endpoint checks no proof, and the metadata routes do not offer DPoP. Whether the grant is still live is the caller's
 * check, against `mcp_tokens`.
 */
export async function verifyMcpAccessToken(token: string): Promise<McpAccessClaims | null> {
  const { APP_URL, MCP_ENABLED } = env();
  if (!mcpOAuthAvailable(APP_URL, MCP_ENABLED) || !looksLikeJwt(token)) return null;
  try {
    const keys = await oauthApi().getJwks();
    const { payload } = await jwtVerify(token, createLocalJWKSet(keys), { issuer: mcpIssuerUrl(APP_URL), audience: mcpResourceUrl(APP_URL), typ: "at+jwt", requiredClaims: ["sub", "azp", MCP_ORG_CLAIM] });
    if (payload.cnf) return null;
    return { userId: String(payload.sub), organizationId: String(payload[MCP_ORG_CLAIM]), clientId: String(payload.azp), scopes: String(payload.scope ?? "").split(" ").filter(Boolean) };
  } catch {
    return null;
  }
}

/** The server's RFC 8414 metadata, with DPoP left out, since the endpoint does not check proofs. */
export async function authServerMetadata(request: Request): Promise<Response> {
  const metadata = await oauthProviderAuthServerMetadata(auth() as never)(request);
  const body = (await metadata.json()) as Record<string, unknown>;
  delete body.dpop_signing_alg_values_supported;
  return Response.json(body, { headers: { "Cache-Control": "public, max-age=300" } });
}

/** These endpoints come from a plugin the `auth()` type leaves out (`auth.ts`). */
const oauthApi = () =>
  auth().api as unknown as {
    getJwks(): Promise<JSONWebKeySet>;
    getOAuthClientPublic(args: unknown): Promise<{ client_name?: string; client_uri?: string }>;
    oauth2Consent(args: unknown): Promise<Response>;
  };

/** What the consent page may say about an app, or null for an app the server does not know. */
export const oauthClientFor = (clientId: string, headers: Headers) => oauthApi().getOAuthClientPublic({ headers, query: { client_id: clientId } }).catch(() => null);

/** Whether the query the consent page was opened with is one this server signed and has not expired. */
export const consentQueryValid = async (query: string): Promise<boolean> => verifyOAuthQueryParams(query, (await auth().$context).secret);

/** Sends the person's answer to the OAuth server. Answers where the browser goes next, or null. It reads the original request, and with one it answers a `Response`. */
export async function answerConsent(request: Request, headers: Headers, input: { accept: boolean; query: string; scope?: string }): Promise<string | null> {
  const answer = await oauthApi().oauth2Consent({ request, asResponse: true, headers, body: { accept: input.accept, oauth_query: input.query, ...(input.scope ? { scope: input.scope } : {}) } });
  return ((await answer.json()) as { url?: string }).url ?? null;
}
