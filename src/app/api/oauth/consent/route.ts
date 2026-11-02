import { headers } from "next/headers";
import { z } from "zod";
import { withActor } from "@/app/_lib/api";
import { mcpOAuthAvailable } from "@/contexts/identity/domain/mcp-oauth";
import { answerConsent, consentQueryValid, oauthClientFor } from "@/contexts/identity/infrastructure/mcp-oauth";
import { grantMcpAccess, MCP_TOKEN_ACCESS } from "@/contexts/tenancy/application/mcp-tokens";
import { mcpTokenDeps } from "@/contexts/tenancy/infrastructure/mcp-composition";
import { env } from "@/shared/env";
import { ConflictError, NotFoundError, ValidationError } from "@/shared/errors";

const body = z.object({ oauthQuery: z.string().max(8000), accept: z.boolean(), organizationId: z.string(), access: z.enum(MCP_TOKEN_ACCESS).optional() });

const EXPIRED = "This request has expired. Start connecting from the app again.";

/**
 * A person answers an MCP app's request. This route is the only way to agree (`auth-endpoint-policy.ts` keeps Better
 * Auth's own consent endpoint off the list), so an agreement always comes with its `mcp_tokens` row, written first: a
 * token with no row would be refused with no way to recover. The organization must be the one the page showed, because
 * Better Auth takes the grant's organization from the session.
 */
export const POST = (request: Request) =>
  withActor(async (actor) => {
    const { APP_URL, MCP_ENABLED } = env();
    if (!mcpOAuthAvailable(APP_URL, MCP_ENABLED)) throw new NotFoundError("Not found");
    const input = body.parse(await request.json());
    if (!(await consentQueryValid(input.oauthQuery))) throw new ValidationError(EXPIRED);
    if (input.organizationId !== actor.organizationId) throw new ConflictError("The active organization changed. Reload this page and check it.", { code: "organization_changed" });
    const query = new URLSearchParams(input.oauthQuery);
    const requestHeaders = await headers();
    let scope: string | undefined;
    if (input.accept) {
      const clientId = query.get("client_id") ?? "";
      const client = await oauthClientFor(clientId, requestHeaders);
      if (!client) throw new ValidationError(EXPIRED);
      const granted = await grantMcpAccess(mcpTokenDeps(), actor, { clientId, clientName: client.client_name ?? clientId, access: input.access ?? "read" });
      const requested = (query.get("scope") ?? "").split(" ");
      scope = [...granted, ...requested.filter((s) => s === "offline_access")].join(" ");
    }
    const url = await answerConsent(request, requestHeaders, { accept: input.accept, query: input.oauthQuery, scope });
    if (!url) throw new ConflictError(EXPIRED);
    return { url };
  });
