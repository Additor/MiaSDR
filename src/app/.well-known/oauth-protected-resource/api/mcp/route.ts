import { connection } from "next/server";
import { apiError } from "@/app/_lib/api-errors";
import { MCP_OAUTH_SCOPES, mcpIssuerUrl, mcpOAuthAvailable, mcpResourceUrl } from "@/contexts/identity/domain/mcp-oauth";
import { env } from "@/shared/env";

/** RFC 9728: what an MCP client reads first, to find where to sign the person in. */
export async function GET() {
  await connection();
  const { APP_URL, MCP_ENABLED } = env();
  if (!mcpOAuthAvailable(APP_URL, MCP_ENABLED)) return apiError(404, "Not found");
  return Response.json(
    { resource: mcpResourceUrl(APP_URL), authorization_servers: [mcpIssuerUrl(APP_URL)], bearer_methods_supported: ["header"], scopes_supported: MCP_OAUTH_SCOPES.filter((scope) => scope !== "offline_access") },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
